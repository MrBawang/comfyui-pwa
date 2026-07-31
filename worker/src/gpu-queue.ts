import type { Env } from "./env";
import { R2BudgetError, r2Delete, r2Get, r2Head, r2Put } from "./r2-budget";
import {
  contentTypeFilename,
  id,
  modalBase,
  modalHeaders,
  modalLlmBase,
  now,
  parseJson,
  safeResponseMessage,
  storageUsage,
} from "./utils";

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
  priority: number;
  message: string | null;
  created_at: number;
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

interface ModalChatJobRow {
  operation_id: string;
  owner_email: string;
  thread_id: string;
  user_message_id: string;
  assistant_message_id: string;
  request_json: string;
  status: "queued" | "submitting" | "warming" | "generating" | "completed" | "failed" | "needs-human" | "cancelled";
  modal_job_id: string | null;
  message: string | null;
  poll_attempts: number;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
}

interface ModalChatJob {
  jobId: string;
  status: "warming" | "generating" | "succeeded" | "failed" | "cancelled";
  message?: string;
  content?: string;
}

interface ActiveGpuLease {
  kind: "run" | "chat";
  id: string;
  modalCallId: string;
  state: string;
  lastCheckedAt: number;
  leaseExpiresAt: number;
}

class PermanentRunError extends Error {}
const ACTIVE_GPU_LEASE_KEY = "active-gpu-task";
const LEASE_RENEW_MS = 2 * 60 * 1_000;
const AMBIGUOUS_SUBMISSION_GUARD_MS = 15 * 60 * 1_000;
const OUTPUT_IMPORT_RETRY_LIMIT = 3;

function quoted(value: string) {
  return value.replace(/[\r\n"]/g, "_");
}

function bytes(value: string) {
  return new TextEncoder().encode(value);
}

function outputImportAttempts(message: string | null) {
  const match = message?.match(/生成结果转存失败，正在重试（第 (\d+)\/(\d+) 次）/);
  return match && Number(match[2]) === OUTPUT_IMPORT_RETRY_LIMIT ? Number(match[1]) : 0;
}

function permanentlyUnavailableOutput(response: Response) {
  return response.status >= 400
    && response.status < 500
    && response.status !== 408
    && response.status !== 429;
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

function modalLlmHeaders(env: Env, extra: HeadersInit = {}) {
  if (!env.MODAL_LLM_TOKEN) throw new Error("Modal Qwen3.6 令牌尚未配置");
  const headers = new Headers(extra);
  headers.set("authorization", `Bearer ${env.MODAL_LLM_TOKEN}`);
  return headers;
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

  private async nextTask() {
    return this.env.DB.prepare(`SELECT kind, id, status FROM (
      SELECT 'run' AS kind, id, status, created_at, priority,
        CASE status WHEN 'processing' THEN 0 ELSE 1 END AS phase
      FROM runs WHERE kind IN ('workflow', 'character') AND status IN ('processing', 'queued')
      UNION ALL
      SELECT 'chat' AS kind, operation_id AS id, status, created_at, 0 AS priority,
        CASE WHEN status IN ('submitting', 'warming', 'generating', 'needs-human') THEN 0 ELSE 1 END AS phase
      FROM modal_chat_jobs WHERE status IN ('queued', 'submitting', 'warming', 'generating', 'needs-human')
    ) ORDER BY phase, priority DESC, created_at LIMIT 1`)
      .first<{ kind: "run" | "chat"; id: string; status: string }>();
  }

  private setActiveLease(
    kind: ActiveGpuLease["kind"],
    idValue: string,
    modalCallId: string,
    state: string,
    leaseExpiresAt = now() + LEASE_RENEW_MS,
  ) {
    const timestamp = now();
    return this.ctx.storage.put(ACTIVE_GPU_LEASE_KEY, {
      kind,
      id: idValue,
      modalCallId,
      state,
      lastCheckedAt: timestamp,
      leaseExpiresAt,
    } satisfies ActiveGpuLease);
  }

  private async clearActiveLease(kind: ActiveGpuLease["kind"], idValue: string) {
    const lease = await this.ctx.storage.get<ActiveGpuLease>(ACTIVE_GPU_LEASE_KEY);
    if (lease?.kind === kind && lease.id === idValue) {
      await this.ctx.storage.delete(ACTIVE_GPU_LEASE_KEY);
    }
  }

  private async advance() {
    const task = await this.nextTask();
    if (!task) {
      await this.ctx.storage.delete(ACTIVE_GPU_LEASE_KEY);
      return;
    }
    if (task.kind === "chat") {
      const chat = await this.env.DB.prepare("SELECT * FROM modal_chat_jobs WHERE operation_id = ?1")
        .bind(task.id).first<ModalChatJobRow>();
      if (!chat) return;
      if (chat.status === "queued") await this.submitChat(chat);
      else await this.pollChat(chat);
      return;
    }
    const run = await this.env.DB.prepare("SELECT * FROM runs WHERE id = ?1")
      .bind(task.id).first<RunRow>();
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
        if (response.status === 429 || response.status >= 500) {
          await this.holdAmbiguousRun(run, `${message}；提交结果不明确，需要人工核对，未自动重提`);
        } else {
          await this.finish(run, "failed", message);
        }
        return;
      }
      const body = await response.json() as ModalJob;
      if (!body.jobId) throw new Error("Modal 没有返回任务编号");
      await this.env.DB.prepare(`UPDATE runs SET status = 'processing', modal_job_id = ?1,
        message = ?2, updated_at = ?3 WHERE id = ?4`)
        .bind(body.jobId, body.message ?? "已提交到 Modal", now(), run.id).run();
      await this.setActiveLease("run", run.id, body.jobId, "processing");
      if (run.view_id) {
        await this.env.DB.prepare("UPDATE batch_views SET status = 'processing', message = ?1, updated_at = ?2 WHERE id = ?3")
          .bind(body.message ?? "云端生成中", now(), run.view_id).run();
      }
      await this.schedule();
    } catch (error) {
      if (error instanceof PermanentRunError || error instanceof R2BudgetError) {
        await this.finish(run, "failed", error.message);
        return;
      }
      await this.holdAmbiguousRun(run,
        `${error instanceof Error ? error.message : "任务提交失败"}；提交结果不明确，需要人工核对，未自动重提`);
    }
  }

  private async poll(run: RunRow) {
    if (!run.modal_job_id) {
      const lease = await this.ctx.storage.get<ActiveGpuLease>(ACTIVE_GPU_LEASE_KEY);
      if (lease?.kind === "run" && lease.id === run.id && lease.state === "needs-human") {
        if (lease.leaseExpiresAt > now()) {
          await this.ctx.storage.setAlarm(lease.leaseExpiresAt + 100);
          return;
        }
        await this.finish(
          run,
          "failed",
          "提交结果不明确；15 分钟费用保护期已结束，请核对 Modal 用量后重新批准",
        );
        return;
      }
      await this.finish(run, "failed", "Modal 任务编号缺失");
      return;
    }
    try {
      await this.setActiveLease("run", run.id, run.modal_job_id, "processing");
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
        try {
          await this.importOutputs(run, job);
        } catch (error) {
          await this.handleOutputImportFailure(run, error);
          return;
        }
        await this.finish(run, "succeeded", job.message ?? "生成完成");
        return;
      }
      await this.finish(run, job.status === "cancelled" ? "cancelled" : "failed", job.message ?? "生成失败");
    } catch (error) {
      const message = error instanceof Error ? error.message : "状态查询失败";
      await this.env.DB.prepare("UPDATE runs SET message = ?1, updated_at = ?2 WHERE id = ?3")
        .bind(`${message}；稍后重试`, now(), run.id).run();
      await this.schedule(15);
    }
  }

  private async handleOutputImportFailure(run: RunRow, error: unknown) {
    if (error instanceof PermanentRunError || error instanceof R2BudgetError) {
      await this.finish(run, "failed", error.message);
      return;
    }
    const attempts = outputImportAttempts(run.message) + 1;
    const message = error instanceof Error ? error.message : "生成结果转存失败";
    if (attempts >= OUTPUT_IMPORT_RETRY_LIMIT) {
      await this.finish(run, "failed", `生成结果转存失败，已重试 ${OUTPUT_IMPORT_RETRY_LIMIT} 次：${message}`);
      return;
    }
    await this.env.DB.prepare("UPDATE runs SET message = ?1, updated_at = ?2 WHERE id = ?3")
      .bind(`生成结果转存失败，正在重试（第 ${attempts}/${OUTPUT_IMPORT_RETRY_LIMIT} 次）：${message}`, now(), run.id).run();
    await this.schedule(15);
  }

  private async submitChat(job: ModalChatJobRow) {
    await this.env.DB.batch([
      this.env.DB.prepare(`UPDATE modal_chat_jobs SET status = 'submitting',
        message = '正在提交到 Modal', updated_at = ?1 WHERE operation_id = ?2 AND status = 'queued'`)
        .bind(now(), job.operation_id),
      this.env.DB.prepare("UPDATE modal_submissions SET status = 'submitting', updated_at = ?1 WHERE id = ?2")
        .bind(now(), job.operation_id),
    ]);
    try {
      const response = await fetch(`${modalLlmBase(this.env)}/jobs`, {
        method: "POST",
        headers: modalLlmHeaders(this.env, { "content-type": "application/json" }),
        body: JSON.stringify({
          operationId: job.operation_id,
          payload: parseJson<Record<string, unknown>>(job.request_json, {}),
        }),
      });
      if (!response.ok) {
        const message = await safeResponseMessage(response, "Modal 对话任务提交失败");
        await this.finishChat(job, response.status >= 500 ? "needs-human" : "failed",
          response.status >= 500 ? `${message}；提交结果不明确，未自动重提` : message);
        return;
      }
      const body = await response.json() as ModalChatJob;
      if (!body.jobId) throw new Error("Modal 没有返回对话任务编号");
      const timestamp = now();
      await this.env.DB.prepare(`UPDATE modal_chat_jobs SET status = 'warming', modal_job_id = ?1,
        message = ?2, poll_attempts = 0, lease_expires_at = ?3, updated_at = ?4
        WHERE operation_id = ?5 AND status = 'submitting'`)
        .bind(body.jobId, body.message ?? "正在启动 GPU", timestamp + LEASE_RENEW_MS, timestamp, job.operation_id).run();
      await this.setActiveLease("chat", job.operation_id, body.jobId, "warming");
      await this.schedule(2);
    } catch (error) {
      await this.finishChat(job, "needs-human",
        `${error instanceof Error ? error.message : "Modal 对话任务提交失败"}；提交结果不明确，未自动重提`);
    }
  }

  private async holdAmbiguousRun(run: RunRow, message: string) {
    const timestamp = now();
    const guardUntil = timestamp + AMBIGUOUS_SUBMISSION_GUARD_MS;
    await this.env.DB.prepare(`UPDATE runs SET status = 'processing', message = ?1,
      updated_at = ?2 WHERE id = ?3 AND status = 'queued'`)
      .bind(message, timestamp, run.id).run();
    if (run.view_id) {
      await this.env.DB.prepare(`UPDATE batch_views SET status = 'processing', message = ?1,
        updated_at = ?2 WHERE id = ?3`)
        .bind(message, timestamp, run.view_id).run();
    }
    await this.setActiveLease("run", run.id, "unknown", "needs-human", guardUntil);
    await this.ctx.storage.setAlarm(guardUntil + 100);
  }

  private async pollChat(job: ModalChatJobRow) {
    if (job.status === "needs-human") {
      const guardUntil = Number(job.lease_expires_at ?? 0);
      if (guardUntil > now()) {
        await this.ctx.storage.setAlarm(guardUntil + 100);
        return;
      }
      const timestamp = now();
      const message = "提交结果不明确；15 分钟费用保护期已结束，请核对 Modal 用量后重新批准";
      await this.env.DB.batch([
        this.env.DB.prepare(`UPDATE modal_chat_jobs SET status = 'failed', message = ?1,
          lease_expires_at = NULL, updated_at = ?2 WHERE operation_id = ?3 AND status = 'needs-human'`)
          .bind(message, timestamp, job.operation_id),
        this.env.DB.prepare(`UPDATE modal_submissions SET status = 'rejected', message = ?1,
          updated_at = ?2 WHERE id = ?3 AND status = 'needs-human'`)
          .bind(message, timestamp, job.operation_id),
      ]);
      await this.clearActiveLease("chat", job.operation_id);
      await this.scheduleNext();
      return;
    }
    if (!job.modal_job_id) {
      await this.finishChat(job, "needs-human", "Modal 对话任务编号缺失；未自动重提");
      return;
    }
    try {
      await this.setActiveLease("chat", job.operation_id, job.modal_job_id, job.status);
      const response = await fetch(
        `${modalLlmBase(this.env)}/jobs/${encodeURIComponent(job.modal_job_id)}`,
        { headers: modalLlmHeaders(this.env) },
      );
      if (!response.ok && response.status !== 202) {
        if (response.status === 404) {
          await this.finishChat(job, "needs-human", "Modal 对话任务不存在或已经过期；未自动重提");
          return;
        }
        await this.deferChatPoll(job, await safeResponseMessage(response, "状态查询失败"));
        return;
      }
      const result = await response.json() as ModalChatJob;
      if (response.status === 202 || result.status === "warming" || result.status === "generating") {
        const status = result.status === "generating" ? "generating" : "warming";
        const timestamp = now();
        await this.env.DB.prepare(`UPDATE modal_chat_jobs SET status = ?1, message = ?2,
          poll_attempts = poll_attempts + 1, lease_expires_at = ?3, updated_at = ?4
          WHERE operation_id = ?5`)
          .bind(status, result.message ?? (status === "warming" ? "正在启动 GPU" : "正在生成回复"),
            timestamp + LEASE_RENEW_MS, timestamp, job.operation_id).run();
        await this.setActiveLease("chat", job.operation_id, job.modal_job_id, status);
        await this.schedule(Math.min(15, Math.max(2, 2 + job.poll_attempts * 2)));
        return;
      }
      if (result.status === "succeeded" && result.content?.trim()) {
        await this.completeChat(job, result.content);
        return;
      }
      await this.finishChat(job, result.status === "cancelled" ? "cancelled" : "failed",
        result.message ?? "Modal 对话生成失败");
    } catch (error) {
      await this.deferChatPoll(job, error instanceof Error ? error.message : "状态查询失败");
    }
  }

  private async deferChatPoll(job: ModalChatJobRow, message: string) {
    const timestamp = now();
    await this.env.DB.prepare(`UPDATE modal_chat_jobs SET message = ?1, poll_attempts = poll_attempts + 1,
      lease_expires_at = ?2, updated_at = ?3 WHERE operation_id = ?4`)
      .bind(`${message}；仅重试状态查询，不会重新生成`, timestamp + LEASE_RENEW_MS, timestamp, job.operation_id).run();
    if (job.modal_job_id) await this.setActiveLease("chat", job.operation_id, job.modal_job_id, job.status);
    await this.schedule(15);
  }

  private async completeChat(job: ModalChatJobRow, content: string) {
    const timestamp = now();
    await this.env.DB.batch([
      this.env.DB.prepare(`INSERT OR IGNORE INTO chat_messages
        (id, thread_id, role, content, provider_id, created_at)
        VALUES (?1, ?2, 'assistant', ?3, 'modal-qwen36', ?4)`)
        .bind(job.assistant_message_id, job.thread_id, content, timestamp),
      this.env.DB.prepare("UPDATE chat_threads SET updated_at = ?1 WHERE id = ?2")
        .bind(timestamp, job.thread_id),
      this.env.DB.prepare(`UPDATE modal_chat_jobs SET status = 'completed', message = '回复生成完成',
        lease_expires_at = NULL, updated_at = ?1 WHERE operation_id = ?2`)
        .bind(timestamp, job.operation_id),
      this.env.DB.prepare(`UPDATE modal_submissions SET status = 'completed', response_status = 200,
        response_content_type = 'application/json', response_body = ?1, message = NULL, updated_at = ?2
        WHERE id = ?3`)
        .bind(JSON.stringify({ messageId: job.assistant_message_id }), timestamp, job.operation_id),
    ]);
    await this.clearActiveLease("chat", job.operation_id);
    await this.scheduleNext();
  }

  private async finishChat(
    job: ModalChatJobRow,
    status: "failed" | "needs-human" | "cancelled",
    message: string,
  ) {
    const timestamp = now();
    const submissionStatus = status === "failed" || status === "cancelled" ? "rejected" : "needs-human";
    const guardUntil = status === "needs-human" ? timestamp + AMBIGUOUS_SUBMISSION_GUARD_MS : null;
    await this.env.DB.batch([
      this.env.DB.prepare(`UPDATE modal_chat_jobs SET status = ?1, message = ?2,
        lease_expires_at = ?3, updated_at = ?4 WHERE operation_id = ?5`)
        .bind(status, message, guardUntil, timestamp, job.operation_id),
      this.env.DB.prepare("UPDATE modal_submissions SET status = ?1, message = ?2, updated_at = ?3 WHERE id = ?4")
        .bind(submissionStatus, message, timestamp, job.operation_id),
    ]);
    if (status === "needs-human") {
      await this.setActiveLease("chat", job.operation_id, job.modal_job_id ?? "unknown", status, guardUntil!);
      await this.ctx.storage.setAlarm(guardUntil! + 100);
    } else {
      await this.clearActiveLease("chat", job.operation_id);
      await this.scheduleNext();
    }
  }

  private async scheduleNext() {
    if (await this.nextTask()) await this.ctx.storage.setAlarm(Date.now() + 100);
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
      if (!response.ok || !response.body) {
        const message = await safeResponseMessage(response, "生成结果下载失败");
        if (permanentlyUnavailableOutput(response)) throw new PermanentRunError(message);
        throw new Error(message);
      }
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
    await this.clearActiveLease("run", run.id);
    await this.scheduleNext();
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
