import type { Env } from "./env";
import { now, parseJson } from "./utils";

interface CachedWorkflow {
  id: string;
  revisionId: string;
  name: string;
  status: string;
  imageInputs: Array<{ fieldName: string }>;
  textInputs: Array<{ fieldName: string; currentValue: string }>;
  parameterInputs: Array<{ fieldName: string; inputName: string; currentValue: string | number | boolean }>;
  variants?: Array<{
    id: string;
    imageInputs: Array<{ fieldName: string }>;
    textInputs: Array<{ fieldName: string; currentValue: string }>;
    parameterInputs: Array<{ fieldName: string; inputName: string; currentValue: string | number | boolean }>;
  }>;
}

function isWorkflow(value: unknown): value is CachedWorkflow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<CachedWorkflow>;
  return typeof item.id === "string" && /^[a-f0-9]{32}$/.test(item.id)
    && typeof item.revisionId === "string" && typeof item.name === "string"
    && Array.isArray(item.imageInputs) && Array.isArray(item.textInputs) && Array.isArray(item.parameterInputs);
}

export async function cachedWorkflows(env: Env, ownerEmail: string) {
  const rows = await env.DB.prepare(`SELECT payload_json FROM workflow_cache
    WHERE owner_email = ?1 ORDER BY updated_at DESC`).bind(ownerEmail).all<{ payload_json: string }>();
  return rows.results.map((row) => parseJson<unknown>(row.payload_json, undefined)).filter(isWorkflow);
}

export async function cachedWorkflow(env: Env, ownerEmail: string, workflowId: string) {
  const row = await env.DB.prepare(`SELECT payload_json FROM workflow_cache
    WHERE workflow_id = ?1 AND owner_email = ?2`).bind(workflowId, ownerEmail).first<{ payload_json: string }>();
  const workflow = parseJson<unknown>(row?.payload_json, undefined);
  return isWorkflow(workflow) ? workflow : undefined;
}

export async function upsertCachedWorkflow(env: Env, ownerEmail: string, workflow: unknown) {
  if (!isWorkflow(workflow)) return false;
  await env.DB.prepare(`INSERT INTO workflow_cache (workflow_id, owner_email, payload_json, updated_at)
    VALUES (?1, ?2, ?3, ?4) ON CONFLICT(workflow_id, owner_email) DO UPDATE SET
      payload_json = excluded.payload_json, updated_at = excluded.updated_at`)
    .bind(workflow.id, ownerEmail, JSON.stringify(workflow), now()).run();
  return true;
}

export async function replaceCachedWorkflows(env: Env, ownerEmail: string, workflows: unknown[]) {
  if (workflows.length > 80 || !workflows.every(isWorkflow)) throw new Error("Modal 工作流目录格式不正确或数量过多");
  const timestamp = now();
  const statements = [env.DB.prepare("DELETE FROM workflow_cache WHERE owner_email = ?1").bind(ownerEmail)];
  for (const workflow of workflows) {
    statements.push(env.DB.prepare(`INSERT INTO workflow_cache
      (workflow_id, owner_email, payload_json, updated_at) VALUES (?1, ?2, ?3, ?4)`)
      .bind(workflow.id, ownerEmail, JSON.stringify(workflow), timestamp));
  }
  await env.DB.batch(statements);
}
