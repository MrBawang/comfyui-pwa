import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

const approvalMocks = vi.hoisted(() => ({
  consume: vi.fn(async () => ({ quoteId: "quote-1", targetHash: "target-hash" })),
}));

vi.mock("../src/cost-approval", async () => {
  const actual = await vi.importActual<typeof import("../src/cost-approval")>("../src/cost-approval");
  return { ...actual, consumeCostApproval: approvalMocks.consume };
});

import { chatRoutes } from "../src/chat-routes";
import type { Env, UserContext } from "../src/env";

describe("Modal chat queue submission", () => {
  it("persists and queues a new request without fetching Modal in the HTTP request", async () => {
    let queuedJob: Record<string, unknown> | undefined;
    const prepare = vi.fn((sql: string) => {
      let values: unknown[] = [];
      const statement = {
        sql,
        bind(...next: unknown[]) { values = next; return statement; },
        async first() {
          if (sql.includes("FROM chat_threads")) {
            return {
              id: "thread-1",
              title: "Prompt",
              mode: "prompt",
              provider_id: "modal-qwen36",
              workflow_id: null,
              workflow_revision_id: null,
              target_field_name: null,
              system_prompt_preset_id: null,
              system_prompt_version: null,
              system_prompt_override: "Return one prompt.",
              created_at: 1,
              updated_at: 1,
            };
          }
          if (sql.includes("FROM modal_submissions")) return null;
          if (sql.includes("FROM modal_chat_jobs") && sql.includes("WHERE thread_id")) return null;
          if (sql.includes("FROM modal_chat_jobs") && sql.includes("WHERE operation_id")) return queuedJob;
          return null;
        },
        async all() { return { results: [] }; },
        async run() {
          if (sql.includes("INSERT INTO modal_chat_jobs")) {
            queuedJob = {
              operation_id: String(values[0]),
              thread_id: String(values[2]),
              assistant_message_id: String(values[4]),
              status: "queued",
              message: "等待 Modal GPU 队列",
              created_at: Number(values[6]),
              updated_at: Number(values[6]),
            };
          }
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    });
    const batch = vi.fn(async (statements: Array<{ run(): Promise<unknown> }>) => {
      for (const statement of statements) await statement.run();
      return statements.map(() => ({ success: true }));
    });
    const wake = vi.fn().mockResolvedValue(Response.json({ ok: true }, { status: 202 }));
    const env = {
      DB: { prepare, batch },
      GPU_QUEUE: { idFromName: vi.fn(() => "global-id"), get: vi.fn(() => ({ fetch: wake })) },
      MODAL_WORKSPACE: "luminaflow-studio",
      MODAL_LLM_URL: "https://luminaflow-studio--lorachef-qwen36-api.modal.run",
      MODAL_LLM_TOKEN: "secret",
    } as unknown as Env;
    const app = new Hono<UserContext>();
    app.use("*", async (c, next) => { c.set("ownerEmail", "owner@example.com"); await next(); });
    app.route("/", chatRoutes);
    const modalFetch = vi.spyOn(globalThis, "fetch");

    try {
      const response = await app.request("/api/chat/threads/thread-1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "new-modal-message-1",
          "x-cost-approval": `${"a".repeat(32)}.${"b".repeat(64)}`,
        },
        body: JSON.stringify({ content: "front portrait" }),
      }, env, { waitUntil: vi.fn() } as unknown as ExecutionContext);

      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({ operation: { status: "queued" } });
      expect(approvalMocks.consume).toHaveBeenCalledOnce();
      expect(wake).toHaveBeenCalledOnce();
      expect(modalFetch).not.toHaveBeenCalled();
    } finally {
      modalFetch.mockRestore();
    }
  });
});
