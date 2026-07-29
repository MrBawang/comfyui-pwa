import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Env, UserContext } from "../src/env";
import { wisartRoutes, WisartQueue } from "../src/wisart";

function app() {
  const value = new Hono<UserContext>();
  value.use("*", async (c, next) => {
    c.set("ownerEmail", "owner@example.com");
    await next();
  });
  value.route("/", wisartRoutes);
  return value;
}

function env(overrides: Partial<Env> = {}) {
  return {
    WISART_API_URL: "https://wisart.example.com",
    WISART_API_KEY: "relay-secret",
    WISART_DEFAULT_MODEL: "nano-banana-2",
    ...overrides,
  } as Env;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("WisArt image relay", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports availability without exposing the API key", async () => {
    const response = await app().request("/api/images/config", {}, env());
    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toEqual({ configured: true, defaultModel: "nano-banana-2", maxReferenceImages: 16 });
    expect(JSON.stringify(body)).not.toContain("relay-secret");
  });

  it("falls back to the OpenAI models endpoint and keeps authorization server-side", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      expect(request.headers.get("authorization")).toBe("Bearer relay-secret");
      if (request.url.endsWith("/api/image-models")) {
        return new Response("<html>not an API</html>", { status: 200, headers: { "content-type": "text/html" } });
      }
      expect(request.url).toBe("https://wisart.example.com/v1/models");
      return Response.json({ data: [{ id: "model-a" }, { id: "model-b" }] });
    });

    const response = await app().request("/api/images/models", {}, env());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      defaultModel: "nano-banana-2",
      models: [{ id: "model-a", label: "model-a" }, { id: "model-b", label: "model-b" }],
    });
    expect(network).toHaveBeenCalledTimes(2);
  });

  it("rejects an insecure relay base URL before making a network request", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    const response = await app().request("/api/images/models", {}, env({ WISART_API_URL: "http://wisart.example.com" }));
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ message: "WISART_API_URL 必须是无查询参数的 HTTPS 地址" });
    expect(network).not.toHaveBeenCalled();
  });

  it("accepts an approved generation immediately without calling the relay in the HTTP request", async () => {
    const quoteId = "a".repeat(32);
    const approvalToken = `${quoteId}.${"b".repeat(64)}`;
    const target = "wisart:generate:nano-banana-2:auto:auto:1";
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    const db = {
      prepare: vi.fn((sql: string) => {
        const entry = { sql, args: [] as unknown[] };
        statements.push(entry);
        const statement = {
          bind: (...args: unknown[]) => { entry.args = args; return statement; },
          first: async () => {
            if (sql.includes("FROM runs WHERE owner_email")) return null;
            if (sql.includes("FROM cost_quotes")) {
              return {
                id: quoteId,
                owner_email: "owner@example.com",
                action: "wisart-image",
                target,
                target_hash: await sha256(target),
                file_bytes: 0,
                batch_count: 1,
                label: "中转站生成图片",
                description: "test",
                max_duration_seconds: 900,
                estimated_max_usd: 0,
                status: "approved",
                approval_token_hash: await sha256(approvalToken),
                quote_expires_at: Date.now() + 60_000,
                approval_expires_at: Date.now() + 60_000,
              };
            }
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ success: true, meta: { changes: 1 } }),
        };
        return statement;
      }),
      batch: vi.fn(async (batch: Array<{ run: () => Promise<unknown> }>) => Promise.all(batch.map((statement) => statement.run()))),
    };
    const wake = vi.fn().mockResolvedValue(Response.json({ ok: true }, { status: 202 }));
    const network = vi.spyOn(globalThis, "fetch");
    const response = await app().request("/api/images/generate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "image-request-123",
        "x-cost-approval": approvalToken,
      },
      body: JSON.stringify({
        runId: "c".repeat(32),
        mode: "generate",
        prompt: "portrait",
        model: "nano-banana-2",
        size: "auto",
        quality: "auto",
        n: 1,
      }),
    }, env({
      DB: db as unknown as D1Database,
      WISART_QUEUE: {
        idFromName: vi.fn(() => ({}) as DurableObjectId),
        get: vi.fn(() => ({ fetch: wake })),
      } as unknown as DurableObjectNamespace,
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ jobId: "c".repeat(32), status: "queued" });
    expect(wake).toHaveBeenCalledOnce();
    expect(network).not.toHaveBeenCalled();
    expect(statements.some((entry) => entry.sql.includes("status = 'consumed'"))).toBe(true);
  });

  it("wakes a Durable Object alarm instead of generating inside the browser request", async () => {
    const setAlarm = vi.fn().mockResolvedValue(undefined);
    const queue = new WisartQueue({ storage: { setAlarm } } as unknown as DurableObjectState, {} as Env);

    const response = await queue.fetch(new Request("https://wisart-queue.internal/wake", { method: "POST" }));

    expect(response.status).toBe(202);
    expect(setAlarm).toHaveBeenCalledOnce();
  });

  it("does not resubmit an interrupted processing task", async () => {
    const statements: Array<{ sql: string; args: unknown[] }> = [];
    let returnedUncertain = false;
    const db = {
      prepare: vi.fn((sql: string) => {
        const entry = { sql, args: [] as unknown[] };
        statements.push(entry);
        const statement = {
          bind: (...args: unknown[]) => { entry.args = args; return statement; },
          first: async () => {
            if (sql.includes("status = 'processing'") && !returnedUncertain) {
              returnedUncertain = true;
              return {
                id: "a".repeat(32),
                owner_email: "owner@example.com",
                status: "processing",
                workflow_name: "中转站",
                message: "生成中",
                form_json: "{}",
                files_json: "[]",
                created_at: 1,
                updated_at: 1,
              };
            }
            return null;
          },
          run: async () => ({ success: true, meta: { changes: 1 } }),
        };
        return statement;
      }),
      batch: vi.fn().mockResolvedValue([]),
    };
    const network = vi.spyOn(globalThis, "fetch");
    const queue = new WisartQueue({ storage: { setAlarm: vi.fn() } } as unknown as DurableObjectState, {
      DB: db,
      ASSETS_BUCKET: { list: vi.fn().mockResolvedValue({ objects: [], truncated: false }) },
      R2_CLASS_A_STOP: "800000",
      R2_CLASS_B_STOP: "8000000",
    } as unknown as Env);

    await queue.alarm();

    expect(network).not.toHaveBeenCalled();
    const failure = statements.find((entry) => entry.sql.includes("status = 'failed'"));
    expect(String(failure?.args[0])).toContain("未自动重提");
  });
});
