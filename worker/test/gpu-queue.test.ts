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

function request(path: string, leaseId: string) {
  return new Request(`https://queue.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ leaseId }),
  });
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
  });

  it("does not expose arbitrary Durable Object paths", async () => {
    const queue = new GpuQueue({ storage: {} } as unknown as DurableObjectState, {} as Env);
    const response = await queue.fetch(new Request("https://queue.internal/status"));
    expect(response.status).toBe(404);
  });

  it("grants only one active Modal LLM lease", async () => {
    const ctx = queueState();
    const { env } = queueEnv();
    const queue = new GpuQueue(ctx.state, env);

    const granted = await queue.fetch(request("/llm/acquire", "a".repeat(32)));
    const rejected = await queue.fetch(request("/llm/acquire", "b".repeat(32)));

    expect(granted.status).toBe(201);
    expect(rejected.status).toBe(409);
    expect(ctx.data.get("modal-llm-lease")).toMatchObject({ id: "a".repeat(32) });
  });

  it("rejects an LLM lease when a ComfyUI run is queued", async () => {
    const ctx = queueState();
    const { env } = queueEnv(() => ({ id: "run-1", status: "queued" }));
    const queue = new GpuQueue(ctx.state, env);

    const response = await queue.fetch(request("/llm/acquire", "a".repeat(32)));

    expect(response.status).toBe(409);
    expect(ctx.data.has("modal-llm-lease")).toBe(false);
  });

  it("ignores a foreign release and wakes queued work after the matching release", async () => {
    let pendingRun: unknown = null;
    const ctx = queueState();
    const { env } = queueEnv(() => pendingRun);
    const queue = new GpuQueue(ctx.state, env);
    await queue.fetch(request("/llm/acquire", "a".repeat(32)));
    pendingRun = { id: "run-1", status: "queued" };

    await queue.fetch(request("/llm/release", "b".repeat(32)));
    expect(ctx.data.has("modal-llm-lease")).toBe(true);
    expect(ctx.setAlarm).not.toHaveBeenCalled();

    await queue.fetch(request("/llm/release", "a".repeat(32)));
    expect(ctx.data.has("modal-llm-lease")).toBe(false);
    expect(ctx.setAlarm).toHaveBeenCalledOnce();
  });

  it("recovers from an expired LLM lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T00:00:00Z"));
    try {
      const ctx = queueState({ "modal-llm-lease": { id: "a".repeat(32), expiresAt: Date.now() - 1 } });
      const { env } = queueEnv();
      const queue = new GpuQueue(ctx.state, env);

      const response = await queue.fetch(request("/llm/acquire", "b".repeat(32)));

      expect(response.status).toBe(201);
      expect(ctx.data.get("modal-llm-lease")).toMatchObject({ id: "b".repeat(32) });
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers ComfyUI alarms until the active LLM lease expires", async () => {
    const expiresAt = Date.now() + 60_000;
    const ctx = queueState({ "modal-llm-lease": { id: "a".repeat(32), expiresAt } });
    const { env, prepare } = queueEnv(() => ({ id: "run-1", status: "queued" }));
    const queue = new GpuQueue(ctx.state, env);

    await queue.alarm();

    expect(prepare).not.toHaveBeenCalled();
    expect(ctx.setAlarm).toHaveBeenCalledWith(expiresAt + 100);
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
});
