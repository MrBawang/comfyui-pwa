import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import type { Env, UserContext } from "../src/env";
import { storageBrowserRoutes } from "../src/storage-browser";

async function passwordHash(password: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function testApp() {
  const app = new Hono<UserContext>();
  app.use("*", async (c, next) => {
    c.set("ownerEmail", c.req.header("x-test-owner") || "owner@example.com");
    await next();
  });
  app.route("/", storageBrowserRoutes);
  return app;
}

function testEnv(hash: string) {
  let attempts: { failed_attempts: number; locked_until: number } | undefined;
  const prepare = vi.fn((sql: string) => {
    let parameters: unknown[] = [];
    const statement = {
      bind: vi.fn((...values: unknown[]) => {
        parameters = values;
        return statement;
      }),
      first: vi.fn(async () => {
        if (sql.includes("SELECT failed_attempts, locked_until")) return attempts;
        if (sql.includes("INSERT INTO r2_browser_auth_attempts")) {
          const timestamp = Number(parameters[1]);
          const maximum = Number(parameters[2]);
          const lockUntil = Number(parameters[3]);
          if (attempts?.locked_until && attempts.locked_until <= timestamp) {
            attempts = { failed_attempts: 1, locked_until: 0 };
          } else {
            const failedAttempts = (attempts?.failed_attempts ?? 0) + 1;
            attempts = { failed_attempts: failedAttempts, locked_until: failedAttempts >= maximum ? lockUntil : 0 };
          }
          return attempts;
        }
        return undefined;
      }),
      run: vi.fn(async () => {
        if (sql.includes("DELETE FROM r2_browser_auth_attempts")) attempts = undefined;
        return { success: true, meta: { changes: 1 } };
      }),
    };
    return statement;
  });
  const list = vi.fn().mockResolvedValue({
    objects: [{
      key: "outputs/portrait.png",
      size: 1_024,
      uploaded: new Date("2026-07-29T05:00:00Z"),
      httpMetadata: { contentType: "image/png" },
      storageClass: "Standard",
    }],
    delimitedPrefixes: ["uploads/"],
    truncated: false,
  });
  const get = vi.fn().mockResolvedValue({
    key: "unsafe.html",
    size: 13,
    uploaded: new Date("2026-07-29T05:00:00Z"),
    httpMetadata: { contentType: "text/html" },
    httpEtag: '"etag"',
    body: new Blob(["<h1>test</h1>"]).stream(),
  });
  return {
    bindings: {
      DB: { prepare },
      ASSETS_BUCKET: { list, get },
      R2_BROWSER_PASSWORD_SHA256: hash,
      R2_CLASS_A_STOP: "800000",
      R2_CLASS_B_STOP: "8000000",
    } as Env,
    list,
    get,
  };
}

async function unlockCookie(app: Hono<UserContext>, bindings: Env, password = "correct-password") {
  const response = await app.request("/api/r2-browser/unlock", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  }, bindings);
  return { response, cookie: response.headers.get("set-cookie")?.split(";", 1)[0] ?? "" };
}

describe("password-protected R2 browser", () => {
  it("does not touch R2 before the second password is unlocked", async () => {
    const app = testApp();
    const { bindings, list } = testEnv(await passwordHash("correct-password"));

    const response = await app.request("/api/r2-browser/objects", {}, bindings);

    expect(response.status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  it("issues a host-only session and lists one directory page", async () => {
    const app = testApp();
    const { bindings, list } = testEnv(await passwordHash("correct-password"));
    const { response: unlock, cookie } = await unlockCookie(app, bindings);

    expect(unlock.status).toBe(200);
    expect(unlock.headers.get("set-cookie")).toContain("__Host-r2-browser=");
    expect(unlock.headers.get("set-cookie")).toContain("HttpOnly");
    expect(unlock.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(unlock.headers.get("set-cookie")).not.toContain("Domain=");
    expect(unlock.headers.get("cache-control")).toBe("private, no-store");

    const response = await app.request("/api/r2-browser/objects?prefix=", {
      headers: { cookie },
    }, bindings);
    const body = await response.json() as { prefixes: unknown[]; objects: Array<{ previewable: boolean }> };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ delimiter: "/", limit: 100 }));
    expect(body.prefixes).toHaveLength(1);
    expect(body.objects[0].previewable).toBe(true);
  });

  it("locks the owner for fifteen minutes on the fifth failure", async () => {
    const app = testApp();
    const { bindings } = testEnv(await passwordHash("correct-password"));

    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const { response } = await unlockCookie(app, bindings, "wrong-password");
      expect(response.status).toBe(401);
    }
    const { response } = await unlockCookie(app, bindings, "wrong-password");

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("900");
  });

  it("forces non-previewable HTML objects to download", async () => {
    const app = testApp();
    const { bindings, get } = testEnv(await passwordHash("correct-password"));
    const { cookie } = await unlockCookie(app, bindings);

    const response = await app.request("/api/r2-browser/object?key=unsafe.html&mode=inline", {
      headers: { cookie },
    }, bindings);

    expect(response.status).toBe(200);
    expect(get).toHaveBeenCalledWith("unsafe.html");
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("binds a valid session to the Access owner", async () => {
    const app = testApp();
    const { bindings, list } = testEnv(await passwordHash("correct-password"));
    const { cookie } = await unlockCookie(app, bindings);

    const response = await app.request("/api/r2-browser/objects", {
      headers: { cookie, "x-test-owner": "other@example.com" },
    }, bindings);

    expect(response.status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });
});
