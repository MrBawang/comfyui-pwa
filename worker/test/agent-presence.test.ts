import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { coreRoutes } from "../src/core-routes";
import type { Env, UserContext } from "../src/env";

function appWithDb(first: (sql: string) => unknown) {
  const sql: string[] = [];
  const DB = {
    prepare: vi.fn((statement: string) => {
      sql.push(statement);
      return {
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockImplementation(() => first(statement)),
        run: vi.fn().mockResolvedValue({ success: true }),
      };
    }),
  };
  const app = new Hono<UserContext>();
  app.use("*", async (c, next) => {
    c.set("ownerEmail", "owner@example.com");
    await next();
  });
  app.route("/", coreRoutes);
  return { app, bindings: { DB } as unknown as Env, sql };
}

describe("PC Agent presence", () => {
  it("reports a recent Agent heartbeat as online", async () => {
    const { app, bindings } = appWithDb((sql) => sql.includes("FROM agent_presence")
      ? { agent_id: "studio-pc", last_seen_at: Date.now() }
      : undefined);

    const response = await app.request("/api/agent-status", {}, bindings);

    expect(await response.json()).toMatchObject({ status: "online", agentId: "studio-pc" });
  });

  it("records presence even when no screening task is waiting", async () => {
    const { app, bindings, sql } = appWithDb(() => undefined);

    const response = await app.request("/api/agent/v1/tasks/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "studio-pc" }),
    }, bindings);

    expect(response.status).toBe(204);
    expect(sql.some((statement) => statement.includes("INSERT INTO agent_presence"))).toBe(true);
  });

  it("rejects completion reports that omit candidates from the leased batch", async () => {
    const taskId = "a".repeat(32);
    const firstCandidate = "b".repeat(32);
    const secondCandidate = "c".repeat(32);
    const batch = vi.fn();
    const DB = {
      prepare: vi.fn((sql: string) => ({
        bind: vi.fn().mockReturnThis(),
        first: vi.fn().mockResolvedValue(sql.includes("status = 'leased'")
          ? { id: taskId, project_id: "d".repeat(32), batch_id: "e".repeat(32), attempts: 1, agent_id: "pc" }
          : undefined),
        all: vi.fn().mockResolvedValue(sql.includes("SELECT id FROM candidates")
          ? { results: [{ id: firstCandidate }, { id: secondCandidate }] }
          : { results: [] }),
        run: vi.fn().mockResolvedValue({ success: true }),
      })),
      batch,
    };
    const app = new Hono<UserContext>();
    app.route("/", coreRoutes);

    const response = await app.request(`/api/agent/v1/tasks/${taskId}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        leaseToken: "lease",
        report: { stats: { total: 1 } },
        candidates: [{ id: firstCandidate, kept: true }],
      }),
    }, { DB } as unknown as Env);

    expect(response.status).toBe(400);
    expect(batch).not.toHaveBeenCalled();
  });
});
