import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { chatRoutes } from "../src/chat-routes";
import type { Env, UserContext } from "../src/env";

describe("Modal chat idempotency", () => {
  it("returns the existing operation without consuming another approval or waking the GPU queue", async () => {
    const operationId = "b".repeat(32);
    const prepare = vi.fn((sql: string) => {
      let values: unknown[] = [];
      return {
        bind(...next: unknown[]) { values = next; return this; },
        async first() {
          if (sql.includes("FROM chat_threads")) {
            return {
              id: String(values[0]),
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
          if (sql.includes("FROM modal_submissions")) {
            return { id: operationId, status: "submitting", message: null };
          }
          return null;
        },
        async all() { return { results: [] }; },
      };
    });
    const gpuGet = vi.fn();
    const env = {
      DB: { prepare },
      GPU_QUEUE: { get: gpuGet },
    } as unknown as Env;
    const app = new Hono<UserContext>();
    app.use("*", async (c, next) => { c.set("ownerEmail", "owner@example.com"); await next(); });
    app.route("/", chatRoutes);

    const response = await app.request("/api/chat/threads/thread-1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "same-request-123" },
      body: JSON.stringify({ content: "front portrait" }),
    }, env);

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ operationId, status: "submitting" });
    expect(gpuGet).not.toHaveBeenCalled();
    expect(prepare.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO modal_submissions"))).toBe(false);
  });
});
