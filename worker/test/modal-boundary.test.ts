import { describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { modalHeaders, safeResponseMessage } from "../src/utils";

describe("Modal proxy boundary", () => {
  it("forwards only bounded content metadata and replaces caller credentials", () => {
    const headers = modalHeaders({ MODAL_API_TOKEN: "modal-secret" } as Env, {
      accept: "application/json",
      authorization: "Bearer caller-secret",
      cookie: "session=private",
      "cf-access-jwt-assertion": "access-secret",
      "content-type": "application/json",
      "x-cost-approval": "approval-secret",
    });

    expect(headers.get("authorization")).toBe("Bearer modal-secret");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("cf-access-jwt-assertion")).toBe(false);
    expect(headers.has("x-cost-approval")).toBe(false);
  });

  it("caps a remote error body before turning it into a message", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(70 * 1024)));
      },
      cancel() { cancelled = true; },
    });

    const message = await safeResponseMessage(new Response(body, { status: 500 }), "fallback");

    expect(message).toHaveLength(1_000);
    expect(cancelled).toBe(true);
  });
});
