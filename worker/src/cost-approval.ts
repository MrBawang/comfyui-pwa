import { Hono } from "hono";
import type { Context } from "hono";

import { COST_ACTIONS, type CostAction, type CostDescriptor, type CostQuote } from "../../shared/costs";
import type { UserContext } from "./env";
import { id, jsonError, now, owner } from "./utils";

const QUOTE_LIFETIME_MS = 15 * 60 * 1_000;
const APPROVAL_LIFETIME_MS = 5 * 60 * 1_000;
const L40S_USD_PER_SECOND = 0.000542;

interface ActionSpec {
  label: string;
  description: string;
  maxDurationSeconds: number;
  durationPerItem?: boolean;
  provider: "comfy" | "llm";
}

const ACTION_SPECS: Record<CostAction, ActionSpec> = {
  "workflow-analyze": {
    label: "云端检查工作流",
    description: "使用 Modal CPU 深度检查工作流和节点环境。",
    maxDurationSeconds: 600,
    provider: "comfy",
  },
  "workflow-convert": {
    label: "转换 API 工作流",
    description: "使用 Modal CPU 将 Canvas 工作流转换为 API 工作流。",
    maxDurationSeconds: 600,
    provider: "comfy",
  },
  "workflow-import": {
    label: "检查并保存工作流",
    description: "使用 Modal CPU 检查工作流，通过后保存到云端工作流库。",
    maxDurationSeconds: 600,
    provider: "comfy",
  },
  "workflow-sync": {
    label: "同步云端工作流目录",
    description: "唤醒 Modal CPU 一次并将已有工作流元数据同步到 D1；后续浏览不会再次唤醒 Modal。",
    maxDurationSeconds: 600,
    provider: "comfy",
  },
  "workflow-run": {
    label: "运行工作流",
    description: "启动一次 Modal L40S ComfyUI 生成任务。",
    maxDurationSeconds: 1_800,
    provider: "comfy",
  },
  "character-batch": {
    label: "批量生成人物视角",
    description: "按所选视角依次启动 Modal L40S ComfyUI 任务；失败项不会自动重跑。",
    maxDurationSeconds: 1_800,
    durationPerItem: true,
    provider: "comfy",
  },
  "model-download": {
    label: "下载云端模型",
    description: "在 Modal 中下载并校验一个模型文件。",
    maxDurationSeconds: 7_200,
    provider: "comfy",
  },
  "node-package-install": {
    label: "安装节点包",
    description: "在 Modal 中构建并切换一个新的节点运行环境。",
    maxDurationSeconds: 7_200,
    provider: "comfy",
  },
  "python-package-install": {
    label: "安装 Python 依赖",
    description: "在 Modal 中构建并切换一个新的 Python 运行环境。",
    maxDurationSeconds: 7_200,
    provider: "comfy",
  },
  "runtime-rollback": {
    label: "回滚云端运行环境",
    description: "在 Modal 中将节点和 Python 环境切换到上一版本。",
    maxDurationSeconds: 7_200,
    provider: "comfy",
  },
  "modal-chat": {
    label: "使用 Modal Qwen 对话",
    description: "启动一次按量计费的 Modal L40S Qwen 对话。",
    maxDurationSeconds: 900,
    provider: "llm",
  },
  "llm-model-download": {
    label: "下载 Qwen 模型",
    description: "将固定 revision 的 GGUF 下载到独立 Modal Volume。",
    maxDurationSeconds: 7_200,
    provider: "llm",
  },
  "llm-benchmark": {
    label: "运行 Qwen GPU 验证",
    description: "启动一次 L40S 并执行已批准的模型验证批次。",
    maxDurationSeconds: 3_600,
    provider: "llm",
  },
};

interface QuoteRow {
  id: string;
  owner_email: string;
  action: CostAction;
  target: string;
  target_hash: string;
  file_bytes: number;
  batch_count: number;
  label: string;
  description: string;
  max_duration_seconds: number;
  estimated_max_usd: number;
  status: CostQuote["status"];
  approval_token_hash: string | null;
  quote_expires_at: number;
  approval_expires_at: number | null;
}

export class CostApprovalError extends Error {
  constructor(message: string, readonly status: 401 | 402 | 409 | 413 | 428 | 503 = 409) {
    super(message);
  }
}

function budgetConfirmed(c: Context<UserContext>) {
  if (c.env.MODAL_BUDGET_CONFIRMED !== "true") {
    throw new CostApprovalError("Modal Workspace Budget 尚未人工确认，已禁止提交计费任务", 503);
  }
}

function providerConfigured(c: Context<UserContext>, action: CostAction) {
  const spec = ACTION_SPECS[action];
  if (spec.provider === "llm") {
    if (!c.env.MODAL_LLM_URL || !c.env.MODAL_LLM_TOKEN) {
      throw new CostApprovalError("Modal Qwen 尚未部署，当前阶段不会启动模型下载或 GPU", 503);
    }
    return;
  }
  if (!c.env.MODAL_API_URL || !c.env.MODAL_API_TOKEN) {
    throw new CostApprovalError("Modal ComfyUI 尚未配置", 503);
  }
}

function normalizedDescriptor(value: Partial<CostDescriptor>): CostDescriptor {
  if (!COST_ACTIONS.includes(value.action as CostAction)) throw new CostApprovalError("费用动作不受支持", 409);
  const target = String(value.target ?? "").trim();
  const fileBytes = Number(value.fileBytes);
  const batchCount = Number(value.batchCount);
  if (!target || target.length > 500 || /[\r\n\0]/.test(target)) throw new CostApprovalError("费用目标不正确", 409);
  if (!Number.isSafeInteger(fileBytes) || fileBytes < 0 || fileBytes > 100 * 1024 ** 3) {
    throw new CostApprovalError("费用报价的文件大小不正确", 409);
  }
  if (!Number.isSafeInteger(batchCount) || batchCount < 1 || batchCount > 100) {
    throw new CostApprovalError("费用报价的批次数量不正确", 409);
  }
  return { action: value.action as CostAction, target, fileBytes, batchCount };
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function quoteResponse(row: QuoteRow): CostQuote {
  return {
    id: row.id,
    action: row.action,
    target: row.target,
    fileBytes: Number(row.file_bytes),
    batchCount: Number(row.batch_count),
    label: row.label,
    description: row.description,
    maxDurationSeconds: Number(row.max_duration_seconds),
    estimatedMaxUsd: Number(row.estimated_max_usd),
    quoteExpiresAt: Number(row.quote_expires_at),
    status: row.status,
  };
}

export const costRoutes = new Hono<UserContext>();

costRoutes.post("/api/cost-quotes", async (c) => {
  budgetConfirmed(c);
  const descriptor = normalizedDescriptor(await c.req.json<Partial<CostDescriptor>>());
  providerConfigured(c, descriptor.action);
  const spec = ACTION_SPECS[descriptor.action];
  const totalSeconds = spec.maxDurationSeconds * (spec.durationPerItem ? descriptor.batchCount : 1);
  const timestamp = now();
  const row: QuoteRow = {
    id: id(),
    owner_email: owner(c),
    action: descriptor.action,
    target: descriptor.target,
    target_hash: await sha256(descriptor.target),
    file_bytes: descriptor.fileBytes,
    batch_count: descriptor.batchCount,
    label: spec.label,
    description: spec.description,
    max_duration_seconds: totalSeconds,
    estimated_max_usd: Number((totalSeconds * L40S_USD_PER_SECOND).toFixed(4)),
    status: "pending",
    approval_token_hash: null,
    quote_expires_at: timestamp + QUOTE_LIFETIME_MS,
    approval_expires_at: null,
  };
  await c.env.DB.prepare(`INSERT INTO cost_quotes
    (id, owner_email, action, target, target_hash, file_bytes, batch_count, label, description,
      max_duration_seconds, estimated_max_usd, status, quote_expires_at, created_at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'pending', ?12, ?13)`)
    .bind(row.id, row.owner_email, row.action, row.target, row.target_hash, row.file_bytes,
      row.batch_count, row.label, row.description, row.max_duration_seconds,
      row.estimated_max_usd, row.quote_expires_at, timestamp).run();
  return c.json(quoteResponse(row), 201);
});

costRoutes.post("/api/cost-quotes/:quoteId/approve", async (c) => {
  budgetConfirmed(c);
  const quoteId = c.req.param("quoteId");
  const row = await c.env.DB.prepare("SELECT * FROM cost_quotes WHERE id = ?1 AND owner_email = ?2")
    .bind(quoteId, owner(c)).first<QuoteRow>();
  if (!row) return jsonError(c, "费用报价不存在", 404);
  if (row.status !== "pending") return jsonError(c, "费用报价已经批准、使用或过期", 409);
  const timestamp = now();
  if (row.quote_expires_at <= timestamp) {
    await c.env.DB.prepare("UPDATE cost_quotes SET status = 'expired' WHERE id = ?1 AND status = 'pending'")
      .bind(row.id).run();
    return jsonError(c, "费用报价已过期，请重新生成", 409);
  }
  providerConfigured(c, row.action);
  const approvalToken = `${row.id}.${randomToken()}`;
  const tokenHash = await sha256(approvalToken);
  const approvalExpiresAt = timestamp + APPROVAL_LIFETIME_MS;
  const result = await c.env.DB.prepare(`UPDATE cost_quotes SET status = 'approved', approval_token_hash = ?1,
    approved_at = ?2, approval_expires_at = ?3 WHERE id = ?4 AND owner_email = ?5 AND status = 'pending'`)
    .bind(tokenHash, timestamp, approvalExpiresAt, row.id, owner(c)).run();
  if (Number(result.meta.changes ?? 0) !== 1) return jsonError(c, "费用报价已被其他请求处理", 409);
  return c.json({ approvalToken, expiresAt: approvalExpiresAt });
});

export async function consumeCostApproval(c: Context<UserContext>, rawDescriptor: CostDescriptor) {
  budgetConfirmed(c);
  const descriptor = normalizedDescriptor(rawDescriptor);
  providerConfigured(c, descriptor.action);
  const approvalToken = c.req.header("x-cost-approval") ?? "";
  const [quoteId, secret, ...extra] = approvalToken.split(".");
  if (!/^[a-f0-9]{32}$/.test(quoteId ?? "") || !/^[a-f0-9]{64}$/.test(secret ?? "") || extra.length) {
    throw new CostApprovalError("此操作需要先生成并批准一次费用报价", 428);
  }
  const row = await c.env.DB.prepare("SELECT * FROM cost_quotes WHERE id = ?1 AND owner_email = ?2")
    .bind(quoteId, owner(c)).first<QuoteRow>();
  if (!row || row.status !== "approved" || !row.approval_token_hash || !row.approval_expires_at) {
    throw new CostApprovalError("费用批准令牌无效或已使用", 409);
  }
  if (row.approval_expires_at <= now()) {
    await c.env.DB.prepare("UPDATE cost_quotes SET status = 'expired' WHERE id = ?1 AND status = 'approved'")
      .bind(row.id).run();
    throw new CostApprovalError("费用批准已过期，请重新确认", 409);
  }
  const targetHash = await sha256(descriptor.target);
  if (row.action !== descriptor.action || row.target_hash !== targetHash
    || Number(row.file_bytes) !== descriptor.fileBytes || Number(row.batch_count) !== descriptor.batchCount) {
    throw new CostApprovalError("费用批准与本次动作、目标、文件大小或批次数量不匹配", 409);
  }
  const tokenHash = await sha256(approvalToken);
  const result = await c.env.DB.prepare(`UPDATE cost_quotes SET status = 'consumed', consumed_at = ?1
    WHERE id = ?2 AND owner_email = ?3 AND status = 'approved' AND approval_token_hash = ?4
      AND approval_expires_at > ?1`)
    .bind(now(), row.id, owner(c), tokenHash).run();
  if (Number(result.meta.changes ?? 0) !== 1) throw new CostApprovalError("费用批准令牌已被使用", 409);
  return { quoteId: row.id, targetHash };
}

export function requireIdempotencyKey(c: Context<UserContext>) {
  const key = (c.req.header("idempotency-key") ?? "").trim();
  if (!/^[A-Za-z0-9._:-]{8,120}$/.test(key)) {
    throw new CostApprovalError("计费操作必须携带有效的 Idempotency-Key", 428);
  }
  return key;
}
