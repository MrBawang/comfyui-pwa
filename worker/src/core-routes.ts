import { Hono } from "hono";

import type { Context } from "hono";
import { costTargets } from "../../shared/costs";
import { consumeCostApproval, requireIdempotencyKey } from "./cost-approval";
import type { Env, UserContext } from "./env";
import { wakeQueue } from "./gpu-queue";
import { loadModalWorkflow } from "./modal";
import { loadProject } from "./project-store";
import { r2Delete, r2Get, r2Head, r2Put, r2Usage } from "./r2-budget";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_IMAGE_BYTES,
  id,
  jsonError,
  now,
  owner,
  parseJson,
  storageUsage,
  validId,
} from "./utils";

interface RunRow {
  id: string;
  kind: "workflow" | "character";
  status: "queued" | "processing" | "succeeded" | "failed" | "cancelled";
  workflow_id: string;
  workflow_revision_id: string | null;
  workflow_name: string | null;
  modal_job_id: string | null;
  message: string | null;
  form_json: string;
  created_at: number;
  updated_at: number;
}

interface OutputRow {
  id: string;
  run_id: string;
  output_index: number;
  object_key: string;
  filename: string;
  media_type: string;
  bytes: number;
}

interface LegacyBatch {
  id?: string;
  workflowId?: string;
  workflowRevisionId?: string;
  workflowName?: string;
  status?: string;
  analysis?: {
    status?: string;
    message?: string;
    progress?: number;
    report?: Record<string, unknown>;
  };
  createdAt?: number;
  updatedAt?: number;
}

interface LegacyCandidate {
  id?: string;
  batchId?: string;
  viewId?: string;
  viewLabel?: string;
  horizontalAngle?: number;
  verticalAngle?: number;
  zoom?: number;
  modalJobId?: string;
  workflowId?: string;
  workflowRevisionId?: string;
  reviewStatus?: string;
  quality?: Record<string, unknown>;
}

const VIEW_PRESETS = [
  { id: "front-close", label: "正面特写", description: "补充清晰面部细节", horizontalAngle: 0, verticalAngle: 0, zoom: 8, bucket: "close" },
  { id: "front-medium", label: "正面半身", description: "稳定的正面中景", horizontalAngle: 0, verticalAngle: 0, zoom: 4, bucket: "half" },
  { id: "right-front", label: "右前侧", description: "右侧四分之三视角", horizontalAngle: 45, verticalAngle: 0, zoom: 4, bucket: "half" },
  { id: "right-side", label: "右侧面", description: "标准右侧轮廓", horizontalAngle: 90, verticalAngle: 0, zoom: 4, bucket: "side" },
  { id: "left-side", label: "左侧面", description: "标准左侧轮廓", horizontalAngle: 270, verticalAngle: 0, zoom: 4, bucket: "side" },
  { id: "left-front", label: "左前侧", description: "左侧四分之三视角", horizontalAngle: 315, verticalAngle: 0, zoom: 4, bucket: "half" },
  { id: "front-wide", label: "正面远景", description: "补充全身与服装信息", horizontalAngle: 0, verticalAngle: 0, zoom: 1, bucket: "full" },
  { id: "front-high", label: "正面俯拍", description: "补充高位镜头变化", horizontalAngle: 0, verticalAngle: 60, zoom: 4, bucket: "half" },
] as const;

function cleanName(value: string) {
  return value.trim().replace(/[\r\n]/g, " ").slice(0, 100);
}

function runResponse(run: RunRow, outputs: OutputRow[] = []) {
  const fields = parseJson<Record<string, string>>(run.form_json, {});
  return {
    jobId: run.id,
    status: run.status === "queued" ? "processing" : run.status,
    message: run.status === "queued" ? run.message ?? "等待云端 GPU 队列" : run.message ?? undefined,
    resultUrl: outputs[0] ? `/api/jobs/${run.id}/results/${outputs[0].output_index}` : undefined,
    outputs: outputs.map((output) => ({
      index: output.output_index,
      filename: output.filename,
      mediaType: output.media_type,
      bytes: output.bytes,
      url: `/api/jobs/${run.id}/results/${output.output_index}`,
    })),
    workflowId: run.workflow_id,
    workflowRevisionId: run.workflow_revision_id ?? undefined,
    workflowName: run.workflow_name ?? undefined,
    workflowVariantId: fields.variantId,
  };
}

async function ownedObject(env: Env, ownerEmail: string, objectKey: string) {
  const allowed = await env.DB.prepare(
    "SELECT object_key FROM storage_objects WHERE object_key = ?1 AND owner_email = ?2",
  ).bind(objectKey, ownerEmail).first();
  if (!allowed) return undefined;
  return r2Get(env, objectKey);
}

async function pendingUpload(env: Env, ownerEmail: string, objectKey: string) {
  const tracked = await env.DB.prepare(`SELECT object_key, bytes FROM storage_objects
    WHERE object_key = ?1 AND owner_email = ?2 AND category = 'pending-upload'`)
    .bind(objectKey, ownerEmail).first<{ object_key: string; bytes: number }>();
  if (!tracked) return undefined;
  const object = await r2Head(env, objectKey);
  if (!object) return undefined;
  return {
    objectKey,
    bytes: Number(tracked.bytes),
    filename: object.customMetadata?.filename || "upload",
    mediaType: object.httpMetadata?.contentType || "application/octet-stream",
  };
}

async function deletePendingUpload(env: Env, ownerEmail: string, objectKey: string) {
  const upload = await pendingUpload(env, ownerEmail, objectKey);
  if (!upload) return;
  await r2Delete(env, objectKey);
  await env.DB.prepare("DELETE FROM storage_objects WHERE object_key = ?1 AND owner_email = ?2")
    .bind(objectKey, ownerEmail).run();
}

async function runWithOutputs(env: Env, ownerEmail: string, runId: string) {
  validId(runId);
  const run = await env.DB.prepare("SELECT * FROM runs WHERE id = ?1 AND owner_email = ?2")
    .bind(runId, ownerEmail).first<RunRow>();
  if (!run) return undefined;
  const outputs = await env.DB.prepare("SELECT * FROM run_outputs WHERE run_id = ?1 ORDER BY output_index")
    .bind(runId).all<OutputRow>();
  return { run, outputs: outputs.results };
}

export const coreRoutes = new Hono<UserContext>();

async function touchAgent(env: Env, agentId: string) {
  await env.DB.prepare(`INSERT INTO agent_presence (agent_id, last_seen_at) VALUES (?1, ?2)
    ON CONFLICT(agent_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`)
    .bind(agentId, now()).run();
}

coreRoutes.post("/api/uploads", async (c) => {
  const contentLength = Number(c.req.header("x-file-size") ?? c.req.header("content-length") ?? "");
  const mediaType = (c.req.header("content-type") ?? "").split(";")[0];
  let filename = "upload";
  try {
    filename = decodeURIComponent(c.req.header("x-file-name") ?? "upload");
  } catch {
    return jsonError(c, "上传文件名编码不正确");
  }
  if (!Number.isInteger(contentLength) || contentLength <= 0 || contentLength > MAX_IMAGE_BYTES) {
    return jsonError(c, "图片大小必须在 25 MB 以内", 413);
  }
  if (!ALLOWED_IMAGE_TYPES.has(mediaType)) return jsonError(c, "仅支持 PNG、JPEG 或 WebP 图片");
  if ((await storageUsage(c.env, owner(c))) + contentLength >= Number(c.env.STORAGE_STOP_BYTES)) {
    return jsonError(c, "上传将超过 R2 免费套餐保护线", 507);
  }
  if (!c.req.raw.body) return jsonError(c, "上传内容为空");
  const uploadId = id();
  const safeFilename = _safeLegacyFilename(filename, "upload");
  const objectKey = `uploads/${uploadId}/${safeFilename}`;
  const stored = await r2Put(c.env, objectKey, c.req.raw.body, {
    httpMetadata: { contentType: mediaType },
    customMetadata: { ownerEmail: owner(c), filename: safeFilename },
  });
  if (stored.size !== contentLength) {
    await r2Delete(c.env, objectKey);
    return jsonError(c, "上传内容长度不一致", 400);
  }
  await c.env.DB.prepare(`INSERT INTO storage_objects
    (object_key, owner_email, bytes, category, created_at) VALUES (?1, ?2, ?3, 'pending-upload', ?4)`)
    .bind(objectKey, owner(c), stored.size, now()).run();
  return c.json({ uploadKey: objectKey, filename: safeFilename, mediaType, bytes: stored.size }, 201);
});

coreRoutes.delete("/api/uploads", async (c) => {
  await deletePendingUpload(c.env, owner(c), c.req.query("key") ?? "");
  return c.json({ ok: true });
});

coreRoutes.get("/api/storage", async (c) => {
  const [usedBytes, operations] = await Promise.all([storageUsage(c.env, owner(c)), r2Usage(c.env)]);
  return c.json({
    usedBytes,
    warningBytes: Number(c.env.STORAGE_WARNING_BYTES),
    stopBytes: Number(c.env.STORAGE_STOP_BYTES),
    blocked: usedBytes >= Number(c.env.STORAGE_STOP_BYTES)
      || operations.classA >= operations.classAStop || operations.classB >= operations.classBStop,
    operations,
  });
});

coreRoutes.get("/api/agent-status", async (c) => {
  const presence = await c.env.DB.prepare(
    "SELECT agent_id, last_seen_at FROM agent_presence ORDER BY last_seen_at DESC LIMIT 1",
  ).first<{ agent_id: string; last_seen_at: number }>();
  const lastSeenAt = Number(presence?.last_seen_at ?? 0);
  return c.json({
    status: lastSeenAt && now() - lastSeenAt <= 60_000 ? "online" : "offline",
    agentId: presence?.agent_id,
    lastSeenAt: lastSeenAt || undefined,
  });
});

coreRoutes.get("/api/projects", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT id FROM projects WHERE owner_email = ?1 ORDER BY updated_at DESC",
  ).bind(owner(c)).all<{ id: string }>();
  const projects = await Promise.all(rows.results.map((row) => loadProject(c.env, owner(c), row.id)));
  return c.json({ projects, warnings: [] });
});

coreRoutes.post("/api/projects", async (c) => {
  const currentUsage = await storageUsage(c.env, owner(c));
  if (currentUsage >= Number(c.env.STORAGE_STOP_BYTES)) return jsonError(c, "R2 已达到免费套餐保护线，请先清理作品", 507);
  const body = await c.req.json<{ name?: string; triggerWord?: string; target?: string; uploadKey?: string }>();
  const name = cleanName(String(body.name ?? ""));
  const triggerWord = cleanName(String(body.triggerWord ?? ""));
  const target = String(body.target ?? "");
  const reference = await pendingUpload(c.env, owner(c), body.uploadKey ?? "");
  if (!name || !triggerWord) return jsonError(c, "请填写项目名称和触发词");
  if (!["sd15", "sdxl", "flux_rank64", "flux_rank128"].includes(target)) return jsonError(c, "训练目标不正确");
  if (!reference || !reference.mediaType.startsWith("image/")) return jsonError(c, "请上传人物参考图");

  const projectId = id();
  const timestamp = now();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO projects
      (id, owner_email, name, trigger_word, target, reference_key, reference_filename,
        reference_media_type, reference_bytes, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`)
      .bind(projectId, owner(c), name, triggerWord, target, reference.objectKey, reference.filename,
        reference.mediaType, reference.bytes, timestamp),
    c.env.DB.prepare("UPDATE storage_objects SET category = 'reference' WHERE object_key = ?1 AND owner_email = ?2")
      .bind(reference.objectKey, owner(c)),
  ]);
  return c.json(await loadProject(c.env, owner(c), projectId), 201);
});

coreRoutes.get("/api/projects/:projectId", async (c) => {
  try {
    return c.json(await loadProject(c.env, owner(c), c.req.param("projectId")));
  } catch (error) {
    return jsonError(c, error instanceof Error ? error.message : "人物项目读取失败", 404);
  }
});

coreRoutes.get("/api/projects/:projectId/reference", async (c) => {
  const project = await c.env.DB.prepare(
    "SELECT reference_key, reference_media_type, reference_filename FROM projects WHERE id = ?1 AND owner_email = ?2",
  ).bind(validId(c.req.param("projectId")), owner(c)).first<{
    reference_key: string; reference_media_type: string; reference_filename: string;
  }>();
  if (!project) return jsonError(c, "人物项目不存在", 404);
  const object = await ownedObject(c.env, owner(c), project.reference_key);
  if (!object?.body) return jsonError(c, "参考图不存在", 404);
  return new Response(object.body, {
    headers: {
      "content-type": project.reference_media_type,
      "content-disposition": `inline; filename="${project.reference_filename.replace(/[\r\n"]/g, "_")}"`,
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
});

coreRoutes.delete("/api/projects/:projectId", async (c) => {
  const projectId = validId(c.req.param("projectId"));
  const project = await c.env.DB.prepare(
    "SELECT reference_key FROM projects WHERE id = ?1 AND owner_email = ?2",
  ).bind(projectId, owner(c)).first<{ reference_key: string }>();
  if (!project) return jsonError(c, "人物项目不存在", 404);
  const active = await c.env.DB.prepare(`SELECT id FROM batches
    WHERE project_id = ?1 AND status IN ('queued', 'generating', 'analyzing') LIMIT 1`)
    .bind(projectId).first();
  if (active) return jsonError(c, "项目仍有生成或筛选任务，完成后才能删除", 409);
  await r2Delete(c.env, project.reference_key);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM projects WHERE id = ?1 AND owner_email = ?2").bind(projectId, owner(c)),
    c.env.DB.prepare("DELETE FROM storage_objects WHERE object_key = ?1 AND owner_email = ?2")
      .bind(project.reference_key, owner(c)),
    c.env.DB.prepare("DELETE FROM migration_records WHERE target_id = ?1").bind(projectId),
  ]);
  return c.json({ ok: true, preservedOutputs: true });
});

coreRoutes.post("/api/projects/:projectId/batches", async (c) => {
  const projectId = validId(c.req.param("projectId"));
  const project = await c.env.DB.prepare("SELECT * FROM projects WHERE id = ?1 AND owner_email = ?2")
    .bind(projectId, owner(c)).first<{
      reference_key: string; reference_filename: string; reference_media_type: string; reference_bytes: number;
    }>();
  if (!project) return jsonError(c, "人物项目不存在", 404);
  const idempotencyKey = requireIdempotencyKey(c);
  const existingBatch = await c.env.DB.prepare(`SELECT b.id FROM batches b
    JOIN projects p ON p.id = b.project_id WHERE p.owner_email = ?1 AND b.idempotency_key = ?2`)
    .bind(owner(c), idempotencyKey).first<{ id: string }>();
  if (existingBatch) {
    await wakeQueue(c.env);
    return c.json(await loadProject(c.env, owner(c), projectId), 202);
  }
  if ((await storageUsage(c.env, owner(c))) >= Number(c.env.STORAGE_STOP_BYTES)) {
    return jsonError(c, "R2 已达到免费套餐保护线，请先清理作品", 507);
  }
  const active = await c.env.DB.prepare(
    "SELECT id FROM batches WHERE project_id = ?1 AND status IN ('queued', 'generating', 'analyzing') LIMIT 1",
  ).bind(projectId).first();
  if (active) return jsonError(c, "当前项目已有进行中的批次", 409);
  const body = await c.req.json<{ workflowId?: string; viewIds?: string[] }>();
  const requested = Array.isArray(body.viewIds) ? [...new Set(body.viewIds)] : [];
  const views = VIEW_PRESETS.filter((view) => requested.includes(view.id));
  if (!body.workflowId || !views.length || views.length !== requested.length || views.length > 12) return jsonError(c, "请选择有效视角和工作流");
  let workflow;
  try {
    workflow = await loadModalWorkflow(c.env, owner(c), body.workflowId);
  } catch (error) {
    return jsonError(c, error instanceof Error ? error.message : "工作流读取失败", 502);
  }
  const controls = new Set(workflow.parameterInputs.map((input) => input.inputName));
  if (workflow.status !== "ready" || workflow.imageInputs.length !== 1 || !["horizontal_angle", "vertical_angle", "zoom"].every((item) => controls.has(item))) {
    return jsonError(c, "工作流需要一个图片输入和完整相机参数");
  }
  await consumeCostApproval(c, {
    action: "character-batch",
    target: costTargets.characterBatch(projectId, workflow.id),
    fileBytes: Number(project.reference_bytes),
    batchCount: views.length,
  });
  const batchId = id();
  const timestamp = now();
  const statements = [
    c.env.DB.prepare(`INSERT INTO batches
      (id, project_id, workflow_id, workflow_revision_id, workflow_name, status, analysis_status,
        idempotency_key, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, 'queued', 'idle', ?6, ?7, ?7)`)
      .bind(batchId, projectId, workflow.id, workflow.revisionId, workflow.name, idempotencyKey, timestamp),
  ];
  for (const [position, view] of views.entries()) {
    const viewId = id();
    const runId = id();
    const overrides: Record<string, number> = {
      horizontal_angle: view.horizontalAngle,
      vertical_angle: view.verticalAngle,
      zoom: view.zoom,
    };
    const formFields = Object.fromEntries([
      ["workflowId", workflow.id],
      ["workflowRevisionId", workflow.revisionId],
      ...workflow.textInputs.map((input) => [input.fieldName, input.currentValue]),
      ...workflow.parameterInputs.map((input) => [input.fieldName, String(overrides[input.inputName] ?? input.currentValue)]),
    ]);
    const files = [{
      fieldName: workflow.imageInputs[0].fieldName,
      objectKey: project.reference_key,
      filename: project.reference_filename,
      mediaType: project.reference_media_type,
    }];
    statements.push(
      c.env.DB.prepare(`INSERT INTO batch_views
        (id, batch_id, label, description, horizontal_angle, vertical_angle, zoom, bucket, position, run_id, status, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'queued', ?11, ?11)`)
        .bind(viewId, batchId, view.label, view.description, view.horizontalAngle, view.verticalAngle, view.zoom, view.bucket, position, runId, timestamp),
      c.env.DB.prepare(`INSERT INTO runs
        (id, owner_email, kind, status, priority, workflow_id, workflow_revision_id, workflow_name,
          form_json, files_json, project_id, batch_id, view_id, created_at, updated_at)
        VALUES (?1, ?2, 'character', 'queued', 10, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`)
        .bind(runId, owner(c), workflow.id, workflow.revisionId, workflow.name, JSON.stringify(formFields), JSON.stringify(files), projectId, batchId, viewId, timestamp),
    );
  }
  await c.env.DB.batch(statements);
  await wakeQueue(c.env);
  return c.json(await loadProject(c.env, owner(c), projectId), 202);
});

coreRoutes.post("/api/projects/:projectId/batches/:batchId/analysis", async (c) => {
  const projectId = validId(c.req.param("projectId"));
  const batchId = validId(c.req.param("batchId"));
  const project = await c.env.DB.prepare("SELECT id FROM projects WHERE id = ?1 AND owner_email = ?2")
    .bind(projectId, owner(c)).first();
  if (!project) return jsonError(c, "人物项目不存在", 404);
  const batch = await c.env.DB.prepare("SELECT id FROM batches WHERE id = ?1 AND project_id = ?2")
    .bind(batchId, projectId).first();
  if (!batch) return jsonError(c, "生成批次不存在", 404);
  const timestamp = now();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE candidates SET review_status = 'pending', quality_json = NULL WHERE batch_id = ?1").bind(batchId),
    c.env.DB.prepare(`UPDATE batches SET status = 'analyzing', analysis_status = 'waiting-agent',
      analysis_message = '等待 PC LoRAChef Agent', report_json = NULL, updated_at = ?1 WHERE id = ?2 AND project_id = ?3`)
      .bind(timestamp, batchId, projectId),
    c.env.DB.prepare(`INSERT INTO agent_tasks (id, project_id, batch_id, status, attempts, created_at, updated_at)
      VALUES (?1, ?2, ?3, 'waiting', 0, ?4, ?4)
      ON CONFLICT(batch_id) DO UPDATE SET status = 'waiting', lease_token = NULL, lease_expires_at = NULL,
        last_error = NULL, updated_at = excluded.updated_at`).bind(id(), projectId, batchId, timestamp),
  ]);
  return c.json(await loadProject(c.env, owner(c), projectId), 202);
});

coreRoutes.get("/api/projects/:projectId/candidates/:candidateId", async (c) => {
  const row = await c.env.DB.prepare(`SELECT c.object_key, c.media_type, c.filename
    FROM candidates c JOIN projects p ON p.id = c.project_id
    WHERE c.id = ?1 AND c.project_id = ?2 AND p.owner_email = ?3`)
    .bind(validId(c.req.param("candidateId")), validId(c.req.param("projectId")), owner(c))
    .first<{ object_key: string; media_type: string; filename: string }>();
  if (!row) return jsonError(c, "候选素材不存在", 404);
  const object = await ownedObject(c.env, owner(c), row.object_key);
  if (!object?.body) return jsonError(c, "候选素材不存在", 404);
  return new Response(object.body, { headers: {
    "content-type": row.media_type,
    "cache-control": "private, max-age=300",
    "x-content-type-options": "nosniff",
  } });
});

coreRoutes.post("/api/jobs", async (c) => {
  const used = await storageUsage(c.env, owner(c));
  if (used >= Number(c.env.STORAGE_STOP_BYTES)) return jsonError(c, "R2 已达到免费套餐保护线，请先清理作品", 507);
  const body = await c.req.json<{
    workflowId?: string;
    variantId?: string;
    fields?: Record<string, string>;
    files?: Array<{ fieldName?: string; uploadKey?: string }>;
  }>();
  const workflowId = String(body.workflowId ?? "");
  if (!workflowId) return jsonError(c, "缺少 workflowId");
  const idempotencyKey = requireIdempotencyKey(c);
  const existing = await c.env.DB.prepare("SELECT * FROM runs WHERE owner_email = ?1 AND idempotency_key = ?2")
    .bind(owner(c), idempotencyKey).first<RunRow>();
  if (existing) {
    await wakeQueue(c.env);
    return c.json(runResponse(existing), 202);
  }
  let workflow;
  try {
    workflow = await loadModalWorkflow(c.env, owner(c), workflowId);
  } catch (error) {
    return jsonError(c, error instanceof Error ? error.message : "工作流读取失败", 502);
  }
  if (workflow.status !== "ready") return jsonError(c, "工作流尚未通过云端检查", 409);
  const runId = id();
  const variant = body.variantId
    ? workflow.variants?.find((item) => item.id === body.variantId)
    : undefined;
  if (body.variantId && !variant) return jsonError(c, "工作流输入模式不存在");
  const schema = variant ?? workflow;
  const allowedFields = new Set([
    ...schema.textInputs.map((item) => item.fieldName),
    ...schema.parameterInputs.map((item) => item.fieldName),
  ]);
  const strings: Record<string, string> = { workflowId, workflowRevisionId: workflow.revisionId };
  if (variant) strings.variantId = variant.id;
  for (const [fieldName, value] of Object.entries(body.fields ?? {})) {
    if (typeof value !== "string" || value.length > 20_000) return jsonError(c, "工作流字段内容不正确");
    if (!allowedFields.has(fieldName)) return jsonError(c, `工作流不支持字段：${fieldName}`);
    strings[fieldName] = value;
  }
  if (JSON.stringify(strings).length > 64 * 1024) return jsonError(c, "工作流文本参数过大", 413);
  const files: Array<{ fieldName: string; objectKey: string; filename: string; mediaType: string }> = [];
  let totalBytes = 0;
  const uploadKeys: string[] = [];
  const submittedFiles = Array.isArray(body.files) ? body.files : [];
  const expectedImageFields = new Set(schema.imageInputs.map((item) => item.fieldName));
  const submittedImageFields = new Set<string>();
  for (const item of submittedFiles) {
    const fieldName = String(item.fieldName ?? "");
    if (!expectedImageFields.has(fieldName) || submittedImageFields.has(fieldName)) return jsonError(c, "工作流图片字段不正确");
    submittedImageFields.add(fieldName);
    const upload = await pendingUpload(c.env, owner(c), item.uploadKey ?? "");
    if (!upload || !upload.mediaType.startsWith("image/")) return jsonError(c, `${fieldName} 的上传已失效`);
    totalBytes += upload.bytes;
    if (totalBytes > 80 * 1024 * 1024) return jsonError(c, "单次运行输入不能超过 80 MB");
    uploadKeys.push(upload.objectKey);
    files.push({ fieldName, objectKey: upload.objectKey, filename: upload.filename, mediaType: upload.mediaType });
  }
  const missingImageFields = [...expectedImageFields].filter((fieldName) => !submittedImageFields.has(fieldName));
  if (missingImageFields.length) return jsonError(c, `缺少工作流图片输入：${missingImageFields.join("、")}`);
  await consumeCostApproval(c, {
    action: "workflow-run",
    target: costTargets.workflowRun(workflowId, variant?.id),
    fileBytes: totalBytes,
    batchCount: 1,
  });
  const timestamp = now();
  try {
    const statements = [c.env.DB.prepare(`INSERT INTO runs
      (id, owner_email, kind, status, priority, workflow_id, workflow_revision_id, workflow_name,
        form_json, files_json, idempotency_key, created_at, updated_at)
      VALUES (?1, ?2, 'workflow', 'queued', 100, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`)
      .bind(runId, owner(c), workflowId, workflow.revisionId, workflow.name,
        JSON.stringify(strings), JSON.stringify(files), idempotencyKey, timestamp)];
    statements.push(...uploadKeys.map((key) => c.env.DB.prepare(
      "UPDATE storage_objects SET category = 'run-input' WHERE object_key = ?1 AND owner_email = ?2 AND category = 'pending-upload'",
    ).bind(key, owner(c))));
    await c.env.DB.batch(statements);
  } catch (error) {
    const existing = await c.env.DB.prepare("SELECT * FROM runs WHERE owner_email = ?1 AND idempotency_key = ?2")
      .bind(owner(c), idempotencyKey).first<RunRow>();
    if (existing) return c.json(runResponse(existing), 202);
    throw error;
  }
  await wakeQueue(c.env);
  const run = await c.env.DB.prepare("SELECT * FROM runs WHERE id = ?1").bind(runId).first<RunRow>();
  return c.json(runResponse(run!), 202);
});

coreRoutes.get("/api/jobs", async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM runs WHERE owner_email = ?1 ORDER BY created_at DESC LIMIT 100")
    .bind(owner(c)).all<RunRow>();
  return c.json({ jobs: rows.results.map((run) => runResponse(run)) });
});

coreRoutes.get("/api/jobs/:runId", async (c) => {
  const result = await runWithOutputs(c.env, owner(c), c.req.param("runId"));
  return result ? c.json(runResponse(result.run, result.outputs)) : jsonError(c, "任务不存在", 404);
});

coreRoutes.delete("/api/jobs/:runId", async (c) => {
  const runId = validId(c.req.param("runId"));
  const run = await c.env.DB.prepare("SELECT * FROM runs WHERE id = ?1 AND owner_email = ?2")
    .bind(runId, owner(c)).first<RunRow>();
  if (!run) return jsonError(c, "任务不存在", 404);
  if (["succeeded", "failed", "cancelled"].includes(run.status)) return c.json(runResponse(run));
  await c.env.DB.prepare("UPDATE runs SET cancel_requested = 1, message = '正在取消', updated_at = ?1 WHERE id = ?2")
    .bind(now(), runId).run();
  await wakeQueue(c.env);
  return c.json({ ...runResponse(run), status: "cancelled", message: "取消请求已提交" }, 202);
});

async function outputResponse(c: Context<UserContext>, runId: string, index: number) {
  const result = await runWithOutputs(c.env, owner(c), runId);
  const output = result?.outputs.find((item) => item.output_index === index);
  if (!output) return jsonError(c, "生成结果不存在", 404);
  const object = await ownedObject(c.env, owner(c), output.object_key);
  if (!object?.body) return jsonError(c, "生成结果不存在", 404);
  return new Response(object.body, {
    headers: {
      "content-type": output.media_type,
      "content-disposition": `inline; filename="${output.filename.replace(/[\r\n"]/g, "_")}"`,
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
    },
  });
}

coreRoutes.get("/api/jobs/:runId/result", (c) => outputResponse(c, c.req.param("runId"), 0));
coreRoutes.get("/api/jobs/:runId/results/:index", (c) => outputResponse(c, c.req.param("runId"), Number(c.req.param("index"))));

coreRoutes.get("/api/gallery", async (c) => {
  const rows = await c.env.DB.prepare(`SELECT o.*, r.workflow_name, r.created_at AS run_created_at
    FROM run_outputs o JOIN runs r ON r.id = o.run_id
    WHERE r.owner_email = ?1 ORDER BY o.created_at DESC LIMIT 200`).bind(owner(c)).all<OutputRow & {
      workflow_name: string | null; run_created_at: number;
    }>();
  return c.json({ items: rows.results.map((row) => ({
    id: row.id,
    runId: row.run_id,
    filename: row.filename,
    mediaType: row.media_type,
    bytes: row.bytes,
    workflowName: row.workflow_name,
    createdAt: row.run_created_at,
    url: `/api/jobs/${row.run_id}/results/${row.output_index}`,
  })) });
});

coreRoutes.delete("/api/gallery/:outputId", async (c) => {
  const outputId = validId(c.req.param("outputId"));
  const output = await c.env.DB.prepare(`SELECT o.object_key FROM run_outputs o
    JOIN runs r ON r.id = o.run_id WHERE o.id = ?1 AND r.owner_email = ?2`)
    .bind(outputId, owner(c)).first<{ object_key: string }>();
  if (!output) return jsonError(c, "作品不存在", 404);
  await r2Delete(c.env, output.object_key);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM candidates WHERE run_output_id = ?1").bind(outputId),
    c.env.DB.prepare("DELETE FROM run_outputs WHERE id = ?1").bind(outputId),
    c.env.DB.prepare("DELETE FROM storage_objects WHERE object_key = ?1 AND owner_email = ?2")
      .bind(output.object_key, owner(c)),
  ]);
  return c.json({ ok: true });
});

coreRoutes.post("/api/migrations/legacy-projects", async (c) => {
  const body = await c.req.json<{ sourceId?: string; manifest?: Record<string, unknown>; uploadKey?: string }>();
  const sourceId = String(body.sourceId ?? "");
  if (!/^[a-f0-9]{32}$/.test(sourceId)) return jsonError(c, "旧项目编号不正确");
  const manifest = body.manifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return jsonError(c, "旧项目清单不是有效对象");
  const reference = await pendingUpload(c.env, owner(c), body.uploadKey ?? "");
  const existing = await c.env.DB.prepare(
    "SELECT target_id FROM migration_records WHERE source = 'legacy-project' AND source_id = ?1",
  ).bind(sourceId).first<{ target_id: string }>();
  if (existing) {
    if (reference) await deletePendingUpload(c.env, owner(c), reference.objectKey);
    return c.json(await loadProject(c.env, owner(c), existing.target_id));
  }
  if (!reference || !reference.mediaType.startsWith("image/")) return jsonError(c, "旧项目参考图上传已失效");
  const target = String(manifest.target ?? "");
  if (!["sd15", "sdxl", "flux_rank64", "flux_rank128"].includes(target)) return jsonError(c, "旧项目训练目标不正确");
  const projectId = id();
  const timestamp = now();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO projects
      (id, owner_email, name, trigger_word, target, reference_key, reference_filename,
        reference_media_type, reference_bytes, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`)
      .bind(projectId, owner(c), cleanName(String(manifest.name ?? "迁移项目")),
        cleanName(String(manifest.triggerWord ?? "ohwx person")), target, reference.objectKey, reference.filename,
        reference.mediaType, reference.bytes, timestamp),
    c.env.DB.prepare(`INSERT INTO migration_records (source, source_id, target_id, created_at)
      VALUES ('legacy-project', ?1, ?2, ?3)`).bind(sourceId, projectId, timestamp),
    c.env.DB.prepare("UPDATE storage_objects SET category = 'reference' WHERE object_key = ?1 AND owner_email = ?2")
      .bind(reference.objectKey, owner(c)),
  ]);
  return c.json(await loadProject(c.env, owner(c), projectId), 201);
});

function _safeLegacyFilename(value: string, fallback: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 180) || fallback;
}

coreRoutes.post("/api/migrations/legacy-projects/:projectId/candidates", async (c) => {
  const projectId = validId(c.req.param("projectId"));
  const project = await c.env.DB.prepare("SELECT id FROM projects WHERE id = ?1 AND owner_email = ?2")
    .bind(projectId, owner(c)).first();
  if (!project) return jsonError(c, "迁移目标项目不存在", 404);
  const body = await c.req.json<{
    candidate?: LegacyCandidate; batch?: LegacyBatch; uploadKey?: string;
  }>();
  const candidate = body.candidate ?? {};
  const batch = body.batch ?? {};
  const sourceCandidateId = validId(String(candidate.id ?? ""));
  const file = await pendingUpload(c.env, owner(c), body.uploadKey ?? "");
  const existing = await c.env.DB.prepare(
    "SELECT target_id FROM migration_records WHERE source = 'legacy-candidate' AND source_id = ?1",
  ).bind(sourceCandidateId).first<{ target_id: string }>();
  if (existing) {
    if (file) await deletePendingUpload(c.env, owner(c), file.objectKey);
    return c.json({ id: existing.target_id, duplicate: true });
  }
  if (!file || !file.mediaType.startsWith("image/")) return jsonError(c, "旧候选上传已失效");
  const sourceBatchId = validId(String(batch.id ?? candidate.batchId ?? ""));
  let batchMapping = await c.env.DB.prepare(
    "SELECT target_id FROM migration_records WHERE source = 'legacy-batch' AND source_id = ?1",
  ).bind(sourceBatchId).first<{ target_id: string }>();
  if (!batchMapping) {
    const batchId = id();
    const timestamp = now();
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO batches
        (id, project_id, workflow_id, workflow_revision_id, workflow_name, status,
          analysis_status, analysis_message, analysis_progress, report_json, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`)
        .bind(batchId, projectId, String(batch.workflowId ?? "legacy"), String(batch.workflowRevisionId ?? "legacy"),
          cleanName(String(batch.workflowName ?? "旧工作流")), ["succeeded", "partial", "failed"].includes(batch.status ?? "") ? batch.status : "succeeded",
          String(batch.analysis?.status ?? "succeeded"), batch.analysis?.message ?? "由本机项目迁移",
          Number(batch.analysis?.progress ?? 100), JSON.stringify(batch.analysis?.report ?? null),
          Number(batch.createdAt ?? timestamp), Number(batch.updatedAt ?? timestamp)),
      c.env.DB.prepare(`INSERT INTO migration_records (source, source_id, target_id, created_at)
        VALUES ('legacy-batch', ?1, ?2, ?3)`).bind(sourceBatchId, batchId, timestamp),
    ]);
    batchMapping = { target_id: batchId };
  }
  const sourceViewId = validId(String(candidate.viewId ?? sourceCandidateId));
  let viewMapping = await c.env.DB.prepare(
    "SELECT target_id FROM migration_records WHERE source = 'legacy-view' AND source_id = ?1",
  ).bind(sourceViewId).first<{ target_id: string }>();
  let runId: string;
  if (!viewMapping) {
    const viewId = id();
    runId = id();
    const timestamp = now();
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO batch_views
        (id, batch_id, label, description, horizontal_angle, vertical_angle, zoom, bucket,
          position, run_id, status, message, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8,
          (SELECT COUNT(*) FROM batch_views WHERE batch_id = ?2), ?9, 'succeeded', '由本机项目迁移', ?10, ?10)`)
        .bind(viewId, batchMapping.target_id, cleanName(String(candidate.viewLabel ?? "旧候选")), "由本机项目迁移",
          Number(candidate.horizontalAngle ?? 0), Number(candidate.verticalAngle ?? 0), Number(candidate.zoom ?? 4),
          String(candidate.quality?.bucket ?? "half"), runId, timestamp),
      c.env.DB.prepare(`INSERT INTO runs
        (id, owner_email, kind, status, workflow_id, workflow_revision_id, workflow_name,
          form_json, files_json, project_id, batch_id, view_id, modal_job_id, message, created_at, updated_at)
        VALUES (?1, ?2, 'character', 'succeeded', ?3, ?4, ?5, '{}', '[]', ?6, ?7, ?8, ?9, '由本机项目迁移', ?10, ?10)`)
        .bind(runId, owner(c), String(candidate.workflowId ?? batch.workflowId ?? "legacy"),
          String(candidate.workflowRevisionId ?? batch.workflowRevisionId ?? "legacy"),
          cleanName(String(batch.workflowName ?? "旧工作流")), projectId, batchMapping.target_id, viewId,
          candidate.modalJobId ?? null, timestamp),
      c.env.DB.prepare(`INSERT INTO migration_records (source, source_id, target_id, created_at)
        VALUES ('legacy-view', ?1, ?2, ?3)`).bind(sourceViewId, viewId, timestamp),
    ]);
    viewMapping = { target_id: viewId };
  } else {
    const view = await c.env.DB.prepare("SELECT run_id FROM batch_views WHERE id = ?1")
      .bind(viewMapping.target_id).first<{ run_id: string }>();
    if (!view?.run_id) return jsonError(c, "旧候选视角映射损坏", 409);
    runId = view.run_id;
  }
  const outputIndex = Number((await c.env.DB.prepare("SELECT COUNT(*) count FROM run_outputs WHERE run_id = ?1")
    .bind(runId).first<{ count: number }>())?.count ?? 0);
  const outputId = id();
  const candidateId = id();
  const timestamp = now();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO run_outputs
      (id, run_id, output_index, object_key, filename, media_type, bytes, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`)
      .bind(outputId, runId, outputIndex, file.objectKey, file.filename, file.mediaType, file.bytes, timestamp),
    c.env.DB.prepare(`INSERT INTO candidates
      (id, project_id, batch_id, view_id, run_output_id, object_key, filename, media_type,
        bytes, review_status, quality_json, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`)
      .bind(candidateId, projectId, batchMapping.target_id, viewMapping.target_id, outputId, file.objectKey,
        file.filename, file.mediaType, file.bytes, ["accepted", "rejected", "pending"].includes(candidate.reviewStatus ?? "")
          ? candidate.reviewStatus : "pending", JSON.stringify(candidate.quality ?? null), timestamp),
    c.env.DB.prepare(`INSERT INTO migration_records (source, source_id, target_id, created_at)
      VALUES ('legacy-candidate', ?1, ?2, ?3)`).bind(sourceCandidateId, candidateId, timestamp),
    c.env.DB.prepare("UPDATE storage_objects SET category = 'legacy-output' WHERE object_key = ?1 AND owner_email = ?2")
      .bind(file.objectKey, owner(c)),
  ]);
  return c.json({ id: candidateId, duplicate: false }, 201);
});

coreRoutes.post("/api/agent/v1/tasks/claim", async (c) => {
  const body = await c.req.json<{ agentId?: string }>().catch(() => ({ agentId: undefined }));
  const agentId = cleanName(body.agentId ?? "pc-agent") || "pc-agent";
  await touchAgent(c.env, agentId);
  const timestamp = now();
  const leaseToken = id();
  const leaseExpiresAt = timestamp + 5 * 60 * 1_000;
  const task = await c.env.DB.prepare(`UPDATE agent_tasks SET status = 'leased', lease_token = ?1,
    lease_expires_at = ?2, agent_id = ?3, attempts = attempts + 1, updated_at = ?4
    WHERE id = (SELECT id FROM agent_tasks
      WHERE status = 'waiting' OR (status = 'leased' AND lease_expires_at < ?4)
      ORDER BY created_at LIMIT 1)
    RETURNING id, project_id, batch_id`).bind(leaseToken, leaseExpiresAt, agentId, timestamp)
    .first<{ id: string; project_id: string; batch_id: string }>();
  if (!task) return new Response(null, { status: 204 });
  const project = await c.env.DB.prepare("SELECT * FROM projects WHERE id = ?1").bind(task.project_id).first<{
    id: string; name: string; trigger_word: string; target: string;
  }>();
  const candidates = await c.env.DB.prepare("SELECT id, filename FROM candidates WHERE batch_id = ?1 ORDER BY created_at")
    .bind(task.batch_id).all<{ id: string; filename: string }>();
  return c.json({
    taskId: task.id,
    leaseToken,
    leaseExpiresAt,
    project: {
      id: project!.id,
      name: project!.name,
      triggerWord: project!.trigger_word,
      target: project!.target,
      referenceUrl: `/api/agent/v1/tasks/${task.id}/reference`,
    },
    batchId: task.batch_id,
    candidates: candidates.results.map((candidate) => ({
      id: candidate.id,
      filename: candidate.filename,
      url: `/api/agent/v1/tasks/${task.id}/candidates/${candidate.id}`,
    })),
    settings: { size: 1024, identityThreshold: 0.45, curateCrops: true, pack: true },
  });
});

async function leasedTask(env: Env, taskId: string, leaseToken: string) {
  return env.DB.prepare(`SELECT * FROM agent_tasks WHERE id = ?1 AND status = 'leased'
    AND lease_token = ?2 AND lease_expires_at > ?3`).bind(validId(taskId), leaseToken, now()).first<{
      id: string; project_id: string; batch_id: string; attempts: number; agent_id: string;
    }>();
}

async function downloadableTask(c: Context<UserContext>) {
  const leaseToken = c.req.header("x-lease-token") ?? "";
  return leasedTask(c.env, c.req.param("taskId") ?? "", leaseToken);
}

coreRoutes.post("/api/agent/v1/tasks/:taskId/heartbeat", async (c) => {
  const body = await c.req.json<{ leaseToken?: string; progress?: number; message?: string }>();
  const task = await leasedTask(c.env, c.req.param("taskId"), body.leaseToken ?? "");
  if (!task) return jsonError(c, "任务租约已失效", 409);
  await touchAgent(c.env, task.agent_id || "pc-agent");
  const expiresAt = now() + 5 * 60 * 1_000;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE agent_tasks SET lease_expires_at = ?1, updated_at = ?2 WHERE id = ?3").bind(expiresAt, now(), task.id),
    c.env.DB.prepare(`UPDATE batches SET analysis_status = 'running', analysis_progress = ?1,
      analysis_message = ?2, updated_at = ?3 WHERE id = ?4`)
      .bind(Math.max(0, Math.min(100, Number(body.progress ?? 0))), cleanName(body.message ?? "LoRAChef 筛选中"), now(), task.batch_id),
  ]);
  return c.json({ ok: true, leaseExpiresAt: expiresAt });
});

coreRoutes.get("/api/agent/v1/tasks/:taskId/reference", async (c) => {
  if (!(await downloadableTask(c))) return jsonError(c, "任务租约已失效", 409);
  const task = await c.env.DB.prepare(`SELECT p.reference_key, p.reference_media_type
    FROM agent_tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?1`)
    .bind(validId(c.req.param("taskId"))).first<{ reference_key: string; reference_media_type: string }>();
  if (!task) return jsonError(c, "任务不存在", 404);
  const object = await r2Get(c.env, task.reference_key);
  return object?.body ? new Response(object.body, { headers: { "content-type": task.reference_media_type, "x-content-type-options": "nosniff" } }) : jsonError(c, "参考图不存在", 404);
});

coreRoutes.get("/api/agent/v1/tasks/:taskId/candidates/:candidateId", async (c) => {
  if (!(await downloadableTask(c))) return jsonError(c, "任务租约已失效", 409);
  const row = await c.env.DB.prepare(`SELECT c.object_key, c.media_type FROM candidates c
    JOIN agent_tasks t ON t.batch_id = c.batch_id WHERE t.id = ?1 AND c.id = ?2`)
    .bind(validId(c.req.param("taskId")), validId(c.req.param("candidateId")))
    .first<{ object_key: string; media_type: string }>();
  if (!row) return jsonError(c, "候选素材不存在", 404);
  const object = await r2Get(c.env, row.object_key);
  return object?.body ? new Response(object.body, { headers: { "content-type": row.media_type, "x-content-type-options": "nosniff" } }) : jsonError(c, "候选素材不存在", 404);
});

coreRoutes.post("/api/agent/v1/tasks/:taskId/complete", async (c) => {
  const body = await c.req.json<{
    leaseToken?: string;
    report?: Record<string, unknown>;
    candidates?: Array<{ id: string; kept: boolean; quality?: Record<string, unknown> }>;
  }>();
  const taskId = validId(c.req.param("taskId"));
  const alreadyCompleted = await c.env.DB.prepare(`SELECT id FROM agent_tasks
    WHERE id = ?1 AND status = 'completed' AND lease_token = ?2`)
    .bind(taskId, body.leaseToken ?? "").first();
  if (alreadyCompleted) return c.json({ ok: true, duplicate: true });
  const task = await leasedTask(c.env, taskId, body.leaseToken ?? "");
  if (!task) return jsonError(c, "任务租约已失效", 409);
  if (!body.report || Array.isArray(body.report) || !Array.isArray(body.candidates)) return jsonError(c, "LoRAChef 报告不完整");
  const expected = await c.env.DB.prepare("SELECT id FROM candidates WHERE batch_id = ?1 ORDER BY id")
    .bind(task.batch_id).all<{ id: string }>();
  const candidateIds = body.candidates.map((candidate) => validId(candidate.id));
  if (
    body.candidates.some((candidate) => typeof candidate.kept !== "boolean")
    || new Set(candidateIds).size !== candidateIds.length
    || expected.results.length !== candidateIds.length
    || expected.results.some((candidate) => !candidateIds.includes(candidate.id))
  ) return jsonError(c, "LoRAChef 候选结果与任务清单不一致");
  const reportJson = JSON.stringify(body.report);
  const qualityJson = body.candidates.map((candidate) => JSON.stringify(candidate.quality ?? { kept: candidate.kept }));
  if (reportJson.length + qualityJson.reduce((total, value) => total + value.length, 0) > 512 * 1024) {
    return jsonError(c, "LoRAChef 报告不能超过 512 KB", 413);
  }
  const statements = body.candidates.map((candidate, index) => c.env.DB.prepare(`UPDATE candidates
    SET review_status = ?1, quality_json = ?2 WHERE id = ?3 AND batch_id = ?4`)
    .bind(candidate.kept ? "accepted" : "rejected", qualityJson[index], candidateIds[index], task.batch_id));
  statements.push(
    c.env.DB.prepare("UPDATE agent_tasks SET status = 'completed', lease_expires_at = NULL, updated_at = ?1 WHERE id = ?2")
      .bind(now(), task.id),
    c.env.DB.prepare(`UPDATE batches SET status = CASE WHEN EXISTS(
        SELECT 1 FROM batch_views WHERE batch_id = ?1 AND status = 'failed') THEN 'partial' ELSE 'succeeded' END,
      analysis_status = 'succeeded', analysis_progress = 100, analysis_message = 'LoRAChef 筛选完成',
      report_json = ?2, updated_at = ?3 WHERE id = ?1`).bind(task.batch_id, reportJson, now()),
  );
  await c.env.DB.batch(statements);
  return c.json({ ok: true });
});

coreRoutes.post("/api/agent/v1/tasks/:taskId/fail", async (c) => {
  const body = await c.req.json<{ leaseToken?: string; message?: string }>();
  const task = await leasedTask(c.env, c.req.param("taskId"), body.leaseToken ?? "");
  if (!task) return jsonError(c, "任务租约已失效", 409);
  const terminal = task.attempts >= 3;
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE agent_tasks SET status = ?1, lease_token = NULL, lease_expires_at = NULL,
      last_error = ?2, updated_at = ?3 WHERE id = ?4`).bind(terminal ? "failed" : "waiting", cleanName(body.message ?? "本地筛选失败"), now(), task.id),
    c.env.DB.prepare(`UPDATE batches SET analysis_status = ?1, analysis_message = ?2, updated_at = ?3 WHERE id = ?4`)
      .bind(terminal ? "failed" : "waiting-agent", terminal ? "LoRAChef 连续失败，请手动重试" : "等待 PC LoRAChef Agent 重试", now(), task.batch_id),
  ]);
  return c.json({ ok: true, requeued: !terminal });
});
