import { Hono } from "hono";

import { costTargets } from "../../shared/costs";
import { consumeCostApproval, requireIdempotencyKey } from "./cost-approval";
import type { Env, UserContext } from "./env";
import { r2Delete, r2Get, r2Head, r2List, r2Put } from "./r2-budget";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  id,
  jsonError,
  now,
  owner,
  parseJson,
  safeResponseMessage,
  storageUsage,
  wisartBase,
  wisartHeaders,
} from "./utils";

const MAX_PROMPT_CHARS = 20_000;
const MAX_EDIT_IMAGES = 16;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const GENERATION_TIMEOUT_MS = 7 * 60 * 1_000;
const OUTPUT_DOWNLOAD_TIMEOUT_MS = 60_000;

interface ImageRun {
  id: string;
  status: "queued" | "processing" | "succeeded" | "failed" | "cancelled";
  workflow_name: string | null;
  message: string | null;
  created_at: number;
  updated_at: number;
}

interface QueuedImageRun extends ImageRun {
  owner_email: string;
  form_json: string;
  files_json: string;
  cancel_requested: number;
}

interface ImageOutput {
  id: string;
  run_id: string;
  output_index: number;
  object_key: string;
  filename: string;
  media_type: string;
  bytes: number;
}

interface PendingImage {
  objectKey: string;
  filename: string;
  mediaType: string;
  bytes: number;
}

interface ImageGenerateBody {
  runId?: string;
  mode?: "generate" | "edit";
  prompt?: string;
  model?: string;
  size?: string;
  quality?: string;
  n?: number;
  uploadKeys?: string[];
}

interface ImageFields {
  mode: "generate" | "edit";
  prompt: string;
  model: string;
  size: string;
  quality: string;
  n: number;
}

function cleanFilename(value: string, fallback: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 160) || fallback;
}

function runResponse(run: ImageRun, outputs: ImageOutput[] = []) {
  return {
    jobId: run.id,
    status: run.status,
    message: run.message ?? undefined,
    workflowName: run.workflow_name ?? "中转站生图",
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    outputs: outputs.map((output) => ({
      index: output.output_index,
      filename: output.filename,
      mediaType: output.media_type,
      bytes: output.bytes,
      url: `/api/jobs/${run.id}/results/${output.output_index}`,
    })),
  };
}

export async function wakeWisartQueue(env: Env) {
  const stub = env.WISART_QUEUE.get(env.WISART_QUEUE.idFromName("global"));
  const response = await stub.fetch("https://wisart-queue.internal/wake", { method: "POST" });
  if (!response.ok) throw new Error("中转站后台队列暂时不可用");
}

async function existingRun(env: Env, ownerEmail: string, idempotencyKey: string) {
  const run = await env.DB.prepare(`SELECT id, status, workflow_name, message, created_at, updated_at
    FROM runs WHERE owner_email = ?1 AND idempotency_key = ?2`).bind(ownerEmail, idempotencyKey).first<ImageRun>();
  if (!run) return undefined;
  const outputs = await env.DB.prepare("SELECT * FROM run_outputs WHERE run_id = ?1 ORDER BY output_index")
    .bind(run.id).all<ImageOutput>();
  return runResponse(run, outputs.results);
}

async function pendingImage(env: Env, ownerEmail: string, objectKey: string) {
  const row = await env.DB.prepare(`SELECT object_key, bytes FROM storage_objects
    WHERE object_key = ?1 AND owner_email = ?2 AND category = 'pending-upload'`)
    .bind(objectKey, ownerEmail).first<{ object_key: string; bytes: number }>();
  if (!row) return undefined;
  const object = await r2Head(env, objectKey);
  if (!object) return undefined;
  if (Number(row.bytes) !== object.size) return undefined;
  return {
    objectKey,
    bytes: object.size,
    filename: String(object.customMetadata?.filename || "reference"),
    mediaType: String(object.httpMetadata?.contentType || "application/octet-stream"),
  } satisfies PendingImage;
}

async function boundedText(response: Response, maximumBytes: number) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error("中转站响应超过安全上限");
    }
    chunks.push(part.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function safeMediaUrl(value: string, base: string) {
  try {
    const url = new URL(value, base);
    const hostname = url.hostname.toLowerCase();
    const blockedIpv4 = /^(?:0|10|127|169\.254|192\.168)\./.test(hostname)
      || /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname);
    if (url.protocol !== "https:" || url.username || url.password || blockedIpv4
      || hostname === "localhost" || hostname === "::1" || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

async function fetchMedia(value: string, base: string) {
  let url = safeMediaUrl(value, `${base}/`);
  if (!url) throw new Error("中转站返回了不安全的图片地址");
  const deadline = Date.now() + OUTPUT_DOWNLOAD_TIMEOUT_MS;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("中转站图片下载超时");
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(remaining) });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("中转站图片重定向缺少目标地址");
    const next = safeMediaUrl(location, url.href);
    if (!next) throw new Error("中转站图片重定向到了不安全地址");
    url = next;
  }
  throw new Error("中转站图片重定向次数过多");
}

function limitedStream(body: ReadableStream<Uint8Array>, maximumBytes: number) {
  const reader = body.getReader();
  let total = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await reader.read();
        if (part.done) {
          controller.close();
          return;
        }
        total += part.value.byteLength;
        if (total > maximumBytes) {
          await reader.cancel();
          controller.error(new Error("中转站图片超过 25 MB"));
          return;
        }
        controller.enqueue(part.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
}

function imageExtension(mediaType: string) {
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/webp") return "webp";
  return "png";
}

async function multipartBody(env: Env, images: PendingImage[], fields: Record<string, string>, boundary: string) {
  const encoder = new TextEncoder();
  async function* parts() {
    for (const [name, value] of Object.entries(fields)) {
      yield encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    }
    for (const image of images) {
      const object = await r2Get(env, image.objectKey);
      if (!object?.body) throw new Error(`参考图不存在：${image.filename}`);
      yield encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${cleanFilename(image.filename, "reference")}"\r\nContent-Type: ${image.mediaType}\r\n\r\n`);
      const reader = object.body.getReader();
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        yield part.value;
      }
      yield encoder.encode("\r\n");
    }
    yield encoder.encode(`--${boundary}--\r\n`);
  }
  const iterator = parts()[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const part = await iterator.next();
        if (part.done) controller.close();
        else controller.enqueue(part.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

async function storeUrlOutput(
  env: Env,
  ownerEmail: string,
  runId: string,
  index: number,
  url: string,
  usedBytes: number,
  reservedBytes: number,
) {
  const response = await fetchMedia(url, wisartBase(env));
  if (!response.ok || !response.body) throw new Error(await safeResponseMessage(response, "中转站图片下载失败"));
  const mediaType = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(mediaType)) {
    await response.body.cancel();
    throw new Error("中转站返回的内容不是 PNG、JPEG 或 WebP 图片");
  }
  const contentLength = Number(response.headers.get("content-length") || "0");
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    await response.body.cancel();
    throw new Error("中转站图片没有提供可信大小，已停止转存");
  }
  if (contentLength > MAX_IMAGE_BYTES) {
    await response.body.cancel();
    throw new Error("中转站图片超过 25 MB");
  }
  if (usedBytes + reservedBytes + contentLength >= Number(env.STORAGE_STOP_BYTES)) {
    await response.body.cancel();
    throw new Error("生成结果将超过 R2 免费套餐保护线");
  }
  const filename = `wisart-${index + 1}.${imageExtension(mediaType)}`;
  const objectKey = `runs/${runId}/outputs/${index}-${filename}`;
  let stored: R2Object;
  try {
    stored = await r2Put(env, objectKey, limitedStream(response.body, MAX_IMAGE_BYTES), {
      httpMetadata: { contentType: mediaType, contentDisposition: `inline; filename="${filename}"` },
      customMetadata: { runId, ownerEmail },
    });
  } catch (error) {
    await r2Delete(env, objectKey).catch(() => undefined);
    throw error;
  }
  return { objectKey, filename, mediaType, bytes: stored.size };
}

async function storeB64Output(
  env: Env,
  ownerEmail: string,
  runId: string,
  index: number,
  value: string,
  usedBytes: number,
  reservedBytes: number,
) {
  const comma = value.indexOf(",");
  const encoded = comma >= 0 ? value.slice(comma + 1) : value;
  const header = comma >= 0 ? value.slice(0, comma) : "";
  const mediaType = (header.match(/^data:([^;]+);base64$/i)?.[1] || "image/png").toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.has(mediaType)) throw new Error("中转站返回的 Base64 不是支持的图片格式");
  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new Error("中转站返回的 Base64 图片无法解码");
  }
  if (binary.length > MAX_IMAGE_BYTES) throw new Error("中转站图片超过 25 MB");
  if (usedBytes + reservedBytes + binary.length >= Number(env.STORAGE_STOP_BYTES)) {
    throw new Error("生成结果将超过 R2 免费套餐保护线");
  }
  const filename = `wisart-${index + 1}.${imageExtension(mediaType)}`;
  const objectKey = `runs/${runId}/outputs/${index}-${filename}`;
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const stored = await r2Put(env, objectKey, bytes, {
    httpMetadata: { contentType: mediaType, contentDisposition: `inline; filename="${filename}"` },
    customMetadata: { runId, ownerEmail },
  });
  return { objectKey, filename, mediaType, bytes: stored.size };
}

async function cleanupInputs(env: Env, ownerEmail: string, keys: string[]) {
  if (!keys.length) return;
  await r2Delete(env, keys);
  await env.DB.batch(keys.map((key) => env.DB.prepare(
    "DELETE FROM storage_objects WHERE object_key = ?1 AND owner_email = ?2 AND category = 'image-input'",
  ).bind(key, ownerEmail)));
}

async function cleanupStoredOutputs(env: Env, ownerEmail: string, outputs: ImageOutput[]) {
  if (!outputs.length) return true;
  try {
    await r2Delete(env, outputs.map((output) => output.object_key));
    return true;
  } catch {
    await env.DB.batch(outputs.map((output) => env.DB.prepare(`INSERT OR REPLACE INTO storage_objects
      (object_key, owner_email, bytes, category, created_at) VALUES (?1, ?2, ?3, 'cleanup-pending', ?4)`)
      .bind(output.object_key, ownerEmail, output.bytes, now()))).catch(() => undefined);
    return false;
  }
}

async function cleanupUnknownOutputs(env: Env, ownerEmail: string, runId: string) {
  let objects: R2Object[] = [];
  try {
    const listed = await r2List(env, { prefix: `runs/${runId}/outputs/` });
    objects = listed.objects;
    if (!objects.length) return true;
    await r2Delete(env, objects.map((object) => object.key));
    await env.DB.batch(objects.map((object) => env.DB.prepare(
      "DELETE FROM storage_objects WHERE object_key = ?1 AND owner_email = ?2",
    ).bind(object.key, ownerEmail)));
    return true;
  } catch {
    if (objects.length) {
      await env.DB.batch(objects.map((object) => env.DB.prepare(`INSERT OR REPLACE INTO storage_objects
        (object_key, owner_email, bytes, category, created_at) VALUES (?1, ?2, ?3, 'cleanup-pending', ?4)`)
        .bind(object.key, ownerEmail, object.size, now()))).catch(() => undefined);
    }
    return false;
  }
}

async function executeImageRun(env: Env, run: QueuedImageRun) {
  const fields = parseJson<Partial<ImageFields>>(run.form_json, {});
  const images = parseJson<PendingImage[]>(run.files_json, []);
  const storedOutputs: ImageOutput[] = [];
  let stage: "before-submit" | "submitted" | "storing" = "before-submit";
  if (run.cancel_requested) {
    await env.DB.prepare("UPDATE runs SET status = 'cancelled', message = '任务已取消', updated_at = ?1 WHERE id = ?2 AND status = 'queued'")
      .bind(now(), run.id).run();
    try {
      await cleanupInputs(env, run.owner_email, images.map((image) => image.objectKey));
    } catch {
      await env.DB.prepare("UPDATE runs SET message = '任务已取消；参考图清理待处理', updated_at = ?1 WHERE id = ?2")
        .bind(now(), run.id).run();
    }
    return;
  }
  const claimed = await env.DB.prepare(`UPDATE runs SET status = 'processing', message = ?1, updated_at = ?2
    WHERE id = ?3 AND status = 'queued' AND cancel_requested = 0`)
    .bind("中转站正在生成图片", now(), run.id).run();
  if (Number(claimed.meta.changes ?? 0) !== 1) {
    const current = await env.DB.prepare("SELECT status, cancel_requested FROM runs WHERE id = ?1")
      .bind(run.id).first<{ status: string; cancel_requested: number }>();
    if (current?.status === "queued" && current.cancel_requested) {
      await env.DB.prepare("UPDATE runs SET status = 'cancelled', message = '任务已取消', updated_at = ?1 WHERE id = ?2 AND status = 'queued'")
        .bind(now(), run.id).run();
      await cleanupInputs(env, run.owner_email, images.map((image) => image.objectKey)).catch(() => undefined);
    }
    return;
  }
  try {
    if ((fields.mode !== "generate" && fields.mode !== "edit") || !fields.prompt || !fields.model
      || !fields.size || !fields.quality || !Number.isInteger(fields.n)) {
      throw new Error("中转站任务参数已损坏");
    }
    const requestFields = {
      prompt: fields.prompt,
      model: fields.model,
      n: String(fields.n),
      response_format: "url",
      ...(fields.size ? { size: fields.size } : {}),
      ...(fields.mode === "generate" ? { quality: fields.quality } : {}),
    };
    const boundary = `----lorachef-${id()}`;
    const request = fields.mode === "edit"
      ? {
          method: "POST",
          headers: { ...wisartHeaders(env), "content-type": `multipart/form-data; boundary=${boundary}` },
          body: await multipartBody(env, images, requestFields, boundary),
        }
      : { method: "POST", headers: { ...wisartHeaders(env), "content-type": "application/json" }, body: JSON.stringify(requestFields) };
    stage = "submitted";
    const response = await fetch(`${wisartBase(env)}/v1/images/${fields.mode === "edit" ? "edits" : "generations"}`, {
      ...request,
      signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS),
    });
    if (response.ok) stage = "storing";
    const text = await boundedText(response, MAX_RESPONSE_BYTES);
    if (!response.ok) {
      let message = text.slice(0, 1_000);
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string }; message?: string };
        message = String(parsed.error?.message || parsed.message || message);
      } catch { /* keep the bounded response text */ }
      if (response.status < 500) stage = "before-submit";
      throw new Error(`中转站生成失败：${message}`);
    }
    const payload = JSON.parse(text) as { data?: Array<{ url?: string; b64_json?: string }> };
    if (!Array.isArray(payload.data) || !payload.data.length) throw new Error("中转站没有返回图片");
    if (payload.data.length > 5) throw new Error("中转站返回图片数量超过安全上限");
    const usedBytes = await storageUsage(env, run.owner_email);
    const stopBytes = Number(env.STORAGE_STOP_BYTES);
    if (!Number.isFinite(stopBytes) || stopBytes <= 0) throw new Error("R2 保护线配置不正确");
    let reservedBytes = 0;
    for (const [index, item] of payload.data.entries()) {
      const stored = item.url
        ? await storeUrlOutput(env, run.owner_email, run.id, index, item.url, usedBytes, reservedBytes)
        : item.b64_json
          ? await storeB64Output(env, run.owner_email, run.id, index, item.b64_json, usedBytes, reservedBytes)
          : undefined;
      if (!stored) throw new Error("中转站返回了无法识别的图片数据");
      const output = {
        id: id(),
        run_id: run.id,
        output_index: index,
        object_key: stored.objectKey,
        filename: stored.filename,
        media_type: stored.mediaType,
        bytes: stored.bytes,
      } satisfies ImageOutput;
      storedOutputs.push(output);
      reservedBytes += stored.bytes;
      if (usedBytes + reservedBytes >= stopBytes) throw new Error("生成结果超过 R2 免费套餐保护线，未保存该批次");
    }
    const completedAt = now();
    await env.DB.batch([
      ...storedOutputs.map((output) => env.DB.prepare(`INSERT INTO run_outputs
        (id, run_id, output_index, object_key, filename, media_type, bytes, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
        .bind(output.id, run.id, output.output_index, output.object_key, output.filename, output.media_type, output.bytes, completedAt)),
      ...storedOutputs.map((output) => env.DB.prepare(`INSERT INTO storage_objects
        (object_key, owner_email, bytes, category, created_at) VALUES (?1, ?2, ?3, 'output', ?4)`)
        .bind(output.object_key, run.owner_email, output.bytes, completedAt)),
      env.DB.prepare("UPDATE runs SET status = 'succeeded', message = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(`已生成 ${storedOutputs.length} 张图片`, completedAt, run.id),
    ]);
    try {
      await cleanupInputs(env, run.owner_email, images.map((image) => image.objectKey));
    } catch {
      await env.DB.prepare("UPDATE runs SET message = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(`已生成 ${storedOutputs.length} 张图片；参考图清理待处理`, now(), run.id).run();
    }
  } catch (error) {
    await cleanupStoredOutputs(env, run.owner_email, storedOutputs);
    const cleaned = await cleanupUnknownOutputs(env, run.owner_email, run.id);
    const baseMessage = error instanceof Error ? error.message : "中转站生成失败";
    const stageMessage = stage === "submitted"
      ? "；提交结果不明确，需要人工核对，未自动重提"
      : stage === "storing"
        ? "；中转站已返回结果，但转存失败，未自动重提"
        : "";
    let message = `${baseMessage}${stageMessage}${cleaned ? "" : "；部分 R2 文件清理待处理"}`;
    const statements = [
      env.DB.prepare("DELETE FROM run_outputs WHERE run_id = ?1").bind(run.id),
      env.DB.prepare("UPDATE runs SET status = 'failed', message = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(message, now(), run.id),
    ];
    if (cleaned) {
      statements.unshift(env.DB.prepare("DELETE FROM storage_objects WHERE owner_email = ?1 AND object_key LIKE ?2")
        .bind(run.owner_email, `runs/${run.id}/outputs/%`));
    }
    await env.DB.batch(statements);
    try {
      await cleanupInputs(env, run.owner_email, images.map((image) => image.objectKey));
    } catch {
      message += "；参考图清理待处理";
      await env.DB.prepare("UPDATE runs SET message = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(message, now(), run.id).run();
    }
  }
}

export const wisartRoutes = new Hono<UserContext>();

wisartRoutes.get("/api/images/config", (c) => c.json({
  configured: Boolean(c.env.WISART_API_URL && c.env.WISART_API_KEY),
  defaultModel: c.env.WISART_DEFAULT_MODEL || "",
  maxReferenceImages: MAX_EDIT_IMAGES,
}));

wisartRoutes.get("/api/images/models", async (c) => {
  try {
    const base = wisartBase(c.env);
    const headers = wisartHeaders(c.env);
    let response = await fetch(`${base}/api/image-models`, { headers, signal: AbortSignal.timeout(30_000) });
    let text = await boundedText(response, 2 * 1024 * 1024);
    let payload: { models?: unknown[]; data?: unknown[] } = {};
    if (response.ok) {
      try { payload = JSON.parse(text) as typeof payload; } catch { /* fall back to OpenAI models */ }
    }
    if (!response.ok || !Array.isArray(payload.models) || !payload.models.length) {
      response = await fetch(`${base}/v1/models`, { headers, signal: AbortSignal.timeout(30_000) });
      text = await boundedText(response, 2 * 1024 * 1024);
      if (!response.ok) throw new Error(text.slice(0, 500) || "中转站模型读取失败");
      payload = JSON.parse(text) as typeof payload;
    }
    const rows = Array.isArray(payload.models) ? payload.models : Array.isArray(payload.data) ? payload.data : [];
    const models = rows.map((row) => {
      if (typeof row === "string") return { id: row, label: row };
      if (!row || typeof row !== "object") return undefined;
      const item = row as Record<string, unknown>;
      const idValue = String(item.id ?? item.value ?? "").trim();
      return idValue ? { id: idValue, label: String(item.name ?? item.label ?? idValue), pointCosts: item.point_costs } : undefined;
    }).filter((item): item is { id: string; label: string; pointCosts?: unknown } => Boolean(item));
    return c.json({ models, defaultModel: c.env.WISART_DEFAULT_MODEL || models[0]?.id || "" });
  } catch (error) {
    return jsonError(c, error instanceof Error ? error.message : "中转站模型读取失败", 502);
  }
});

wisartRoutes.post("/api/images/generate", async (c) => {
  const idempotencyKey = requireIdempotencyKey(c);
  const duplicate = await existingRun(c.env, owner(c), idempotencyKey);
  if (duplicate) return c.json(duplicate, 202);

  const body = await c.req.json<ImageGenerateBody>().catch((): ImageGenerateBody => ({}));
  const requestedRunId = String(body.runId ?? "").trim();
  if (requestedRunId && !/^[a-f0-9]{32}$/.test(requestedRunId)) return jsonError(c, "任务编号格式不正确");
  if (body.mode && body.mode !== "generate" && body.mode !== "edit") return jsonError(c, "生成模式不正确");
  const mode = body.mode === "edit" ? "edit" : "generate";
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) return jsonError(c, "提示词不能为空");
  if (prompt.length > MAX_PROMPT_CHARS) return jsonError(c, `提示词不能超过 ${MAX_PROMPT_CHARS.toLocaleString()} 个字符`, 413);
  const model = String(body.model ?? c.env.WISART_DEFAULT_MODEL ?? "").trim();
  if (!model || model.length > 200) return jsonError(c, "模型不能为空");
  const size = String(body.size ?? "auto").trim() || "auto";
  const quality = String(body.quality ?? "auto").trim() || "auto";
  if (size.length > 40 || /[\r\n\0]/.test(size)) return jsonError(c, "图片尺寸参数不正确");
  if (!new Set(["auto", "low", "medium", "high", "hd"]).has(quality)) return jsonError(c, "图片质量参数不正确");
  const n = Number(body.n ?? 1);
  if (!Number.isInteger(n) || n < 1 || n > 5) return jsonError(c, "生成张数范围为 1–5");
  const uploadKeys = Array.isArray(body.uploadKeys) ? body.uploadKeys.map(String) : [];
  if (new Set(uploadKeys).size !== uploadKeys.length) return jsonError(c, "参考图不能重复提交");
  if (mode === "generate" && uploadKeys.length) return jsonError(c, "文生图不需要参考图");
  if (mode === "edit" && (!uploadKeys.length || uploadKeys.length > MAX_EDIT_IMAGES)) return jsonError(c, `图生图需要 1–${MAX_EDIT_IMAGES} 张参考图`);

  const images: PendingImage[] = [];
  for (const key of uploadKeys) {
    const image = await pendingImage(c.env, owner(c), key);
    if (!image || !ALLOWED_IMAGE_TYPES.has(image.mediaType)) return jsonError(c, "参考图上传已失效或格式不支持");
    images.push(image);
  }
  const totalBytes = images.reduce((sum, image) => sum + image.bytes, 0);
  if (totalBytes > 80 * 1024 * 1024) return jsonError(c, "参考图总大小不能超过 80 MB", 413);
  const approval = await consumeCostApproval(c, {
    action: "wisart-image",
    target: costTargets.wisartImage(mode, model, size, quality, n),
    fileBytes: totalBytes,
    batchCount: 1,
  });
  void approval;

  const runId = requestedRunId || id();
  const timestamp = now();
  const workflowName = `中转站 · ${model}`;
  const claimed = await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO runs
      (id, owner_email, kind, status, priority, workflow_id, workflow_revision_id, workflow_name,
        form_json, files_json, idempotency_key, message, created_at, updated_at)
      VALUES (?1, ?2, 'image', 'queued', 100, 'wisart', NULL, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`)
      .bind(runId, owner(c), workflowName, JSON.stringify({ mode, prompt, model, size, quality, n }), JSON.stringify(images), idempotencyKey, "等待中转站后台任务"),
    ...images.map((image) => c.env.DB.prepare(
      "UPDATE storage_objects SET category = 'image-input' WHERE object_key = ?1 AND owner_email = ?2 AND category = 'pending-upload'",
    ).bind(image.objectKey, owner(c))),
  ]);
  const failedClaim = images.some((_, index) => Number(claimed[index + 1]?.meta.changes ?? 0) !== 1);
  if (failedClaim) {
    const claimedKeys = images.filter((_, index) => Number(claimed[index + 1]?.meta.changes ?? 0) === 1)
      .map((image) => image.objectKey);
    await c.env.DB.batch([
      c.env.DB.prepare("DELETE FROM runs WHERE id = ?1").bind(runId),
      ...claimedKeys.map((key) => c.env.DB.prepare(
        "UPDATE storage_objects SET category = 'pending-upload' WHERE object_key = ?1 AND owner_email = ?2 AND category = 'image-input'",
      ).bind(key, owner(c))),
    ]);
    return jsonError(c, "参考图已被其他任务使用，请重新选择后再次确认", 409);
  }
  try {
    await wakeWisartQueue(c.env);
  } catch (error) {
    let message = error instanceof Error ? error.message : "中转站后台队列暂时不可用";
    try {
      await cleanupInputs(c.env, owner(c), images.map((image) => image.objectKey));
    } catch {
      message += "；参考图清理待处理";
    }
    await c.env.DB.prepare("UPDATE runs SET status = 'failed', message = ?1, updated_at = ?2 WHERE id = ?3")
      .bind(message, now(), runId).run();
    return jsonError(c, message, 503);
  }
  return c.json(runResponse({
    id: runId,
    status: "queued",
    workflow_name: workflowName,
    message: "等待中转站后台任务",
    created_at: timestamp,
    updated_at: timestamp,
  }), 202);
});

wisartRoutes.get("/api/images/:runId", async (c) => {
  const runId = c.req.param("runId");
  if (!/^[a-f0-9]{32}$/.test(runId)) return jsonError(c, "任务编号格式不正确");
  const run = await c.env.DB.prepare(`SELECT id, status, workflow_name, message, created_at, updated_at
    FROM runs WHERE id = ?1 AND owner_email = ?2 AND kind = 'image'`).bind(runId, owner(c)).first<ImageRun>();
  if (!run) return jsonError(c, "图片任务不存在", 404);
  const outputs = await c.env.DB.prepare("SELECT * FROM run_outputs WHERE run_id = ?1 ORDER BY output_index").bind(runId).all<ImageOutput>();
  return c.json(runResponse(run, outputs.results));
});

export class WisartQueue implements DurableObject {
  private active = false;

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/wake") {
      return Response.json({ message: "Not found" }, { status: 404 });
    }
    await this.ctx.storage.setAlarm(Date.now() + 100);
    return Response.json({ ok: true }, { status: 202 });
  }

  async alarm() {
    if (this.active) return;
    this.active = true;
    try {
      const uncertain = await this.env.DB.prepare(`SELECT id, owner_email, status, workflow_name, message,
        form_json, files_json, cancel_requested, created_at, updated_at FROM runs
        WHERE kind = 'image' AND workflow_id = 'wisart' AND status = 'processing'
        ORDER BY created_at LIMIT 1`).first<QueuedImageRun>();
      if (uncertain) {
        const images = parseJson<PendingImage[]>(uncertain.files_json, []);
        const outputsCleaned = await cleanupUnknownOutputs(this.env, uncertain.owner_email, uncertain.id);
        let message = "中转站提交结果不明确，需要人工核对，未自动重提";
        if (!outputsCleaned) message += "；部分 R2 文件清理待处理";
        try {
          await cleanupInputs(this.env, uncertain.owner_email, images.map((image) => image.objectKey));
        } catch {
          message += "；参考图清理待处理";
        }
        await this.env.DB.prepare("UPDATE runs SET status = 'failed', message = ?1, updated_at = ?2 WHERE id = ?3 AND status = 'processing'")
          .bind(message, now(), uncertain.id).run();
      } else {
        const queued = await this.nextQueued();
        if (queued) await executeImageRun(this.env, queued);
      }
      if (await this.nextQueued()) await this.ctx.storage.setAlarm(Date.now() + 100);
    } catch (error) {
      console.error(JSON.stringify({
        message: "WisArt background queue failed",
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      this.active = false;
    }
  }

  private nextQueued() {
    return this.env.DB.prepare(`SELECT id, owner_email, status, workflow_name, message,
      form_json, files_json, cancel_requested, created_at, updated_at FROM runs
      WHERE kind = 'image' AND workflow_id = 'wisart' AND status = 'queued'
      ORDER BY priority DESC, created_at LIMIT 1`).first<QueuedImageRun>();
  }
}
