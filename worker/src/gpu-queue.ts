import type { Env } from "./env";
import { r2Delete, r2Get, r2Head, r2Put } from "./r2-budget";
import { contentTypeFilename, id, modalBase, modalHeaders, now, parseJson, safeResponseMessage, storageUsage } from "./utils";

interface RunRow {
  id: string;
  owner_email: string;
  kind: "workflow" | "character";
  status: string;
  workflow_id: string;
  workflow_revision_id: string | null;
  workflow_name: string | null;
  form_json: string;
  files_json: string;
  project_id: string | null;
  batch_id: string | null;
  view_id: string | null;
  modal_job_id: string | null;
  cancel_requested: number;
}

interface StoredFile {
  fieldName: string;
  objectKey: string;
  filename: string;
  mediaType: string;
}

interface ModalJob {
  jobId: string;
  status: "uploading" | "processing" | "succeeded" | "failed" | "cancelled";
  message?: string;
  outputs?: Array<{ index: number; filename: string; mediaType: string; bytes: number }>;
}

interface ModalLlmLease {
  id: string;
  expiresAt: number;
}

class PermanentRunError extends Error {}
const LLM_LEASE_KEY = "modal-llm-lease";
const LLM_LEASE_MS = 15 * 60 * 1_000;

function quoted(value: string) {
  return value.replace(/[\r\n"]/g, "_");
}

function bytes(value: string) {
  return new TextEncoder().encode(value);
}

async function multipartStream(env: Env, fields: Record<string, string>, files: StoredFile[], boundary: string) {
  async function* chunks() {
    for (const [fieldName, value] of Object.entries(fields)) {
      yield bytes(`--${boundary}\r\nContent-Disposition: form-data; name="${quoted(fieldName)}"\r\n\r\n${value}\r\n`);
    }
    for (const file of files) {
      const object = await r2Get(env, file.objectKey);
      if (!object?.body) throw new Error(`运行输入已不存在：${file.filename}`);
      yield bytes(`--${boundary}\r\nContent-Disposition: form-data; name="${quoted(file.fieldName)}"; filename="${quoted(file.filename)}"\r\nContent-Type: ${file.mediaType}\r\n\r\n`);
      const reader = object.body.getReader();
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        yield part.value;
      }
      yield bytes("\r\n");
    }
    yield bytes(`--${boundary}--\r\n`);
  }

  const iterator = chunks()[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

export async function wakeQueue(env: Env) {
  const stub = env.GPU_QUEUE.get(env.GPU_QUEUE.idFromName("global"));
  await stub.fetch("https://queue.internal/wake", { method: "POST" });
}

export async function acquireModalLlmLease(env: Env) {
  const leaseId = id();
  const stub = env.GPU_QUEUE.get(env.GPU_QUEUE.idFromName("global"));
  const response = await stub.fetch("https://queue.internal/llm/acquire", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ leaseId }),
  });
  if (!response.ok) {
    throw new Error(response.status === 409
      ? "Modal GPU 正在运行其他任务，请稍后重试；模型不会自动切换"
      : "Modal GPU 队列暂时不可用");
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    await stub.fetch("https://queue.internal/llm/release", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ leaseId }),
    });
  };
}

export function pinnedWorkflowFields(run: Pick<RunRow, "workflow_id" | "workflow_revision_id" | "form_json">) {
  const fields = parseJson<Record<string, string>>(run.form_json, {});
  fields.workflowId = run.workflow_id;
  if (run.workflow_revision_id) fields.workflowRevisionId = run.workflow_revision_id;
  else delete fields.workflowRevisionId;
  return fields;
}

export class GpuQueue implements DurableObject {
  private processing = false;

  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {}

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/wake") {
      await this.ctx.storage.setAlarm(Date.now() + 100);
      return Response.json({ ok: true }, { status: 202 });
    }
    if (request.method === "POST" && url.pathname === "/llm/acquire") {
      const body = await request.json().catch(() => ({})) as { leaseId?: string };
      if (!body.leaseId || !/^[a-f0-9]{32}$/.test(body.leaseId)) {
        return Response.json({ message: "Invalid lease" }, { status: 400 });
      }
      const existing = await this.activeLlmLease();
      if (existing || this.processing) return Response.json({ message: "GPU busy" }, { status: 409 });
      const lease = { id: body.leaseId, expiresAt: Date.now() + LLM_LEASE_MS };
      await this.ctx.storage.put(LLM_LEASE_KEY, lease);
      if (await this.nextRun()) {
        await this.ctx.storage.delete(LLM_LEASE_KEY);
        return Response.json({ message: "GPU busy" }, { status: 409 });
      }
      return Response.json({ ok: true, expiresAt: lease.expiresAt }, { status: 201 });
    }
    if (request.method === "POST" && url.pathname === "/llm/release") {
      const body = await request.json().catch(() => ({})) as { leaseId?: string };
      const existing = await this.activeLlmLease();
      if (existing?.id === body.leaseId) {
        await this.ctx.storage.delete(LLM_LEASE_KEY);
        if (await this.nextRun()) await this.ctx.storage.setAlarm(Date.now() + 100);
      }
      return Response.json({ ok: true });
    }
    return Response.json({ message: "Not found" }, { status: 404 });
  }

  async alarm() {
    if (this.processing) return;
    this.processing = true;
    try {
      await this.advance();
    } finally {
      this.processing = false;
    }
  }

  private async nextRun() {
    return this.env.DB.prepare(`SELECT * FROM runs
      WHERE kind IN ('workflow', 'character') AND (status = 'processing' OR status = 'queued')
      ORDER BY CASE status WHEN 'processing' THEN 0 ELSE 1 END, priority DESC, created_at
      LIMIT 1`).first<RunRow>();
  }

  private async activeLlmLease() {
    const lease = await this.ctx.storage.get<ModalLlmLease>(LLM_LEASE_KEY);
    if (!lease) return undefined;
    if (lease.expiresAt > Date.now()) return lease;
    await this.ctx.storage.delete(LLM_LEASE_KEY);
    return undefined;
  }

  private async advance() {
    const lease = await this.activeLlmLease();
    if (lease) {
      await this.ctx.storage.setAlarm(lease.expiresAt + 100);
      return;
    }
    const run = await this.nextRun();
    if (!run) return;
    if (run.status === "queued") await this.submit(run);
    else await this.poll(run);
  }

  private schedule(seconds?: number) {
    const configured = Number(this.env.MODAL_POLL_SECONDS || "8");
    const delay = Math.max(2, seconds ?? configured) * 1_000;
    return this.ctx.storage.setAlarm(Date.now() + delay);
  }

  private async submit(run: RunRow) {
    if (run.cancel_requested) {
      await this.finish(run, "cancelled", "任务已取消");
      return;
    }
    try {
      const boundary = `lorachef-${crypto.randomUUID()}`;
      const stream = await multipartStream(
        this.env,
        pinnedWorkflowFields(run),
        parseJson<StoredFile[]>(run.files_json, []),
        boundary,
      );
      const response = await fetch(`${modalBase(this.env)}/jobs`, {
        method: "POST",
        headers: modalHeaders(this.env, { "content-type": `multipart/form-data; boundary=${boundary}` }),
        body: stream,
      });
      if (!response.ok) {
        const message = await safeResponseMessage(response, "Modal 任务提交失败");
        const suffix = response.status === 429 || response.status >= 500
          ? "；提交结果不明确，需要人工核对，未自动重提"
          : "";
        await this.finish(run, "failed", `${message}${suffix}`);
        return;
      }
      const body = await response.json() as ModalJob;
      if (!body.jobId) throw new Error("Modal 没有返回任务编号");
      await this.env.DB.prepare(`UPDATE runs SET status = 'processing', modal_job_id = ?1,
        message = ?2, updated_at = ?3 WHERE id = ?4`)
        .bind(body.jobId, body.message ?? "已提交到 Modal", now(), run.id).run();
      if (run.view_id) {
        await this.env.DB.prepare("UPDATE batch_views SET status = 'processing', message = ?1, updated_at = ?2 WHERE id = ?3")
          .bind(body.message ?? "云端生成中", now(), run.view_id).run();
      }
      await this.schedule();
    } catch (error) {
      if (error instanceof PermanentRunError) {
        await this.finish(run, "failed", error.message);
        return;
      }
      await this.finish(run, "failed",
        `${error instanceof Error ? error.message : "任务提交失败"}；提交结果不明确，需要人工核对，未自动重提`);
    }
  }

  private async poll(run: RunRow) {
    if (!run.modal_job_id) {
      await this.finish(run, "failed", "Modal 任务编号缺失");
      return;
    }
    try {
      if (run.cancel_requested) {
        await fetch(`${modalBase(this.env)}/jobs/${encodeURIComponent(run.modal_job_id)}`, {
          method: "DELETE",
          headers: modalHeaders(this.env),
        });
        await this.finish(run, "cancelled", "任务已取消");
        return;
      }
      const response = await fetch(`${modalBase(this.env)}/jobs/${encodeURIComponent(run.modal_job_id)}`, {
        headers: modalHeaders(this.env),
      });
      if (!response.ok) {
        if (response.status === 404) {
          await this.finish(run, "failed", "Modal 任务不存在或已经过期");
          return;
        }
        await this.env.DB.prepare("UPDATE runs SET message = ?1, updated_at = ?2 WHERE id = ?3")
          .bind(`${await safeResponseMessage(response, "状态查询失败")}；稍后重试`, now(), run.id).run();
        await this.schedule(15);
        return;
      }
      const job = await response.json() as ModalJob;
      if (job.status === "processing" || job.status === "uploading") {
        await this.env.DB.prepare("UPDATE runs SET message = ?1, updated_at = ?2 WHERE id = ?3")
          .bind(job.message ?? "Modal 正在执行", now(), run.id).run();
        await this.schedule();
        return;
      }
      if (job.status === "succeeded") {
        await this.importOutputs(run, job);
        await this.finish(run, "succeeded", job.message ?? "生成完成");
        return;
      }
      await this.finish(run, job.status === "cancelled" ? "cancelled" : "failed", job.message ?? "生成失败");
    } catch (error) {
      if (error instanceof PermanentRunError) {
        await this.finish(run, "failed", error.message);
        return;
      }
      await this.env.DB.prepare("UPDATE runs SET message = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(`${error instanceof Error ? error.message : "状态查询失败"}；稍后重试`, now(), run.id).run();
      await this.schedule(15);
    }
  }

  private async importOutputs(run: RunRow, job: ModalJob) {
    if (!run.modal_job_id) return;
    for (const [position, output] of (job.outputs ?? []).entries()) {
      const outputIndex = Number.isInteger(output.index) ? output.index : position;
      const imported = await this.env.DB.prepare(`SELECT o.object_key FROM run_outputs o
        JOIN storage_objects s ON s.object_key = o.object_key
        WHERE o.run_id = ?1 AND o.output_index = ?2 AND s.owner_email = ?3`)
        .bind(run.id, outputIndex, run.owner_email).first<{ object_key: string }>();
      if (imported && await r2Head(this.env, imported.object_key)) continue;
      const response = await fetch(
        `${modalBase(this.env)}/jobs/${encodeURIComponent(run.modal_job_id)}/results/${outputIndex}`,
        { headers: modalHeaders(this.env) },
      );
      if (!response.ok || !response.body) throw new Error(await safeResponseMessage(response, "生成结果下载失败"));
      const mediaType = response.headers.get("content-type")?.split(";")[0] || output.mediaType || "application/octet-stream";
      const filename = contentTypeFilename(mediaType, output.filename || `output-${outputIndex}`);
      const objectKey = `runs/${run.id}/outputs/${outputIndex}-${filename.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
      const [usedBytes, existing] = await Promise.all([
        storageUsage(this.env, run.owner_email),
        this.env.DB.prepare("SELECT bytes FROM storage_objects WHERE object_key = ?1 AND owner_email = ?2")
          .bind(objectKey, run.owner_email).first<{ bytes: number }>(),
      ]);
      const stopBytes = Number(this.env.STORAGE_STOP_BYTES);
      if (!Number.isFinite(stopBytes) || stopBytes <= 0) {
        await response.body.cancel();
        throw new PermanentRunError("R2 保护线配置不正确");
      }
      const previousBytes = Number(existing?.bytes ?? 0);
      const outputBytes = Number(output.bytes);
      const contentLength = Number(response.headers.get("content-length"));
      const expectedBytes = Math.max(
        Number.isFinite(outputBytes) ? outputBytes : 0,
        Number.isFinite(contentLength) ? contentLength : 0,
      );
      if (expectedBytes <= 0) {
        await response.body.cancel();
        throw new PermanentRunError("Modal 没有提供生成结果大小，已停止转存");
      }
      if (usedBytes - previousBytes + expectedBytes >= stopBytes) {
        await response.body.cancel();
        throw new PermanentRunError("生成结果将超过 R2 免费套餐保护线，请清理作品后重新运行");
      }
      const stored = await r2Put(this.env, objectKey, response.body, {
        httpMetadata: { contentType: mediaType, contentDisposition: `inline; filename="${quoted(filename)}"` },
        customMetadata: { runId: run.id, ownerEmail: run.owner_email },
      });
      if (usedBytes - previousBytes + stored.size >= stopBytes) {
        if (!previousBytes) await r2Delete(this.env, objectKey);
        throw new PermanentRunError("生成结果超过 R2 免费套餐保护线，未保存该文件");
      }
      const outputId = id();
      await this.env.DB.batch([
        this.env.DB.prepare(`INSERT INTO run_outputs
          (id, run_id, output_index, object_key, filename, media_type, bytes, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
          ON CONFLICT(run_id, output_index) DO UPDATE SET object_key = excluded.object_key,
            filename = excluded.filename, media_type = excluded.media_type, bytes = excluded.bytes`)
          .bind(outputId, run.id, outputIndex, objectKey, filename, mediaType, stored.size, now()),
        this.env.DB.prepare(`INSERT OR REPLACE INTO storage_objects
          (object_key, owner_email, bytes, category, created_at) VALUES (?1, ?2, ?3, 'output', ?4)`)
          .bind(objectKey, run.owner_email, stored.size, now()),
      ]);
      if (run.kind === "character" && run.project_id && run.batch_id && run.view_id && mediaType.startsWith("image/")) {
        const storedOutput = await this.env.DB.prepare(
          "SELECT id FROM run_outputs WHERE run_id = ?1 AND output_index = ?2",
        ).bind(run.id, outputIndex).first<{ id: string }>();
        if (!storedOutput) throw new Error("生成结果索引保存失败");
        await this.env.DB.prepare(`INSERT OR IGNORE INTO candidates
          (id, project_id, batch_id, view_id, run_output_id, object_key, filename, media_type, bytes, review_status, created_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending', ?10)`)
          .bind(id(), run.project_id, run.batch_id, run.view_id, storedOutput.id, objectKey, filename, mediaType, stored.size, now()).run();
      }
    }
  }

  private async finish(run: RunRow, status: "succeeded" | "failed" | "cancelled", message: string) {
    const timestamp = now();
    await this.env.DB.prepare("UPDATE runs SET status = ?1, message = ?2, updated_at = ?3 WHERE id = ?4")
      .bind(status, message, timestamp, run.id).run();
    if (run.view_id && run.batch_id) {
      await this.env.DB.prepare("UPDATE batch_views SET status = ?1, message = ?2, updated_at = ?3 WHERE id = ?4")
        .bind(status === "succeeded" ? "succeeded" : "failed", message, timestamp, run.view_id).run();
      await this.refreshBatch(run.batch_id, run.project_id);
    }
    await this.cleanupInputs(run);
    const next = await this.nextRun();
    if (next) await this.ctx.storage.setAlarm(Date.now() + 100);
  }

  private async cleanupInputs(run: RunRow) {
    const files = parseJson<StoredFile[]>(run.files_json, []);
    for (const file of files) {
      const tracked = await this.env.DB.prepare(
        "SELECT object_key FROM storage_objects WHERE object_key = ?1 AND category = 'run-input'",
      ).bind(file.objectKey).first();
      if (!tracked) continue;
      await r2Delete(this.env, file.objectKey);
      await this.env.DB.prepare("DELETE FROM storage_objects WHERE object_key = ?1").bind(file.objectKey).run();
    }
  }

  private async refreshBatch(batchId: string, projectId: string | null) {
    const counts = await this.env.DB.prepare(`SELECT
      SUM(CASE WHEN status IN ('queued', 'processing') THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM batch_views WHERE batch_id = ?1`).bind(batchId).first<{ active: number; succeeded: number; failed: number }>();
    if (Number(counts?.active ?? 0) > 0) {
      await this.env.DB.prepare("UPDATE batches SET status = 'generating', updated_at = ?1 WHERE id = ?2")
        .bind(now(), batchId).run();
      return;
    }
    if (Number(counts?.succeeded ?? 0) === 0) {
      await this.env.DB.prepare(`UPDATE batches SET status = 'failed', analysis_status = 'failed',
        analysis_message = '没有可筛选的生成结果', updated_at = ?1 WHERE id = ?2`).bind(now(), batchId).run();
      return;
    }
    const taskId = id();
    await this.env.DB.batch([
      this.env.DB.prepare(`UPDATE batches SET status = 'analyzing', analysis_status = 'waiting-agent',
        analysis_message = '等待 PC LoRAChef Agent', updated_at = ?1 WHERE id = ?2`).bind(now(), batchId),
      this.env.DB.prepare(`INSERT OR IGNORE INTO agent_tasks
        (id, project_id, batch_id, status, attempts, created_at, updated_at)
        VALUES (?1, ?2, ?3, 'waiting', 0, ?4, ?4)`).bind(taskId, projectId, batchId, now()),
    ]);
  }
}
