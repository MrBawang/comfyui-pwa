import { Hono } from "hono";
import type { Context } from "hono";

import type {
  ChatMessage,
  ChatMode,
  ChatOperation,
  ChatOperationStatus,
  ChatThread,
  ProviderId,
  SystemPromptPreset,
} from "../../shared/contracts";
import { costTargets } from "../../shared/costs";
import { consumeCostApproval, CostApprovalError, requireIdempotencyKey } from "./cost-approval";
import type { UserContext } from "./env";
import { wakeQueue } from "./gpu-queue";
import { MAX_SYSTEM_PROMPT_CHARS, MAX_SYSTEM_PROMPT_TOKENS, id, jsonError, modalLlmBase, now, owner } from "./utils";

interface ThreadRow {
  id: string;
  title: string;
  mode: ChatMode;
  provider_id: ProviderId;
  workflow_id: string | null;
  workflow_revision_id: string | null;
  target_field_name: string | null;
  system_prompt_preset_id: string | null;
  system_prompt_version: number | null;
  system_prompt_override: string | null;
  created_at: number;
  updated_at: number;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: "user" | "assistant";
  content: string;
  provider_id: ProviderId | null;
  created_at: number;
}

interface PromptRow {
  id: string;
  name: string;
  scope: "chat" | "prompt" | "workflow";
  workflow_id: string | null;
  content: string;
  version: number;
  is_default: number;
  created_at: number;
  updated_at: number;
}

interface ModalChatSubmissionRow {
  id: string;
  status: "pending" | "submitting" | "completed" | "rejected" | "needs-human";
  message: string | null;
}

interface ModalChatJobRow {
  operation_id: string;
  thread_id: string;
  user_message_id: string;
  assistant_message_id: string;
  status: ChatOperationStatus;
  message: string | null;
  created_at: number;
  updated_at: number;
}

function thread(row: ThreadRow): ChatThread {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode,
    providerId: row.provider_id,
    workflowId: row.workflow_id ?? undefined,
    workflowRevisionId: row.workflow_revision_id ?? undefined,
    targetFieldName: row.target_field_name ?? undefined,
    systemPromptPresetId: row.system_prompt_preset_id ?? undefined,
    systemPromptVersion: row.system_prompt_version ?? undefined,
    systemPromptOverride: row.system_prompt_override ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function message(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    content: row.content,
    providerId: row.provider_id ?? undefined,
    createdAt: row.created_at,
  };
}

async function chatOperation(c: Context<UserContext>, row: ModalChatJobRow): Promise<ChatOperation> {
  const assistant = row.status === "completed"
    ? await c.env.DB.prepare("SELECT * FROM chat_messages WHERE id = ?1 AND thread_id = ?2")
      .bind(row.assistant_message_id, row.thread_id).first<MessageRow>()
    : undefined;
  return {
    id: row.operation_id,
    threadId: row.thread_id,
    status: row.status,
    message: row.message ?? undefined,
    assistantMessage: assistant ? message(assistant) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function preset(row: PromptRow): SystemPromptPreset {
  return {
    id: row.id,
    name: row.name,
    scope: row.scope,
    workflowId: row.workflow_id ?? undefined,
    content: row.content,
    version: row.version,
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function workersAiStop(env: UserContext["Bindings"]) {
  const value = Number(env.WORKERS_AI_STOP_NEURONS);
  if (!Number.isFinite(value) || value <= 0 || value > 10_000) throw new Error("Workers AI 保护线配置不正确");
  return value;
}

export async function reserveWorkersAi(
  env: UserContext["Bindings"],
  ownerEmail: string,
  messages: Array<{ content: string }>,
  maxTokens: number,
) {
  const inputTokens = messages.reduce((total, item) => total + estimatedTokens(item.content), 0);
  const reservedNeurons = inputTokens * 0.004625 + maxTokens * 0.030475;
  const usageDate = today();
  await env.DB.prepare(`INSERT OR IGNORE INTO ai_usage_daily
    (owner_email, usage_date, provider_id, input_tokens, output_tokens, estimated_neurons, reserved_neurons)
    VALUES (?1, ?2, 'workers-ai', 0, 0, 0, 0)`).bind(ownerEmail, usageDate).run();
  const result = await env.DB.prepare(`UPDATE ai_usage_daily
    SET reserved_neurons = reserved_neurons + ?1
    WHERE owner_email = ?2 AND usage_date = ?3 AND provider_id = 'workers-ai'
      AND estimated_neurons + reserved_neurons + ?1 <= ?4`)
    .bind(reservedNeurons, ownerEmail, usageDate, workersAiStop(env)).run();
  if (Number(result.meta.changes ?? 0) !== 1) {
    throw new Error("Workers AI 今日已达到 9,000 Neurons 保护线；不会自动切换或唤醒 Modal");
  }
  return { inputTokens, reservedNeurons, usageDate };
}

async function releaseWorkersAiReservation(
  env: UserContext["Bindings"],
  ownerEmail: string,
  reservation?: { reservedNeurons: number; usageDate: string },
) {
  if (!reservation) return;
  await env.DB.prepare(`UPDATE ai_usage_daily SET reserved_neurons = MAX(0, reserved_neurons - ?1)
    WHERE owner_email = ?2 AND usage_date = ?3 AND provider_id = 'workers-ai'`)
    .bind(reservation.reservedNeurons, ownerEmail, reservation.usageDate).run();
}

function availableProviders(c: { env: UserContext["Bindings"] }) {
  let modalAvailable = Boolean(c.env.MODAL_LLM_TOKEN);
  try {
    modalLlmBase(c.env);
  } catch {
    modalAvailable = false;
  }
  return [
    { id: "workers-ai" as const, label: "Workers AI", model: c.env.WORKERS_AI_MODEL, available: Boolean(c.env.AI) },
    { id: "modal-qwen36" as const, label: "Qwen3.6 · Modal · 64K", model: "Q6 / Q5 / Q4 · 64K", available: modalAvailable },
  ];
}

async function ownedThread(c: Context<UserContext>, threadId: string) {
  return c.env.DB.prepare("SELECT * FROM chat_threads WHERE id = ?1 AND owner_email = ?2")
    .bind(threadId, owner(c)).first<ThreadRow>();
}

async function modalChatSubmission(c: Context<UserContext>, idempotencyKey: string) {
  return c.env.DB.prepare(`SELECT id, status, message FROM modal_submissions
    WHERE owner_email = ?1 AND action = 'modal-chat' AND idempotency_key = ?2`)
    .bind(owner(c), idempotencyKey).first<ModalChatSubmissionRow>();
}

async function replayModalChat(c: Context<UserContext>, row: ModalChatSubmissionRow) {
  const job = await c.env.DB.prepare("SELECT * FROM modal_chat_jobs WHERE operation_id = ?1 AND owner_email = ?2")
    .bind(row.id, owner(c)).first<ModalChatJobRow>();
  if (job) {
    const operation = await chatOperation(c, job);
    const user = await c.env.DB.prepare("SELECT * FROM chat_messages WHERE id = ?1 AND thread_id = ?2")
      .bind(job.user_message_id, job.thread_id).first<MessageRow>();
    const active = ["queued", "submitting", "warming", "generating"].includes(operation.status);
    if (active) c.executionCtx.waitUntil(wakeQueue(c.env));
    return c.json({
      operation,
      userMessage: user ? message(user) : undefined,
      message: operation.message,
    },
      active ? 202 : operation.status === "completed" ? 200 : 409);
  }
  const detail = row.status === "needs-human"
    ? row.message || "上次 Modal 对话结果不明确，需要人工核对后重新批准"
    : row.status === "completed"
      ? "相同的 Modal 对话请求已经完成，不会再次启动 GPU"
      : row.message || "相同的 Modal 对话请求已经被拒绝";
  return c.json({ operationId: row.id, status: row.status, message: detail }, 409);
}

async function resolveSystemPrompt(c: Context<UserContext>, row: ThreadRow) {
  if (row.system_prompt_override) return row.system_prompt_override;
  if (row.system_prompt_preset_id && row.system_prompt_version) {
    const selected = await c.env.DB.prepare(`SELECT content FROM system_prompt_presets
      WHERE id = ?1 AND version = ?2 AND owner_email = ?3`)
      .bind(row.system_prompt_preset_id, row.system_prompt_version, owner(c)).first<{ content: string }>();
    if (selected) return selected.content;
  }
  if (row.workflow_id) {
    const workflow = await c.env.DB.prepare(`SELECT content FROM system_prompt_presets
      WHERE owner_email = ?1 AND scope = 'workflow' AND workflow_id = ?2 AND is_default = 1
      ORDER BY version DESC LIMIT 1`).bind(owner(c), row.workflow_id).first<{ content: string }>();
    if (workflow) return workflow.content;
  }
  const modeDefault = await c.env.DB.prepare(`SELECT content FROM system_prompt_presets
    WHERE owner_email = ?1 AND scope = ?2 AND is_default = 1 ORDER BY version DESC LIMIT 1`)
    .bind(owner(c), row.mode).first<{ content: string }>();
  if (modeDefault) return modeDefault.content;
  return row.mode === "prompt"
    ? "你是 ComfyUI 提示词工程师。保留用户意图，输出可直接写入目标工作流的单段提示词，不要添加标题、解释或 Markdown。"
    : "你是一个直接、可靠的中文助手。优先给出清晰、可执行的回答。";
}

async function defaultPromptPreset(
  c: Context<UserContext>,
  mode: ChatMode,
  workflowId?: string,
) {
  if (workflowId) {
    const workflow = await c.env.DB.prepare(`SELECT id, version FROM system_prompt_presets
      WHERE owner_email = ?1 AND scope = 'workflow' AND workflow_id = ?2 AND is_default = 1
      ORDER BY version DESC LIMIT 1`).bind(owner(c), workflowId).first<{ id: string; version: number }>();
    if (workflow) return workflow;
  }
  return c.env.DB.prepare(`SELECT id, version FROM system_prompt_presets
    WHERE owner_email = ?1 AND scope = ?2 AND is_default = 1
    ORDER BY version DESC LIMIT 1`).bind(owner(c), mode).first<{ id: string; version: number }>();
}

export const WORKERS_AI_MAX_INPUT_TOKENS = 13_500;
export const MODAL_MAX_INPUT_TOKENS = 60_000;

export function estimatedTokens(content: string) {
  let asciiCharacters = 0;
  let otherCharacters = 0;
  for (const character of content) {
    if (character.codePointAt(0)! <= 0x7f) asciiCharacters += 1;
    else otherCharacters += 1;
  }
  return Math.ceil(asciiCharacters / 4) + otherCharacters;
}

export function chatInputTokenBudget(providerId: ProviderId) {
  return providerId === "modal-qwen36" ? MODAL_MAX_INPUT_TOKENS : WORKERS_AI_MAX_INPUT_TOKENS;
}

export function fitsChatContext(system: string, content: string, maxInputTokens = WORKERS_AI_MAX_INPUT_TOKENS) {
  return estimatedTokens(system) + estimatedTokens(content) <= maxInputTokens;
}

export function systemPromptLimitError(content: string) {
  if (content.length > MAX_SYSTEM_PROMPT_CHARS) return "系统提示词不能超过 32,000 字符";
  if (estimatedTokens(content) > MAX_SYSTEM_PROMPT_TOKENS) {
    return "系统提示词不能超过约 32,000 tokens";
  }
  return undefined;
}

export function modelMessages(system: string, history: MessageRow[], maxInputTokens = WORKERS_AI_MAX_INPUT_TOKENS) {
  const limited: Array<{ role: "system" | "user" | "assistant"; content: string }> = [{ role: "system", content: system }];
  let tokens = estimatedTokens(system);
  for (const item of [...history].reverse()) {
    const itemTokens = estimatedTokens(item.content);
    if (limited.length >= 21 || tokens + itemTokens > maxInputTokens) break;
    limited.splice(1, 0, { role: item.role, content: item.content });
    tokens += itemTokens;
  }
  return limited;
}

function providerDelta(payload: string) {
  try {
    const data = JSON.parse(payload) as {
      response?: string;
      choices?: Array<{ delta?: { content?: string }; text?: string }>;
    };
    return data.response ?? data.choices?.[0]?.delta?.content ?? data.choices?.[0]?.text ?? "";
  } catch {
    return "";
  }
}

export function modalChatPayload(
  mode: ChatMode,
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
) {
  return {
    model: "qwen3.6-35b-a3b-hauhaucs",
    messages,
    stream: true,
    max_tokens: maxTokens,
    temperature: mode === "prompt" ? 0.55 : 0.7,
    chat_template_kwargs: { enable_thinking: false },
  };
}

export async function workersAiStream(
  env: UserContext["Bindings"],
  messages: Array<{ role: string; content: string }>,
  maxTokens: number,
  temperature: number,
  signal: AbortSignal,
) {
  const result = await env.AI.run(env.WORKERS_AI_MODEL, {
    messages,
    stream: true,
    max_tokens: maxTokens,
    temperature,
  }, { signal });
  if (!(result instanceof ReadableStream)) throw new Error("Workers AI 没有返回流式响应");
  return result as ReadableStream<Uint8Array>;
}

export function abortProviderOnResponseCancel(source: ReadableStream<Uint8Array>, controller: AbortController) {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(target) {
      try {
        const chunk = await reader.read();
        if (chunk.done) target.close();
        else target.enqueue(chunk.value);
      } catch (error) {
        target.error(error);
      }
    },
    async cancel(reason) {
      controller.abort(reason);
      await reader.cancel(reason).catch(() => undefined);
    },
  });
}

export async function consumeProviderStream(source: ReadableStream<Uint8Array>, onDelta: (content: string) => Promise<void>) {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        const content = providerDelta(payload);
        if (content) await onDelta(content);
      }
    }
    const tail = buffer.trim();
    if (tail.startsWith("data:")) {
      const payload = tail.slice(5).trim();
      if (payload && payload !== "[DONE]") {
        const content = providerDelta(payload);
        if (content) await onDelta(content);
      }
    }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  }
}

export const chatRoutes = new Hono<UserContext>();

chatRoutes.get("/api/chat/providers", async (c) => {
  const usage = await c.env.DB.prepare(`SELECT input_tokens, output_tokens, estimated_neurons, reserved_neurons
    FROM ai_usage_daily WHERE owner_email = ?1 AND usage_date = ?2 AND provider_id = 'workers-ai'`)
    .bind(owner(c), today()).first<{
      input_tokens: number; output_tokens: number; estimated_neurons: number; reserved_neurons: number;
    }>();
  return c.json({ providers: availableProviders(c), workersAi: {
    estimatedNeurons: Number(usage?.estimated_neurons ?? 0),
    reservedNeurons: Number(usage?.reserved_neurons ?? 0),
    freeNeurons: 10_000,
    stopNeurons: workersAiStop(c.env),
    blocked: Number(usage?.estimated_neurons ?? 0) + Number(usage?.reserved_neurons ?? 0) >= workersAiStop(c.env),
    warning: Number(usage?.estimated_neurons ?? 0) + Number(usage?.reserved_neurons ?? 0) >= workersAiStop(c.env),
  } });
});

chatRoutes.get("/api/system-prompts", async (c) => {
  const rows = await c.env.DB.prepare(`SELECT p.* FROM system_prompt_presets p
    JOIN (SELECT id, MAX(version) version FROM system_prompt_presets WHERE owner_email = ?1 GROUP BY id) latest
      ON latest.id = p.id AND latest.version = p.version
    WHERE p.owner_email = ?1 ORDER BY p.updated_at DESC`).bind(owner(c)).all<PromptRow>();
  return c.json({ prompts: rows.results.map(preset) });
});

chatRoutes.post("/api/system-prompts", async (c) => {
  const body = await c.req.json<Partial<SystemPromptPreset>>();
  const content = String(body.content ?? "").trim();
  const name = String(body.name ?? "").trim().slice(0, 80);
  const scope = body.scope;
  if (!name || !content) return jsonError(c, "提示词名称或内容不正确");
  const promptLimitError = systemPromptLimitError(content);
  if (promptLimitError) return jsonError(c, promptLimitError);
  if (!scope || !["chat", "prompt", "workflow"].includes(scope)) return jsonError(c, "提示词范围不正确");
  if (scope === "workflow" && !body.workflowId) return jsonError(c, "工作流提示词必须绑定工作流");
  const promptId = body.id || id();
  const previous = await c.env.DB.prepare("SELECT MAX(version) version FROM system_prompt_presets WHERE id = ?1 AND owner_email = ?2")
    .bind(promptId, owner(c)).first<{ version: number | null }>();
  const version = Number(previous?.version ?? 0) + 1;
  const timestamp = now();
  const statements = [];
  if (body.isDefault) {
    statements.push(c.env.DB.prepare(`UPDATE system_prompt_presets SET is_default = 0
      WHERE owner_email = ?1 AND scope = ?2 AND COALESCE(workflow_id, '') = COALESCE(?3, '')`)
      .bind(owner(c), scope, body.workflowId ?? null));
  }
  statements.push(c.env.DB.prepare(`INSERT INTO system_prompt_presets
    (id, owner_email, name, scope, workflow_id, content, version, is_default, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`)
    .bind(promptId, owner(c), name, scope, body.workflowId ?? null, content, version, body.isDefault ? 1 : 0, timestamp));
  await c.env.DB.batch(statements);
  const row = await c.env.DB.prepare("SELECT * FROM system_prompt_presets WHERE id = ?1 AND version = ?2")
    .bind(promptId, version).first<PromptRow>();
  return c.json(preset(row!), 201);
});

chatRoutes.get("/api/chat/threads", async (c) => {
  const rows = await c.env.DB.prepare("SELECT * FROM chat_threads WHERE owner_email = ?1 ORDER BY updated_at DESC")
    .bind(owner(c)).all<ThreadRow>();
  return c.json({ threads: rows.results.map(thread) });
});

chatRoutes.post("/api/chat/threads", async (c) => {
  const body = await c.req.json<Partial<ChatThread>>();
  const mode = body.mode === "prompt" ? "prompt" : "chat";
  const modalAvailable = availableProviders(c).some((provider) => provider.id === "modal-qwen36" && provider.available);
  const providerId = body.providerId ?? (mode === "prompt" && modalAvailable ? "modal-qwen36" : "workers-ai");
  const provider = availableProviders(c).find((item) => item.id === providerId);
  if (!provider?.available) return jsonError(c, `${provider?.label ?? "模型"}尚未配置`, 503);
  const promptLimitError = body.systemPromptOverride ? systemPromptLimitError(body.systemPromptOverride) : undefined;
  if (promptLimitError) return jsonError(c, promptLimitError);
  let promptVersion = body.systemPromptVersion ?? null;
  let promptPresetId = body.systemPromptPresetId ?? null;
  if (promptPresetId) {
    if (!promptVersion) {
      const latest = await c.env.DB.prepare("SELECT MAX(version) version FROM system_prompt_presets WHERE id = ?1 AND owner_email = ?2")
        .bind(promptPresetId, owner(c)).first<{ version: number | null }>();
      promptVersion = latest?.version ?? null;
    }
    const selected = promptVersion
      ? await c.env.DB.prepare(`SELECT id FROM system_prompt_presets
          WHERE id = ?1 AND version = ?2 AND owner_email = ?3`)
        .bind(promptPresetId, promptVersion, owner(c)).first<{ id: string }>()
      : undefined;
    if (!selected) return jsonError(c, "所选系统提示词版本不存在", 404);
  }
  if (!body.systemPromptOverride && !promptPresetId) {
    const selectedDefault = await defaultPromptPreset(c, mode, body.workflowId);
    promptPresetId = selectedDefault?.id ?? null;
    promptVersion = selectedDefault?.version ?? null;
  }
  const threadId = id();
  const timestamp = now();
  await c.env.DB.prepare(`INSERT INTO chat_threads
    (id, owner_email, title, mode, provider_id, workflow_id, workflow_revision_id, target_field_name,
      system_prompt_preset_id, system_prompt_version, system_prompt_override, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12)`)
    .bind(threadId, owner(c), String(body.title ?? (mode === "prompt" ? "新提示词" : "新对话")).trim().slice(0, 80), mode,
      providerId, body.workflowId ?? null, body.workflowRevisionId ?? null, body.targetFieldName ?? null,
      promptPresetId, promptVersion, body.systemPromptOverride ?? null, timestamp).run();
  const row = await ownedThread(c, threadId);
  return c.json(thread(row!), 201);
});

chatRoutes.get("/api/chat/threads/:threadId", async (c) => {
  const row = await ownedThread(c, c.req.param("threadId"));
  if (!row) return jsonError(c, "对话不存在", 404);
  const messages = await c.env.DB.prepare("SELECT * FROM chat_messages WHERE thread_id = ?1 ORDER BY created_at")
    .bind(row.id).all<MessageRow>();
  const latestJob = await c.env.DB.prepare(`SELECT * FROM modal_chat_jobs
    WHERE thread_id = ?1 AND owner_email = ?2 ORDER BY created_at DESC LIMIT 1`)
    .bind(row.id, owner(c)).first<ModalChatJobRow>();
  return c.json({
    thread: thread(row),
    messages: messages.results.map(message),
    operation: latestJob && latestJob.status !== "completed"
      ? await chatOperation(c, latestJob)
      : undefined,
  });
});

chatRoutes.get("/api/chat/operations/:operationId", async (c) => {
  const job = await c.env.DB.prepare(
    "SELECT * FROM modal_chat_jobs WHERE operation_id = ?1 AND owner_email = ?2",
  ).bind(c.req.param("operationId"), owner(c)).first<ModalChatJobRow>();
  if (!job) return jsonError(c, "对话任务不存在", 404);
  if (["queued", "submitting", "warming", "generating"].includes(job.status)) {
    c.executionCtx.waitUntil(wakeQueue(c.env));
  }
  return c.json({ operation: await chatOperation(c, job) });
});

chatRoutes.patch("/api/chat/threads/:threadId", async (c) => {
  const existing = await ownedThread(c, c.req.param("threadId"));
  if (!existing) return jsonError(c, "对话不存在", 404);
  const body = await c.req.json<Partial<ChatThread>>();
  const promptLimitError = body.systemPromptOverride ? systemPromptLimitError(body.systemPromptOverride) : undefined;
  if (promptLimitError) return jsonError(c, promptLimitError);
  const providerId = body.providerId ?? existing.provider_id;
  if (!availableProviders(c).find((item) => item.id === providerId)?.available) return jsonError(c, "所选模型尚未配置", 503);
  await c.env.DB.prepare(`UPDATE chat_threads SET title = ?1, provider_id = ?2,
    system_prompt_override = ?3, updated_at = ?4 WHERE id = ?5 AND owner_email = ?6`)
    .bind(String(body.title ?? existing.title).trim().slice(0, 80), providerId,
      body.systemPromptOverride === undefined ? existing.system_prompt_override : body.systemPromptOverride || null,
      now(), existing.id, owner(c)).run();
  return c.json(thread((await ownedThread(c, existing.id))!));
});

chatRoutes.delete("/api/chat/threads/:threadId", async (c) => {
  const active = await c.env.DB.prepare(`SELECT operation_id FROM modal_chat_jobs
    WHERE thread_id = ?1 AND owner_email = ?2
      AND status IN ('queued', 'submitting', 'warming', 'generating', 'needs-human') LIMIT 1`)
    .bind(c.req.param("threadId"), owner(c)).first();
  if (active) return jsonError(c, "当前会话仍有 Modal 任务，完成或保护期结束后才能删除", 409);
  await c.env.DB.prepare("DELETE FROM chat_threads WHERE id = ?1 AND owner_email = ?2")
    .bind(c.req.param("threadId"), owner(c)).run();
  return c.json({ ok: true });
});

chatRoutes.post("/api/chat/threads/:threadId/messages", async (c) => {
  const row = await ownedThread(c, c.req.param("threadId"));
  if (!row) return jsonError(c, "对话不存在", 404);
  const body = await c.req.json<{ content?: string }>();
  const content = String(body.content ?? "").trim();
  if (!content || content.length > 20_000) return jsonError(c, "消息内容不能为空且不能超过 20,000 字符");
  const systemPrompt = await resolveSystemPrompt(c, row);
  const inputTokenBudget = chatInputTokenBudget(row.provider_id);
  if (!fitsChatContext(systemPrompt, content, inputTokenBudget)) {
    const contextLabel = row.provider_id === "modal-qwen36" ? "Modal 64K" : "Workers AI";
    return jsonError(c, `消息与系统提示词合计超过 ${contextLabel} 上下文预算，请缩短内容`);
  }
  let workersReservation: { inputTokens: number; reservedNeurons: number; usageDate: string } | undefined;
  const previous = await c.env.DB.prepare("SELECT * FROM chat_messages WHERE thread_id = ?1 ORDER BY created_at")
    .bind(row.id).all<MessageRow>();
  const pendingUser: MessageRow = {
    id: id(),
    thread_id: row.id,
    role: "user",
    content,
    provider_id: null,
    created_at: now(),
  };
  const providerMessages = modelMessages(systemPrompt, [...previous.results, pendingUser], inputTokenBudget);
  if (row.provider_id === "modal-qwen36") {
    const modalIdempotencyKey = requireIdempotencyKey(c);
    const existing = await modalChatSubmission(c, modalIdempotencyKey);
    if (existing) return replayModalChat(c, existing);
    const activeJob = await c.env.DB.prepare(`SELECT operation_id FROM modal_chat_jobs
      WHERE thread_id = ?1 AND owner_email = ?2 AND status IN ('queued', 'submitting', 'warming', 'generating', 'needs-human')
      LIMIT 1`).bind(row.id, owner(c)).first();
    if (activeJob) return jsonError(c, "当前会话已有 Modal 回复正在处理，请等待完成", 409);
    const modalOperationId = id();
    const modalDescriptor = {
      action: "modal-chat" as const,
      target: costTargets.modalChat(row.id),
      fileBytes: new TextEncoder().encode(content).byteLength,
      batchCount: 1,
    };
    try {
      await c.env.DB.prepare(`INSERT INTO modal_submissions
        (id, owner_email, action, idempotency_key, target_hash, status, created_at, updated_at)
        VALUES (?1, ?2, 'modal-chat', ?3, '', 'pending', ?4, ?4)`)
        .bind(modalOperationId, owner(c), modalIdempotencyKey, now()).run();
    } catch {
      const duplicate = await modalChatSubmission(c, modalIdempotencyKey);
      if (duplicate) return replayModalChat(c, duplicate);
      throw new Error("无法建立 Modal 对话幂等提交记录");
    }
    try {
      const approval = await consumeCostApproval(c, modalDescriptor);
      const timestamp = now();
      const assistantMessageId = id();
      const requestJson = JSON.stringify({
        ...modalChatPayload(row.mode, providerMessages, row.mode === "prompt" ? 1_024 : 2_048),
        stream: false,
      });
      await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO chat_messages (id, thread_id, role, content, created_at)
          VALUES (?1, ?2, 'user', ?3, ?4)`).bind(pendingUser.id, row.id, content, timestamp),
        c.env.DB.prepare("UPDATE chat_threads SET updated_at = ?1 WHERE id = ?2").bind(timestamp, row.id),
        c.env.DB.prepare(`INSERT INTO modal_chat_jobs
          (operation_id, owner_email, thread_id, user_message_id, assistant_message_id, request_json,
            status, message, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'queued', '等待 Modal GPU 队列', ?7, ?7)`)
          .bind(modalOperationId, owner(c), row.id, pendingUser.id, assistantMessageId, requestJson, timestamp),
        c.env.DB.prepare(`UPDATE modal_submissions SET status = 'submitting', quote_id = ?1,
          target_hash = ?2, updated_at = ?3 WHERE id = ?4 AND status = 'pending'`)
          .bind(approval.quoteId, approval.targetHash, timestamp, modalOperationId),
      ]);
      try {
        await wakeQueue(c.env);
      } catch {
        await c.env.DB.prepare("UPDATE modal_chat_jobs SET message = ?1, updated_at = ?2 WHERE operation_id = ?3")
          .bind("队列暂时无法唤醒；页面查询状态时会继续恢复", now(), modalOperationId).run();
      }
      const queued = await c.env.DB.prepare("SELECT * FROM modal_chat_jobs WHERE operation_id = ?1")
        .bind(modalOperationId).first<ModalChatJobRow>();
      return c.json({
        operation: await chatOperation(c, queued!),
        userMessage: message(pendingUser),
      }, 202);
    } catch (error) {
      if (error instanceof CostApprovalError) {
        await c.env.DB.prepare("DELETE FROM modal_submissions WHERE id = ?1 AND status = 'pending'")
          .bind(modalOperationId).run();
        throw error;
      }
      await c.env.DB.prepare(`UPDATE modal_submissions SET status = 'rejected', message = ?1,
        updated_at = ?2 WHERE id = ?3`).bind(error instanceof Error ? error.message : "Modal 对话入队失败", now(), modalOperationId).run();
      return jsonError(c, error instanceof Error ? error.message : "Modal 对话入队失败", 500);
    }
  }
  try {
    workersReservation = await reserveWorkersAi(c.env, owner(c), providerMessages, row.mode === "prompt" ? 1_024 : 2_048);
  } catch (error) {
    return jsonError(c, error instanceof Error ? error.message : "Workers AI 今日额度不足", 429);
  }
  const userMessageId = pendingUser.id;
  const timestamp = now();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO chat_messages (id, thread_id, role, content, created_at)
        VALUES (?1, ?2, 'user', ?3, ?4)`).bind(userMessageId, row.id, content, timestamp),
      c.env.DB.prepare("UPDATE chat_threads SET updated_at = ?1 WHERE id = ?2").bind(timestamp, row.id),
    ]);
  } catch (error) {
    await releaseWorkersAiReservation(c.env, owner(c), workersReservation);
    throw error;
  }
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();
  const providerAbort = new AbortController();
  const send = (event: string, data: unknown) => writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
  const providerTask = (async () => {
    let assistant = "";
    const providerTimeout = setTimeout(
      () => providerAbort.abort(new Error("Workers AI 请求超过 90 秒，已停止等待")),
      90 * 1_000,
    );
    try {
      const source = await workersAiStream(
        c.env,
        providerMessages,
        row.mode === "prompt" ? 1_024 : 2_048,
        row.mode === "prompt" ? 0.55 : 0.7,
        providerAbort.signal,
      );
      await consumeProviderStream(source, async (delta) => {
        assistant += delta;
        await send("delta", { content: delta });
      });
      if (!assistant.trim()) throw new Error("模型返回了空内容");
      const assistantMessageId = id();
      await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO chat_messages (id, thread_id, role, content, provider_id, created_at)
          VALUES (?1, ?2, 'assistant', ?3, ?4, ?5)`)
          .bind(assistantMessageId, row.id, assistant, row.provider_id, now()),
        c.env.DB.prepare("UPDATE chat_threads SET updated_at = ?1 WHERE id = ?2").bind(now(), row.id),
      ]);
      if (row.provider_id === "workers-ai") {
        const inputTokens = workersReservation?.inputTokens
          ?? providerMessages.reduce((total, item) => total + estimatedTokens(item.content), 0);
        const outputTokens = estimatedTokens(assistant);
        const neurons = inputTokens * 0.004625 + outputTokens * 0.030475;
        await c.env.DB.prepare(`UPDATE ai_usage_daily SET input_tokens = input_tokens + ?1,
          output_tokens = output_tokens + ?2, estimated_neurons = estimated_neurons + ?3,
          reserved_neurons = MAX(0, reserved_neurons - ?4)
          WHERE owner_email = ?5 AND usage_date = ?6 AND provider_id = 'workers-ai'`)
          .bind(inputTokens, outputTokens, neurons, workersReservation?.reservedNeurons ?? 0,
            owner(c), workersReservation?.usageDate ?? today()).run();
        workersReservation = undefined;
      }
      await send("complete", { message: message({
        id: assistantMessageId,
        thread_id: row.id,
        role: "assistant",
        content: assistant,
        provider_id: row.provider_id,
        created_at: now(),
      }) });
    } catch (error) {
      await send("error", { message: error instanceof Error ? error.message : "模型请求失败" }).catch(() => undefined);
    } finally {
      clearTimeout(providerTimeout);
      await releaseWorkersAiReservation(c.env, owner(c), workersReservation).catch(() => undefined);
      await writer.close().catch(() => undefined);
    }
  })();
  // The stream keeps normal generation alive; waitUntil preserves cleanup after a client disconnect.
  c.executionCtx.waitUntil(providerTask);
  return new Response(abortProviderOnResponseCancel(stream.readable, providerAbort), {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-store",
      connection: "keep-alive",
    },
  });
});
