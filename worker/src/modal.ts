import type { Context } from "hono";

import { costTargets, type CostDescriptor } from "../../shared/costs";
import { consumeCostApproval, CostApprovalError, requireIdempotencyKey } from "./cost-approval";
import type { UserContext } from "./env";
import { id, modalBase, modalHeaders, now, owner, safeResponseMessage } from "./utils";
import { cachedWorkflow, replaceCachedWorkflows, upsertCachedWorkflow } from "./workflow-cache";

interface SubmissionRow {
  id: string;
  status: "pending" | "submitting" | "completed" | "rejected" | "needs-human";
  response_status: number | null;
  response_content_type: string | null;
  response_body: string | null;
  message: string | null;
}

const MAX_REPLAY_BODY_BYTES = 512 * 1024;
const MAX_WORKFLOW_REQUEST_BYTES = 30 * 1024 * 1024;
const MAX_MULTIPART_OVERHEAD_BYTES = 16 * 1024;

function replaySubmission(c: Context<UserContext>, row: SubmissionRow) {
  if (row.response_body !== null && row.response_status) {
    return new Response(row.response_body, {
      status: row.response_status,
      headers: {
        "content-type": row.response_content_type || "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-idempotent-replay": "true",
      },
    });
  }
  const message = row.status === "needs-human"
    ? row.message || "上次 Modal 提交结果不明确，需要人工核对后重新批准"
    : row.status === "completed"
      ? "相同请求已经完成；为避免重复计费，不会再次提交"
      : "相同请求已经提交或正在处理；不会重复启动 Modal";
  return c.json({ operationId: row.id, status: row.status, message }, 409);
}

async function existingSubmission(c: Context<UserContext>, action: string, idempotencyKey: string) {
  return c.env.DB.prepare(`SELECT id, status, response_status, response_content_type, response_body, message
    FROM modal_submissions WHERE owner_email = ?1 AND action = ?2 AND idempotency_key = ?3`)
    .bind(owner(c), action, idempotencyKey).first<SubmissionRow>();
}

export async function proxyModal(c: Context<UserContext>, modalPath: string) {
  try {
    const target = `${modalBase(c.env)}${modalPath}`;
    const headers = modalHeaders(c.env, c.req.raw.headers);
    headers.delete("host");
    const response = await fetch(target, {
      method: c.req.method,
      headers,
      body: c.req.method === "GET" || c.req.method === "HEAD" ? undefined : c.req.raw.body,
      redirect: "manual",
    });
    const outgoing = new Headers(response.headers);
    outgoing.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, headers: outgoing });
  } catch (error) {
    return c.json({ message: error instanceof Error ? error.message : "Modal 请求失败" }, 503);
  }
}

function uploadedWorkflowDescriptor(c: Context<UserContext>, action: CostDescriptor["action"]): CostDescriptor {
  const declaredTarget = (c.req.header("x-cost-target") ?? "").trim();
  const declaredFileBytes = Number(c.req.header("x-cost-file-bytes") ?? "");
  const contentLength = Number(c.req.header("content-length") ?? "");
  if (!declaredTarget || !Number.isSafeInteger(declaredFileBytes) || declaredFileBytes <= 0) {
    throw new CostApprovalError("工作流费用元数据不完整", 409);
  }
  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    throw new CostApprovalError("工作流请求缺少可信的 Content-Length", 409);
  }
  if (contentLength > MAX_WORKFLOW_REQUEST_BYTES) {
    throw new CostApprovalError("工作流请求体超过云端代理安全上限", 413);
  }
  const multipartOverhead = contentLength - declaredFileBytes;
  if (multipartOverhead <= 0 || multipartOverhead > MAX_MULTIPART_OVERHEAD_BYTES) {
    throw new CostApprovalError("工作流费用批准与实际上传文件不匹配", 409);
  }
  return { action, target: declaredTarget, fileBytes: declaredFileBytes, batchCount: 1 };
}

function storedWorkflowDescriptor(workflowId: string): CostDescriptor {
  return {
    action: "workflow-analyze",
    target: costTargets.storedWorkflow(workflowId),
    fileBytes: 0,
    batchCount: 1,
  };
}

export function shouldCacheWorkflowResponse(modalPath: string) {
  return modalPath === "/workflows"
    || /^\/workflows\/[a-f0-9]{32}(?:\/recheck)?$/.test(modalPath);
}

export async function meteredModalDescriptor(c: Context<UserContext>, modalPath: string): Promise<CostDescriptor> {
  if (modalPath === "/workflows/analyze") return uploadedWorkflowDescriptor(c, "workflow-analyze");
  if (modalPath === "/workflows/convert") return uploadedWorkflowDescriptor(c, "workflow-convert");
  if (modalPath === "/workflows") return uploadedWorkflowDescriptor(c, "workflow-import");
  const recheckMatch = modalPath.match(/^\/workflows\/([a-f0-9]{32})\/recheck$/);
  if (recheckMatch) return storedWorkflowDescriptor(recheckMatch[1]);

  const body = await c.req.raw.clone().json().catch(() => ({})) as Record<string, unknown>;
  if (modalPath === "/resources/models") {
    const sourceKind = String(body.sourceKind ?? "huggingface");
    return {
      action: "model-download",
      target: sourceKind === "url"
        ? costTargets.modelUrl(String(body.sourceUrl ?? ""), String(body.category ?? ""),
          String(body.filename ?? ""), String(body.sha256 ?? ""))
        : costTargets.model(String(body.repoId ?? ""), String(body.repoFile ?? ""),
          String(body.revision ?? "main"), String(body.category ?? ""), String(body.filename ?? "")),
      fileBytes: 0,
      batchCount: 1,
    };
  }
  if (modalPath === "/resources/nodes") {
    return {
      action: "node-package-install",
      target: costTargets.nodePackage(String(body.registryId ?? ""), String(body.sourceRepository ?? ""),
        String(body.sourceRevision ?? "")),
      fileBytes: 0,
      batchCount: 1,
    };
  }
  if (modalPath === "/resources/runtime/packages") {
    return {
      action: "python-package-install",
      target: costTargets.pythonPackage(String(body.packageId ?? "")),
      fileBytes: 0,
      batchCount: 1,
    };
  }
  if (modalPath === "/resources/runtime/rollback") {
    return { action: "runtime-rollback", target: costTargets.runtimeRollback(), fileBytes: 0, batchCount: 1 };
  }
  throw new CostApprovalError("此 Modal 写入接口没有费用保护规则，已拒绝调用", 409);
}

export async function proxyMeteredModal(c: Context<UserContext>, modalPath: string) {
  const descriptor = await meteredModalDescriptor(c, modalPath);
  const idempotencyKey = requireIdempotencyKey(c);
  const existing = await existingSubmission(c, descriptor.action, idempotencyKey);
  if (existing) return replaySubmission(c, existing);

  const operationId = id();
  const timestamp = now();
  try {
    await c.env.DB.prepare(`INSERT INTO modal_submissions
      (id, owner_email, action, idempotency_key, target_hash, status, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, '', 'pending', ?5, ?5)`)
      .bind(operationId, owner(c), descriptor.action, idempotencyKey, timestamp).run();
  } catch {
    const duplicate = await existingSubmission(c, descriptor.action, idempotencyKey);
    if (duplicate) return replaySubmission(c, duplicate);
    throw new Error("无法建立 Modal 幂等提交记录");
  }

  let approval: { quoteId: string; targetHash: string };
  try {
    approval = await consumeCostApproval(c, descriptor);
  } catch (error) {
    await c.env.DB.prepare("DELETE FROM modal_submissions WHERE id = ?1 AND status = 'pending'")
      .bind(operationId).run();
    throw error;
  }
  await c.env.DB.prepare(`UPDATE modal_submissions SET status = 'submitting', quote_id = ?1,
    target_hash = ?2, updated_at = ?3 WHERE id = ?4 AND status = 'pending'`)
    .bind(approval.quoteId, approval.targetHash, now(), operationId).run();

  try {
    const target = `${modalBase(c.env)}${modalPath}`;
    const headers = modalHeaders(c.env, c.req.raw.headers);
    const response = await fetch(target, {
      method: c.req.method,
      headers,
      body: c.req.raw.body,
      redirect: "manual",
    });
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    const replayable = contentType.includes("application/json")
      && contentLength > 0 && contentLength <= MAX_REPLAY_BODY_BYTES;
    const status = response.status >= 500 ? "needs-human" : response.ok ? "completed" : "rejected";
    if (replayable) {
      const responseBody = await response.text();
      if (response.ok && shouldCacheWorkflowResponse(modalPath)) {
        await upsertCachedWorkflow(c.env, owner(c), JSON.parse(responseBody));
      }
      await c.env.DB.prepare(`UPDATE modal_submissions SET status = ?1, response_status = ?2,
        response_content_type = ?3, response_body = ?4, message = ?5, updated_at = ?6 WHERE id = ?7`)
        .bind(status, response.status, contentType, responseBody,
          status === "needs-human" ? "Modal 返回服务端错误，未自动重提" : null, now(), operationId).run();
      return new Response(responseBody, {
        status: response.status,
        headers: { "content-type": contentType, "cache-control": "no-store" },
      });
    }
    await c.env.DB.prepare(`UPDATE modal_submissions SET status = ?1, response_status = ?2,
      response_content_type = ?3, message = ?4, updated_at = ?5 WHERE id = ?6`)
      .bind(status, response.status, contentType,
        status === "needs-human" ? "Modal 返回服务端错误，未自动重提" : null, now(), operationId).run();
    const outgoing = new Headers(response.headers);
    outgoing.set("cache-control", "no-store");
    return new Response(response.body, { status: response.status, headers: outgoing });
  } catch (error) {
    const message = `${error instanceof Error ? error.message : "Modal 提交失败"}；结果不明确，未自动重提`;
    await c.env.DB.prepare(`UPDATE modal_submissions SET status = 'needs-human', message = ?1,
      updated_at = ?2 WHERE id = ?3`).bind(message, now(), operationId).run();
    return c.json({ operationId, status: "needs-human", message }, 503);
  }
}

async function boundedJson(response: Response, maximumBytes: number) {
  if (!response.body) throw new Error("Modal 工作流目录响应为空");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error("Modal 工作流目录超过 2 MB 安全上限");
    }
    chunks.push(result.value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(combined)) as { workflows?: unknown[] };
}

export async function syncModalWorkflowCache(c: Context<UserContext>) {
  const descriptor: CostDescriptor = {
    action: "workflow-sync",
    target: costTargets.workflowCatalog(),
    fileBytes: 0,
    batchCount: 1,
  };
  const idempotencyKey = requireIdempotencyKey(c);
  const existing = await existingSubmission(c, descriptor.action, idempotencyKey);
  if (existing) return replaySubmission(c, existing);
  const operationId = id();
  const timestamp = now();
  await c.env.DB.prepare(`INSERT INTO modal_submissions
    (id, owner_email, action, idempotency_key, target_hash, status, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, '', 'pending', ?5, ?5)`)
    .bind(operationId, owner(c), descriptor.action, idempotencyKey, timestamp).run();
  try {
    const approval = await consumeCostApproval(c, descriptor);
    await c.env.DB.prepare(`UPDATE modal_submissions SET status = 'submitting', quote_id = ?1,
      target_hash = ?2, updated_at = ?3 WHERE id = ?4`).bind(approval.quoteId, approval.targetHash, now(), operationId).run();
    const response = await fetch(`${modalBase(c.env)}/workflows`, { headers: modalHeaders(c.env) });
    if (!response.ok) {
      const message = await safeResponseMessage(response, "Modal 工作流目录同步失败");
      const status = response.status >= 500 ? "needs-human" : "rejected";
      await c.env.DB.prepare(`UPDATE modal_submissions SET status = ?1, response_status = ?2,
        message = ?3, updated_at = ?4 WHERE id = ?5`).bind(status, response.status, message, now(), operationId).run();
      return c.json({ operationId, status, message }, response.status as 400);
    }
    const body = await boundedJson(response, 2 * 1024 * 1024);
    await replaceCachedWorkflows(c.env, owner(c), body.workflows ?? []);
    await c.env.DB.prepare(`UPDATE modal_submissions SET status = 'completed', response_status = 200,
      message = ?1, updated_at = ?2 WHERE id = ?3`)
      .bind(`已同步 ${(body.workflows ?? []).length} 个工作流`, now(), operationId).run();
    return c.json({ workflows: body.workflows ?? [] });
  } catch (error) {
    if (error instanceof CostApprovalError) {
      await c.env.DB.prepare("DELETE FROM modal_submissions WHERE id = ?1 AND status = 'pending'")
        .bind(operationId).run();
      throw error;
    }
    const message = `${error instanceof Error ? error.message : "工作流同步失败"}；结果不明确，未自动重提`;
    await c.env.DB.prepare(`UPDATE modal_submissions SET status = 'needs-human', message = ?1,
      updated_at = ?2 WHERE id = ?3`).bind(message, now(), operationId).run();
    return c.json({ operationId, status: "needs-human", message }, 503);
  }
}

export async function loadModalWorkflow(env: UserContext["Bindings"], ownerEmail: string, workflowId: string) {
  const workflow = await cachedWorkflow(env, ownerEmail, workflowId);
  if (!workflow) throw new Error("工作流不在 D1 缓存中，请先在工作流库执行一次人工批准的云端同步");
  return workflow;
}
