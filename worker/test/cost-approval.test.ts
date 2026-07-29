import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import type { CostDescriptor } from "../../shared/costs";
import { consumeCostApproval, costRoutes, CostApprovalError } from "../src/cost-approval";
import type { Env, UserContext } from "../src/env";

interface Quote {
  id: string;
  owner_email: string;
  action: string;
  target: string;
  target_hash: string;
  file_bytes: number;
  batch_count: number;
  label: string;
  description: string;
  max_duration_seconds: number;
  estimated_max_usd: number;
  status: string;
  approval_token_hash: string | null;
  quote_expires_at: number;
  approval_expires_at: number | null;
}

function fakeDb() {
  const quotes = new Map<string, Quote>();
  return {
    quotes,
    DB: {
      prepare(sql: string) {
        let values: unknown[] = [];
        return {
          bind(...next: unknown[]) { values = next; return this; },
          async first() {
            if (sql.includes("FROM cost_quotes")) {
              const row = quotes.get(String(values[0]));
              return row?.owner_email === values[1] ? row : null;
            }
            return null;
          },
          async run() {
            if (sql.includes("INSERT INTO cost_quotes")) {
              quotes.set(String(values[0]), {
                id: String(values[0]), owner_email: String(values[1]), action: String(values[2]),
                target: String(values[3]), target_hash: String(values[4]), file_bytes: Number(values[5]),
                batch_count: Number(values[6]), label: String(values[7]), description: String(values[8]),
                max_duration_seconds: Number(values[9]), estimated_max_usd: Number(values[10]),
                status: "pending", approval_token_hash: null, quote_expires_at: Number(values[11]),
                approval_expires_at: null,
              });
              return { meta: { changes: 1 } };
            }
            const row = quotes.get(String(sql.includes("status = 'approved'") && sql.includes("consumed_at") ? values[1] : values[3] ?? values[0]));
            if (!row) return { meta: { changes: 0 } };
            if (sql.includes("SET status = 'approved'") && row.status === "pending") {
              row.status = "approved";
              row.approval_token_hash = String(values[0]);
              row.approval_expires_at = Number(values[2]);
              return { meta: { changes: 1 } };
            }
            if (sql.includes("SET status = 'consumed'") && row.status === "approved"
              && row.approval_token_hash === values[3] && Number(row.approval_expires_at) > Number(values[0])) {
              row.status = "consumed";
              return { meta: { changes: 1 } };
            }
            if (sql.includes("SET status = 'expired'")) row.status = "expired";
            return { meta: { changes: 0 } };
          },
        };
      },
    },
  };
}

function testApp() {
  const db = fakeDb();
  const app = new Hono<UserContext>();
  app.use("*", async (c, next) => { c.set("ownerEmail", "owner@example.com"); await next(); });
  app.route("/", costRoutes);
  app.post("/consume", async (c) => {
    const descriptor = await c.req.json<CostDescriptor>();
    await consumeCostApproval(c, descriptor);
    return c.json({ ok: true });
  });
  app.onError((error, c) => error instanceof CostApprovalError
    ? c.json({ message: error.message }, error.status)
    : c.json({ message: String(error) }, 500));
  const env = {
    DB: db.DB,
    MODAL_WORKSPACE: "luminaflow-studio",
    MODAL_API_URL: "https://luminaflow-studio--comfy-desk-api.modal.run",
    MODAL_API_TOKEN: "secret",
    MODAL_BUDGET_CONFIRMED: "true",
    WISART_API_URL: "https://wisart.example.com",
    WISART_API_KEY: "wisart-secret",
  } as unknown as Env;
  return { app, env, db };
}

const descriptor: CostDescriptor = {
  action: "workflow-run",
  target: "workflow:abc:default",
  fileBytes: 123,
  batchCount: 1,
};

describe("single-use Modal cost approval", () => {
  it("rejects missing, mismatched, and reused approval tokens", async () => {
    const { app, env } = testApp();
    const quoteResponse = await app.request("/api/cost-quotes", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(descriptor),
    }, env);
    expect(quoteResponse.status).toBe(201);
    const quote = await quoteResponse.json<{ id: string }>();
    const approvalResponse = await app.request(`/api/cost-quotes/${quote.id}/approve`, { method: "POST" }, env);
    const approval = await approvalResponse.json<{ approvalToken: string }>();

    const missing = await app.request("/consume", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(descriptor),
    }, env);
    expect(missing.status).toBe(428);

    const mismatched = await app.request("/consume", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cost-approval": approval.approvalToken },
      body: JSON.stringify({ ...descriptor, batchCount: 2 }),
    }, env);
    expect(mismatched.status).toBe(409);

    const accepted = await app.request("/consume", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cost-approval": approval.approvalToken },
      body: JSON.stringify(descriptor),
    }, env);
    expect(accepted.status).toBe(200);

    const reused = await app.request("/consume", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cost-approval": approval.approvalToken },
      body: JSON.stringify(descriptor),
    }, env);
    expect(reused.status).toBe(409);
  });

  it("keeps Modal locked until the hard budget is manually acknowledged", async () => {
    const { app, env } = testApp();
    env.MODAL_BUDGET_CONFIRMED = "false";
    const response = await app.request("/api/cost-quotes", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(descriptor),
    }, env);
    expect(response.status).toBe(503);
  });

  it("allows a WisArt quote without coupling it to the Modal budget", async () => {
    const { app, env } = testApp();
    env.MODAL_BUDGET_CONFIRMED = "false";
    const response = await app.request("/api/cost-quotes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "wisart-image",
        target: "wisart:generate:nano-banana-2:auto:auto:1",
        fileBytes: 0,
        batchCount: 1,
      }),
    }, env);
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ action: "wisart-image", estimatedMaxUsd: 0 });
  });

  it("rejects quotes before creation when the endpoint belongs to another Modal workspace", async () => {
    const { app, env, db } = testApp();
    env.MODAL_API_URL = "https://mrbawang--comfy-desk-api.modal.run";
    const response = await app.request("/api/cost-quotes", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(descriptor),
    }, env);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      message: "Modal 地址不属于已锁定的 luminaflow-studio Workspace",
    });
    expect(db.quotes.size).toBe(0);
  });

  it("rejects a token for the wrong action and after its five-minute expiry", async () => {
    const { app, env, db } = testApp();
    const quoteResponse = await app.request("/api/cost-quotes", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(descriptor),
    }, env);
    const quote = await quoteResponse.json<{ id: string }>();
    const approvalResponse = await app.request(`/api/cost-quotes/${quote.id}/approve`, { method: "POST" }, env);
    const approval = await approvalResponse.json<{ approvalToken: string }>();

    const wrongAction = await app.request("/consume", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cost-approval": approval.approvalToken },
      body: JSON.stringify({ ...descriptor, action: "workflow-analyze" }),
    }, env);
    expect(wrongAction.status).toBe(409);

    db.quotes.get(quote.id)!.approval_expires_at = Date.now() - 1;
    const expired = await app.request("/consume", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cost-approval": approval.approvalToken },
      body: JSON.stringify(descriptor),
    }, env);
    expect(expired.status).toBe(409);
    expect(db.quotes.get(quote.id)?.status).toBe("expired");
  });
});
