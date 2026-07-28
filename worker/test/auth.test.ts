import { Hono } from "hono";
import { sign } from "hono/jwt";
import { describe, expect, it, vi } from "vitest";

import { requireAgent, requireUser } from "../src/auth";
import type { Env, UserContext } from "../src/env";

function env(values: Partial<Env>): Env {
  return values as Env;
}

describe("Cloudflare authentication", () => {
  it("accepts and normalizes the Access identity", async () => {
    const origin = "https://auth-test.cloudflareaccess.com";
    const pair = await crypto.subtle.generateKey({
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    }, true, ["sign", "verify"]);
    const privateKey = { ...(await crypto.subtle.exportKey("jwk", pair.privateKey)), kid: "test-key", alg: "RS256" };
    const publicKey = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "test-key", alg: "RS256" };
    const token = await sign({
      iss: origin,
      aud: ["access-audience"],
      email: "Owner@Example.COM",
      exp: Math.floor(Date.now() / 1_000) + 60,
    }, privateKey, "RS256");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ keys: [publicKey] }));
    const app = new Hono<UserContext>();
    app.use("*", requireUser);
    app.get("/", (c) => c.text(c.get("ownerEmail")));

    const response = await app.request("/", {
      headers: {
        "cf-access-jwt-assertion": token,
        "cf-access-authenticated-user-email": " Owner@Example.COM ",
      },
    }, env({
      APP_ENV: "production",
      CF_ACCESS_TEAM_DOMAIN: "auth-test.cloudflareaccess.com",
      CF_ACCESS_AUD: "access-audience",
    }));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("owner@example.com");
    expect(fetchMock).toHaveBeenCalledWith(`${origin}/cdn-cgi/access/certs`);
    fetchMock.mockRestore();
  });

  it("never uses the local development identity in production", async () => {
    const app = new Hono<UserContext>();
    app.use("*", requireUser);
    app.get("/", (c) => c.text(c.get("ownerEmail")));

    const response = await app.request("/", {}, env({
      APP_ENV: "production",
      DEV_USER_EMAIL: "owner@example.com",
    }));

    expect(response.status).toBe(503);
  });

  it("does not trust an Access email header without a signed assertion", async () => {
    const app = new Hono<UserContext>();
    app.use("*", requireUser);
    app.get("/", (c) => c.text(c.get("ownerEmail")));

    const response = await app.request("/", {
      headers: { "cf-access-authenticated-user-email": "owner@example.com" },
    }, env({
      APP_ENV: "production",
      CF_ACCESS_TEAM_DOMAIN: "header-test.cloudflareaccess.com",
      CF_ACCESS_AUD: "access-audience",
    }));

    expect(response.status).toBe(401);
  });

  it("allows the explicit development identity only in development", async () => {
    const app = new Hono<UserContext>();
    app.use("*", requireUser);
    app.get("/", (c) => c.text(c.get("ownerEmail")));

    const response = await app.request("/", {}, env({
      APP_ENV: "development",
      DEV_USER_EMAIL: "Owner@Example.com",
    }));

    expect(await response.text()).toBe("owner@example.com");
  });

  it("requires the exact Agent bearer token", async () => {
    const app = new Hono<UserContext>();
    app.use("*", requireAgent);
    app.get("/", (c) => c.json({ ok: true }));
    const bindings = env({ LORACHEF_AGENT_TOKEN: "agent-secret" });

    const denied = await app.request("/", {
      headers: { authorization: "Bearer agent-secrex" },
    }, bindings);
    const accepted = await app.request("/", {
      headers: { authorization: "Bearer agent-secret" },
    }, bindings);

    expect(denied.status).toBe(401);
    expect(accepted.status).toBe(200);
  });
});
