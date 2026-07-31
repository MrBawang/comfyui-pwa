import { describe, expect, it } from "vitest";

import type { Env } from "../src/env";
import { modalBase, modalEndpointStatus, modalHeaders, modalLlmBase, safeResponseMessage } from "../src/utils";

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

  it("accepts only the configured ComfyUI endpoint in the locked workspace", () => {
    const valid = {
      MODAL_WORKSPACE: "luminaflow-studio",
      MODAL_API_URL: "https://luminaflow-studio--comfy-desk-api.modal.run/",
      MODAL_API_TOKEN: "secret",
    } as Env;
    const mismatched = { ...valid, MODAL_API_URL: "https://mrbawang--comfy-desk-api.modal.run" };

    expect(modalEndpointStatus(valid)).toMatchObject({ workspace: "luminaflow-studio", configured: true, valid: true });
    expect(modalBase(valid)).toBe("https://luminaflow-studio--comfy-desk-api.modal.run");
    expect(modalEndpointStatus(mismatched).valid).toBe(false);
    expect(() => modalBase(mismatched)).toThrow("不属于已锁定的 luminaflow-studio Workspace");
  });

  it("accepts only the CPU Qwen control plane in the locked workspace", () => {
    const valid = {
      MODAL_WORKSPACE: "luminaflow-studio",
      MODAL_LLM_URL: "https://luminaflow-studio--lorachef-qwen36-api.modal.run/",
    } as Env;

    expect(modalLlmBase(valid)).toBe("https://luminaflow-studio--lorachef-qwen36-api.modal.run");
    expect(() => modalLlmBase({
      ...valid,
      MODAL_LLM_URL: "https://luminaflow-studio--lorachef-qwen36-qwenserver-serve.modal.run",
    })).toThrow("lorachef-qwen36 API 端点");
    expect(() => modalLlmBase({
      ...valid,
      MODAL_LLM_URL: "https://mrbawang--lorachef-qwen36-api.modal.run",
    })).toThrow("lorachef-qwen36 API 端点");
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
