import { Hono } from "hono";
import { logger } from "hono/logger";

import { requireAgent, requireUser } from "./auth";
import { chatRoutes } from "./chat-routes";
import { coreRoutes } from "./core-routes";
import { costRoutes, CostApprovalError } from "./cost-approval";
import type { UserContext } from "./env";
import { GpuQueue } from "./gpu-queue";
import { proxyMeteredModal, proxyModal, syncModalWorkflowCache } from "./modal";
import { r2Delete, R2BudgetError } from "./r2-budget";
import { storageBrowserRoutes } from "./storage-browser";
import { wisartRoutes, WisartQueue } from "./wisart";
import { cachedWorkflow, cachedWorkflows } from "./workflow-cache";
import { modalEndpointStatus, owner } from "./utils";

const app = new Hono<UserContext>();

app.use("/api/*", logger());
app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/agent/")) return requireAgent(c, next);
  return requireUser(c, next);
});

app.get("/api/health", (c) => {
  const modal = modalEndpointStatus(c.env);
  return c.json({
    status: "ready",
    app: "LoRAChef Studio Worker",
    modalConfigured: modal.configured,
    modalWorkspace: modal.workspace,
    modalEndpointValid: modal.valid,
    modalBudgetConfirmed: c.env.MODAL_BUDGET_CONFIRMED === "true",
    canRollbackRuntime: false,
  });
});
app.get("/api/workflows", async (c) => c.json({ workflows: await cachedWorkflows(c.env, owner(c)) }));
app.post("/api/workflows", (c) => proxyMeteredModal(c, "/workflows"));
app.post("/api/workflows/sync", (c) => syncModalWorkflowCache(c));
app.get("/api/workflows/:workflowId", async (c) => {
  const workflow = await cachedWorkflow(c.env, owner(c), c.req.param("workflowId"));
  return workflow ? c.json(workflow) : c.json({ message: "工作流不在 D1 缓存中" }, 404);
});
app.post("/api/workflows/*", (c) => proxyMeteredModal(c, c.req.path.slice(4)));
app.all("/api/resources/*", (c) => c.req.method === "POST"
  ? proxyMeteredModal(c, c.req.path.slice(4))
  : proxyModal(c, c.req.path.slice(4)));

app.route("/", costRoutes);
app.route("/", coreRoutes);
app.route("/", chatRoutes);
app.route("/", storageBrowserRoutes);
app.route("/", wisartRoutes);

app.get("/api/config", (c) => {
  const modal = modalEndpointStatus(c.env);
  return c.json({
    app: "LoRAChef Studio",
    environment: c.env.APP_ENV,
    modalConfigured: modal.configured,
    modalWorkspace: modal.workspace,
    modalEndpointValid: modal.valid,
    modalBudgetConfirmed: c.env.MODAL_BUDGET_CONFIRMED === "true",
    modalLlmConfigured: Boolean(c.env.MODAL_LLM_URL && c.env.MODAL_LLM_TOKEN),
    wisartConfigured: Boolean(c.env.WISART_API_URL && c.env.WISART_API_KEY),
    wisartDefaultModel: c.env.WISART_DEFAULT_MODEL || undefined,
    workersAiModel: c.env.WORKERS_AI_MODEL,
  });
});

app.notFound((c) => {
  if (c.req.path.startsWith("/api/")) return c.json({ message: "接口不存在" }, 404);
  return c.env.ASSETS.fetch(c.req.raw);
});

app.onError((error, c) => {
  console.error(error);
  if (error instanceof CostApprovalError) return c.json({ message: error.message }, error.status);
  if (error instanceof R2BudgetError) return c.json({ message: error.message }, 507);
  if (error.message.includes("编号格式不正确")) return c.json({ message: error.message }, 400);
  return c.json({ message: error.message || "服务暂时不可用" }, 500);
});

export { GpuQueue, WisartQueue };

async function cleanupExpiredUploads(env: UserContext["Bindings"]) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1_000;
  const expired = await env.DB.prepare(`SELECT object_key FROM storage_objects
    WHERE category = 'pending-upload' AND created_at < ?1 LIMIT 100`)
    .bind(cutoff).all<{ object_key: string }>();
  if (!expired.results.length) return;
  await r2Delete(env, expired.results.map((item) => item.object_key));
  await env.DB.batch(expired.results.map((item) => env.DB.prepare(
    "DELETE FROM storage_objects WHERE object_key = ?1 AND category = 'pending-upload'",
  ).bind(item.object_key)));
}

export default {
  fetch: app.fetch,
  scheduled(_controller: ScheduledController, env: UserContext["Bindings"], ctx: ExecutionContext) {
    ctx.waitUntil(cleanupExpiredUploads(env));
  },
};
