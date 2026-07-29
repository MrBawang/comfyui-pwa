import { describe, expect, it, vi } from "vitest";

import type { Env } from "../src/env";
import { r2Get, r2List, r2Put, R2BudgetError } from "../src/r2-budget";

function env(changes: number) {
  const run = vi.fn().mockResolvedValue({ meta: { changes } });
  const statement = { bind: vi.fn().mockReturnThis(), run };
  return {
    DB: { prepare: vi.fn(() => statement) },
    ASSETS_BUCKET: { get: vi.fn(), list: vi.fn(), put: vi.fn() },
    R2_CLASS_A_STOP: "800000",
    R2_CLASS_B_STOP: "8000000",
  } as unknown as Env;
}

describe("R2 operation hard stops", () => {
  it("blocks the object operation when the atomic reservation fails", async () => {
    const bindings = env(0);
    await expect(r2Put(bindings, "key", "value")).rejects.toBeInstanceOf(R2BudgetError);
    expect(bindings.ASSETS_BUCKET.put).not.toHaveBeenCalled();
  });

  it("records Class B before reading an object", async () => {
    const bindings = env(1);
    await r2Get(bindings, "key");
    expect(bindings.ASSETS_BUCKET.get).toHaveBeenCalledWith("key");
  });

  it("records Class A before listing a directory", async () => {
    const bindings = env(1);
    await r2List(bindings, { prefix: "outputs/", delimiter: "/" });
    expect(bindings.ASSETS_BUCKET.list).toHaveBeenCalledWith({ prefix: "outputs/", delimiter: "/" });
  });
});
