import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { GpuQueue, pinnedWorkflowFields } from "../src/gpu-queue";

interface QueueState {
  data: Map<string, unknown>;
  setAlarm: ReturnType<typeof vi.fn>;
  state: DurableObjectState;
}

function queueState(initial: Record<string, unknown> = {}): QueueState {
  const data = new Map(Object.entries(initial));
  const setAlarm = vi.fn().mockResolvedValue(undefined);
  const storage = {
    get: vi.fn(async (key: string) => data.get(key)),
    put: vi.fn(async (key: string, value: unknown) => { data.set(key, value); }),
    delete: vi.fn(async (key: string) => data.delete(key)),
    setAlarm,
  };
  return { data, setAlarm, state: { storage } as unknown as DurableObjectState };
}

function queueEnv(nextRun: () => unknown = () => null) {
  const statement = {
    first: vi.fn(async () => nextRun()),
  };
  const queries: string[] = [];
  return {
    env: { DB: { prepare: vi.fn((sql: string) => { queries.push(sql); return statement; }) } } as unknown as Env,
    prepare: (statement as unknown as { first: ReturnType<typeof vi.fn> }).first,
    queries,
  };
}

describe("global GPU queue", () => {
  it("uses a Durable Object alarm instead of running work in the request", async () => {
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const queue = new GpuQueue({ storage: { setAlarm } } as unknown as DurableObjectState, {} as Env);

    const response = await queue.fetch(new Request("https://queue.internal/wake", { method: "POST" }));

    expect(response.status).toBe(202);
    expect(setAlarm).toHaveBeenCalledOnce();
    expect(setAlarm.mock.calls[0][0]).toBeGreaterThan(Date.now() - 1_000);
  });

  it("keeps non-Modal image tasks out of the GPU queue", async () => {
    const ctx = queueState();
    const { env, queries } = queueEnv();
    const queue = new GpuQueue(ctx.state, env);

    await queue.alarm();

    expect(queries.some((sql) => sql.includes("kind IN ('workflow', 'character')"))).toBe(true);
    expect(queries.some((sql) => sql.includes("modal_chat_jobs"))).toBe(true);
  });

  it("does not expose arbitrary Durable Object paths", async () => {
    const queue = new GpuQueue({ storage: {} } as unknown as DurableObjectState, {} as Env);
    const response = await queue.fetch(new Request("https://queue.internal/status"));
    expect(response.status).toBe(404);
  });

  it("does not retain the old direct LLM lease endpoints", async () => {
    const queue = new GpuQueue(queueState().state, {} as Env);
    const response = await queue.fetch(new Request("https://queue.internal/llm/acquire", { method: "POST" }));

    expect(response.status).toBe(404);
  });

  it("releases an expired manual-review guard even when Modal returned a job id", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T00:00:00Z"));
    const operationId = "a".repeat(32);
    const ctx = queueState({
      "active-gpu-task": {
        kind: "chat",
        id: operationId,
        modalCallId: "fc-existing",
        state: "needs-human",
        lastCheckedAt: Date.now() - 1_000,
        leaseExpiresAt: Date.now() - 1,
      },
    });
    let pending = true;
    const batchedSql: string[] = [];
    const prepare = vi.fn((sql: string) => {
      let values: unknown[] = [];
      return {
        sql,
        bind(...next: unknown[]) { values = next; return this; },
        async first() {
          if (sql.includes("SELECT kind, id, status FROM")) {
            return pending ? { kind: "chat", id: operationId, status: "needs-human" } : null;
          }
          if (sql.includes("SELECT * FROM modal_chat_jobs")) {
            return {
              operation_id: operationId,
              owner_email: "owner@example.com",
              thread_id: "thread-1",
              user_message_id: "b".repeat(32),
              assistant_message_id: "c".repeat(32),
              request_json: "{}",
              status: "needs-human",
              modal_job_id: "fc-existing",
              message: "任务状态不明确",
              poll_attempts: 1,
              lease_expires_at: Date.now() - 1,
              created_at: Date.now() - 60_000,
              updated_at: Date.now() - 1_000,
            };
          }
          return null;
        },
        async run() { return { meta: { changes: values.length ? 1 : 0 } }; },
      };
    });
    const batch = vi.fn(async (statements: Array<{ sql: string }>) => {
      batchedSql.push(...statements.map((statement) => statement.sql));
      pending = false;
      return statements.map(() => ({ success: true }));
    });
    const fetcher = vi.spyOn(globalThis, "fetch");
    const queue = new GpuQueue(ctx.state, { DB: { prepare, batch } } as unknown as Env);

    try {
      await queue.alarm();

      expect(fetcher).not.toHaveBeenCalled();
      expect(batchedSql.some((sql) => sql.includes("modal_chat_jobs SET status = 'failed'"))).toBe(true);
      expect(batchedSql.some((sql) => sql.includes("modal_submissions SET status = 'rejected'"))).toBe(true);
      expect(ctx.data.has("active-gpu-task")).toBe(false);
    } finally {
      fetcher.mockRestore();
      vi.useRealTimers();
    }
  });

  it("holds the global queue when a ComfyUI submission result is ambiguous", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-30T00:00:00Z"));
    const ctx = queueState();
    const updates: string[] = [];
    const prepare = vi.fn((sql: string) => {
      let values: unknown[] = [];
      return {
        bind(...next: unknown[]) { values = next; return this; },
        async first() {
          if (sql.includes("SELECT kind, id, status FROM")) {
            return { kind: "run", id: "run-1", status: "queued" };
          }
          if (sql.includes("SELECT * FROM runs")) {
            return {
              id: "run-1",
              owner_email: "owner@example.com",
              kind: "workflow",
              status: "queued",
              workflow_id: "workflow-1",
              workflow_revision_id: "revision-1",
              workflow_name: "Workflow",
              form_json: "{}",
              files_json: "[]",
              project_id: null,
              batch_id: null,
              view_id: null,
              modal_job_id: null,
              cancel_requested: 0,
              priority: 100,
              created_at: Date.now() - 1_000,
            };
          }
          return null;
        },
        async run() {
          updates.push(sql);
          return { meta: { changes: values.length ? 1 : 0 } };
        },
      };
    });
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection reset"));
    const env = {
      DB: { prepare },
      MODAL_WORKSPACE: "luminaflow-studio",
      MODAL_API_URL: "https://luminaflow-studio--comfy-desk-api.modal.run",
      MODAL_API_TOKEN: "secret",
    } as unknown as Env;
    const queue = new GpuQueue(ctx.state, env);

    try {
      await queue.alarm();

      expect(fetcher).toHaveBeenCalledOnce();
      expect(updates.some((sql) => sql.includes("UPDATE runs SET status = 'processing'"))).toBe(true);
      expect(ctx.data.get("active-gpu-task")).toMatchObject({
        kind: "run",
        id: "run-1",
        state: "needs-human",
      });
      expect(ctx.setAlarm).toHaveBeenCalledWith(Date.now() + 15 * 60 * 1_000 + 100);
    } finally {
      fetcher.mockRestore();
      vi.useRealTimers();
    }
  });

  it("pins Modal submissions to the revision recorded on the queued run", () => {
    expect(pinnedWorkflowFields({
      workflow_id: "stored-workflow",
      workflow_revision_id: "checked-revision",
      form_json: JSON.stringify({ workflowId: "overridden", workflowRevisionId: "newer", param_1_text: "portrait" }),
    })).toEqual({
      workflowId: "stored-workflow",
      workflowRevisionId: "checked-revision",
      param_1_text: "portrait",
    });
  });

  it("preserves imported outputs and finishes when a later Modal result is permanently unavailable", async () => {
    const ctx = queueState({
      "active-gpu-task": {
        kind: "run",
        id: "run-outputs",
        modalCallId: "modal-job",
        state: "processing",
        lastCheckedAt: Date.now(),
        leaseExpiresAt: Date.now() + 60_000,
      },
    });
    const executed: Array<{ sql: string; values: unknown[] }> = [];
    const batches: Array<Array<{ sql: string; values: unknown[] }>> = [];
    let nextTaskAvailable = true;
    const run = {
      id: "run-outputs",
      owner_email: "owner@example.com",
      kind: "workflow",
      status: "processing",
      workflow_id: "workflow-1",
      workflow_revision_id: "revision-1",
      workflow_name: "Workflow",
      form_json: "{}",
      files_json: "[]",
      project_id: null,
      batch_id: null,
      view_id: null,
      modal_job_id: "modal-job",
      cancel_requested: 0,
      priority: 100,
      message: null,
      created_at: Date.now() - 1_000,
    };
    const prepare = vi.fn((sql: string) => {
      let values: unknown[] = [];
      return {
        sql,
        get values() { return values; },
        bind(...next: unknown[]) { values = next; return this; },
        async first() {
          if (sql.includes("SELECT kind, id, status FROM")) {
            if (!nextTaskAvailable) return null;
            nextTaskAvailable = false;
            return { kind: "run", id: run.id, status: "processing" };
          }
          if (sql.includes("SELECT * FROM runs")) return run;
          if (sql.includes("SELECT o.object_key FROM run_outputs")) return null;
          if (sql.includes("COALESCE(SUM(bytes), 0)")) return { bytes: 0 };
          if (sql.includes("SELECT bytes FROM storage_objects")) return null;
          return null;
        },
        async run() {
          executed.push({ sql, values });
          return { meta: { changes: 1 } };
        },
      };
    });
    const batch = vi.fn(async (statements: Array<{ sql: string; values: unknown[] }>) => {
      batches.push(statements.map((statement) => ({ sql: statement.sql, values: statement.values })));
      return statements.map(() => ({ success: true }));
    });
    const put = vi.fn().mockResolvedValue({ size: 4 });
    const env = {
      DB: { prepare, batch },
      ASSETS_BUCKET: { put, head: vi.fn(), delete: vi.fn() },
      MODAL_WORKSPACE: "luminaflow-studio",
      MODAL_API_URL: "https://luminaflow-studio--comfy-desk-api.modal.run",
      MODAL_API_TOKEN: "secret",
      STORAGE_STOP_BYTES: "1000",
      R2_CLASS_A_STOP: "800000",
      R2_CLASS_B_STOP: "8000000",
    } as unknown as Env;
    const responses = [
      new Response(JSON.stringify({
        jobId: "modal-job",
        status: "succeeded",
        outputs: [
          { index: 0, filename: "first.png", mediaType: "image/png", bytes: 4 },
          { index: 1, filename: "second.png", mediaType: "image/png", bytes: 4 },
          { index: 2, filename: "third.png", mediaType: "image/png", bytes: 4 },
        ],
      }), { headers: { "content-type": "application/json" } }),
      new Response("one!", { headers: { "content-type": "image/png", "content-length": "4" } }),
      new Response("two!", { headers: { "content-type": "image/png", "content-length": "4" } }),
      new Response("result is no longer available", { status: 404 }),
    ];
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected Modal request");
      return response;
    });
    const queue = new GpuQueue(ctx.state, env);

    try {
      await queue.alarm();

      expect(put).toHaveBeenCalledTimes(2);
      expect(batches.flat().filter((statement) => statement.sql.includes("INSERT INTO run_outputs"))).toHaveLength(2);
      expect(executed.some((statement) => statement.sql.includes("UPDATE runs SET status = ?1") && statement.values[0] === "failed")).toBe(true);
      expect(ctx.data.has("active-gpu-task")).toBe(false);
      expect(ctx.setAlarm).not.toHaveBeenCalled();
    } finally {
      fetcher.mockRestore();
    }
  });
});
