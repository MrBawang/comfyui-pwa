import { afterEach, describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import type { Env } from "../src/env";

describe("local Worker health", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reports configuration without making a Modal network request", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    const env = {
      APP_ENV: "development",
      DEV_USER_EMAIL: "owner@example.com",
      MODAL_WORKSPACE: "luminaflow-studio",
      MODAL_API_URL: "https://luminaflow-studio--comfy-desk-api.modal.run",
      MODAL_API_TOKEN: "secret",
      MODAL_BUDGET_CONFIRMED: "false",
    } as unknown as Env;

    const response = await worker.fetch(
      new Request("https://studio.example/api/health"),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "ready",
      modalWorkspace: "luminaflow-studio",
      modalEndpointValid: true,
      modalBudgetConfirmed: false,
    });
    expect(network).not.toHaveBeenCalled();
  });

  it("reports a workspace mismatch without probing Modal", async () => {
    const network = vi.spyOn(globalThis, "fetch");
    const env = {
      APP_ENV: "development",
      DEV_USER_EMAIL: "owner@example.com",
      MODAL_WORKSPACE: "luminaflow-studio",
      MODAL_API_URL: "https://mrbawang--comfy-desk-api.modal.run",
      MODAL_API_TOKEN: "secret",
    } as unknown as Env;

    const response = await worker.fetch(
      new Request("https://studio.example/api/config"),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      modalConfigured: true,
      modalWorkspace: "luminaflow-studio",
      modalEndpointValid: false,
    });
    expect(network).not.toHaveBeenCalled();
  });
});
