import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import { costTargets } from "../../shared/costs";
import { CostApprovalError } from "../src/cost-approval";
import type { Env, UserContext } from "../src/env";
import { meteredModalDescriptor, proxyMeteredModal } from "../src/modal";

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("ambiguous Modal submissions", () => {
  afterEach(() => vi.restoreAllMocks());

  it("records manual review and never retries a failed network submission", async () => {
    const quoteId = "a".repeat(32);
    const approvalToken = `${quoteId}.${"b".repeat(64)}`;
    const target = costTargets.model("org/repo", "model.safetensors", "main", "checkpoints", "model.safetensors");
    const quote = {
      id: quoteId,
      owner_email: "owner@example.com",
      action: "model-download",
      target,
      target_hash: await sha256(target),
      file_bytes: 0,
      batch_count: 1,
      label: "download",
      description: "download",
      max_duration_seconds: 1,
      estimated_max_usd: 1,
      status: "approved",
      approval_token_hash: await sha256(approvalToken),
      quote_expires_at: Date.now() + 60_000,
      approval_expires_at: Date.now() + 60_000,
    };
    let submission: { id: string; status: string; message?: string } | undefined;
    const db = {
      prepare(sql: string) {
        let values: unknown[] = [];
        return {
          bind(...next: unknown[]) { values = next; return this; },
          async first() {
            if (sql.includes("FROM modal_submissions")) return submission ?? null;
            if (sql.includes("FROM cost_quotes")) return quote;
            return null;
          },
          async run() {
            if (sql.includes("INSERT INTO modal_submissions")) {
              submission = { id: String(values[0]), status: "pending" };
              return { meta: { changes: 1 } };
            }
            if (sql.includes("SET status = 'consumed'")) return { meta: { changes: 1 } };
            if (sql.includes("status = 'submitting'")) submission!.status = "submitting";
            if (sql.includes("status = 'needs-human'")) {
              submission!.status = "needs-human";
              submission!.message = String(values[0]);
            }
            return { meta: { changes: 1 } };
          },
        };
      },
    };
    const env = {
      DB: db,
      MODAL_WORKSPACE: "luminaflow-studio",
      MODAL_API_URL: "https://luminaflow-studio--comfy-desk-api.modal.run",
      MODAL_API_TOKEN: "secret",
      MODAL_BUDGET_CONFIRMED: "true",
    } as unknown as Env;
    const app = new Hono<UserContext>();
    app.use("*", async (c, next) => { c.set("ownerEmail", "owner@example.com"); await next(); });
    app.post("/resource", (c) => proxyMeteredModal(c, "/resources/models"));
    app.onError((error, c) => error instanceof CostApprovalError
      ? c.json({ message: error.message }, error.status)
      : c.json({ message: String(error) }, 500));
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network timeout"));

    const response = await app.request("/resource", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "download-request-1",
        "x-cost-approval": approvalToken,
      },
      body: JSON.stringify({
        repoId: "org/repo",
        repoFile: "model.safetensors",
        revision: "main",
        category: "checkpoints",
        filename: "model.safetensors",
      }),
    }, env);

    expect(response.status).toBe(503);
    expect(network).toHaveBeenCalledOnce();
    expect(submission).toMatchObject({ status: "needs-human" });
    expect(submission?.message).toContain("未自动重提");
  });
});

describe("metered Modal workflow descriptors", () => {
  function descriptorApp(modalPath: string) {
    const app = new Hono<UserContext>();
    app.use("*", async (c, next) => { c.set("ownerEmail", "owner@example.com"); await next(); });
    app.post("/descriptor", async (c) => c.json(await meteredModalDescriptor(c, modalPath)));
    app.onError((error, c) => error instanceof CostApprovalError
      ? c.json({ message: error.message }, error.status)
      : c.json({ message: String(error) }, 500));
    return app;
  }

  it("binds workflow upload approval to the server-observed multipart size envelope", async () => {
    const response = await descriptorApp("/workflows/analyze").request("/descriptor", {
      method: "POST",
      headers: {
        "x-cost-target": costTargets.workflowFile("actual.json"),
        "x-cost-file-bytes": "2048",
        "content-length": "2304",
      },
      body: "{}",
    }, {} as Env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      action: "workflow-analyze",
      target: costTargets.workflowFile("actual.json"),
      fileBytes: 2048,
      batchCount: 1,
    });
  });

  it("rejects workflow upload approvals whose declared bytes do not match the uploaded file", async () => {
    const response = await descriptorApp("/workflows/analyze").request("/descriptor", {
      method: "POST",
      headers: {
        "x-cost-target": costTargets.workflowFile("actual.json"),
        "x-cost-file-bytes": "1",
        "content-length": "20000",
      },
      body: "{}",
    }, {} as Env);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      message: "工作流费用批准与实际上传文件不匹配",
    });
  });

  it("routes stored workflow rechecks to the zero-byte stored workflow approval target", async () => {
    const workflowId = "c".repeat(32);
    const response = await descriptorApp(`/workflows/${workflowId}/recheck`).request("/descriptor", {
      method: "POST",
    }, {} as Env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      action: "workflow-analyze",
      target: costTargets.storedWorkflow(workflowId),
      fileBytes: 0,
      batchCount: 1,
    });
  });
});
