import { describe, expect, it, vi } from "vitest";

import {
  abortProviderOnResponseCancel,
  consumeProviderStream,
  estimatedTokens,
  fitsChatContext,
  modelMessages,
  reserveWorkersAi,
  workersAiStream,
} from "../src/chat-routes";
import type { Env } from "../src/env";

function message(id: string, content: string, role: "user" | "assistant" = "user") {
  return {
    id,
    thread_id: "thread",
    role,
    content,
    provider_id: null,
    created_at: Number(id),
  } as const;
}

describe("chat context and streaming", () => {
  it("budgets Chinese text conservatively for the 16K context", () => {
    expect(estimatedTokens("abcd中文")).toBe(3);
    const history = [message("1", "旧".repeat(3_000)), message("2", "新".repeat(2_000))];
    const result = modelMessages("系".repeat(10_000), history);

    expect(result.map((item) => item.content)).toEqual(["系".repeat(10_000), "新".repeat(2_000)]);
    expect(fitsChatContext("系".repeat(10_000), "新".repeat(3_500))).toBe(true);
    expect(fitsChatContext("系".repeat(10_000), "新".repeat(3_501))).toBe(false);
  });

  it("parses both Workers AI and OpenAI-compatible SSE records", async () => {
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"response":"你"}\n'));
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"好"}}]}\n\ndata: [DONE]\n\n'));
        controller.close();
      },
    });
    const chunks: string[] = [];

    await consumeProviderStream(source, async (content) => { chunks.push(content); });

    expect(chunks.join("")).toBe("你好");
  });

  it("cancels the provider stream when the downstream consumer disconnects", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"response":"chunk"}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(consumeProviderStream(source, async () => {
      throw new Error("client disconnected");
    })).rejects.toThrow("client disconnected");
    expect(cancelled).toBe(true);
  });

  it("aborts an in-flight provider request when the response consumer disconnects", async () => {
    const source = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise(() => undefined);
      },
    });
    const providerAbort = new AbortController();
    const response = abortProviderOnResponseCancel(source, providerAbort);

    await response.cancel("browser closed");

    expect(providerAbort.signal.aborted).toBe(true);
    expect(providerAbort.signal.reason).toBe("browser closed");
  });

  it("passes the downstream cancellation signal to Workers AI", async () => {
    const source = new ReadableStream<Uint8Array>();
    const run = vi.fn().mockResolvedValue(source);
    const env = {
      AI: { run },
      WORKERS_AI_MODEL: "@cf/qwen/qwen3-30b-a3b-fp8",
    } as unknown as Env;
    const controller = new AbortController();

    await expect(workersAiStream(env, [{ role: "user", content: "test" }], 32, 0.5, controller.signal))
      .resolves.toBe(source);
    expect(run).toHaveBeenCalledWith(env.WORKERS_AI_MODEL, {
      messages: [{ role: "user", content: "test" }],
      stream: true,
      max_tokens: 32,
      temperature: 0.5,
    }, { signal: controller.signal });
  });

  it("refuses Workers AI before inference when the worst-case reservation crosses the hard stop", async () => {
    const run = vi.fn().mockResolvedValue({ meta: { changes: 0 } });
    const statement = { bind: vi.fn().mockReturnThis(), run };
    const env = {
      DB: { prepare: vi.fn(() => statement) },
      WORKERS_AI_STOP_NEURONS: "9000",
      AI: { run: vi.fn() },
    } as unknown as Env;

    await expect(reserveWorkersAi(env, "owner@example.com", [{ content: "portrait" }], 2_048))
      .rejects.toThrow("不会自动切换或唤醒 Modal");
    expect(env.AI.run).not.toHaveBeenCalled();
  });
});
