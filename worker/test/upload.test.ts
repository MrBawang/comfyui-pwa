import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { coreRoutes } from "../src/core-routes";
import type { Env, UserContext } from "../src/env";

function uploadApp(usedBytes: number, put: ReturnType<typeof vi.fn>) {
  const app = new Hono<UserContext>();
  app.use("*", async (c, next) => {
    c.set("ownerEmail", "owner@example.com");
    await next();
  });
  app.route("/", coreRoutes);
  const statement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue({ bytes: usedBytes }),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
  };
  const bindings = {
    DB: { prepare: vi.fn(() => statement) },
    ASSETS_BUCKET: {
      put,
      delete: vi.fn().mockResolvedValue(undefined),
    },
    STORAGE_STOP_BYTES: "1000",
    R2_CLASS_A_STOP: "800000",
    R2_CLASS_B_STOP: "8000000",
  } as unknown as Env;
  return { app, bindings };
}

describe("streamed R2 uploads", () => {
  it("rejects uploads without a trustworthy declared size", async () => {
    const put = vi.fn();
    const { app, bindings } = uploadApp(0, put);

    const response = await app.request("/api/uploads", {
      method: "POST",
      headers: { "content-type": "image/png" },
    }, bindings);

    expect(response.status).toBe(413);
    expect(put).not.toHaveBeenCalled();
  });

  it("blocks a file before R2 write when it crosses the storage line", async () => {
    const put = vi.fn();
    const { app, bindings } = uploadApp(995, put);

    const response = await app.request("/api/uploads", {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "x-file-name": "portrait.png",
        "x-file-size": "5",
      },
      body: new Uint8Array([1, 2, 3, 4, 5]),
    }, bindings);

    expect(response.status).toBe(507);
    expect(put).not.toHaveBeenCalled();
  });

  it("passes the request body stream directly to R2", async () => {
    const put = vi.fn(async (_key: string, body: ReadableStream<Uint8Array>) => {
      const bytes = await new Response(body).arrayBuffer();
      return { size: bytes.byteLength };
    });
    const { app, bindings } = uploadApp(0, put);

    const response = await app.request("/api/uploads", {
      method: "POST",
      headers: {
        "content-type": "image/png",
        "x-file-name": encodeURIComponent("人物.png"),
        "x-file-size": "5",
      },
      body: new Uint8Array([1, 2, 3, 4, 5]),
    }, bindings);

    expect(response.status).toBe(201);
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0][1]).toBeInstanceOf(ReadableStream);
    expect(await response.json()).toMatchObject({ bytes: 5, mediaType: "image/png" });
  });
});
