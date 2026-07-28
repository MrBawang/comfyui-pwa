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
      MODAL_API_URL: "https://modal.example",
      MODAL_API_TOKEN: "secret",
      MODAL_BUDGET_CONFIRMED: "false",
    } as unknown as Env;

    const response = await worker.fetch(
      new Request("https://studio.example/api/health"),
      env,
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ready", modalBudgetConfirmed: false });
    expect(network).not.toHaveBeenCalled();
  });
});
