import { createMiddleware } from "hono/factory";
import { verifyWithJwks } from "hono/jwt";
import type { Context } from "hono";

import type { UserContext } from "./env";

type JwksKeys = NonNullable<Parameters<typeof verifyWithJwks>[1]["keys"]>;

const jwksCache = new Map<string, { keys: JwksKeys; expiresAt: number }>();
const identityCache = new Map<string, { email: string; expiresAt: number }>();

function bearer(header?: string) {
  return header?.startsWith("Bearer ") ? header.slice(7) : "";
}

async function equalSecret(left: string, right: string) {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(leftHash, rightHash);
  }
  // Node's local Web Crypto can lag the Worker API; both hashes are fixed at 32 bytes.
  const a = new Uint8Array(leftHash);
  const b = new Uint8Array(rightHash);
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) mismatch |= a[index] ^ b[index];
  return mismatch === 0;
}

function accessOrigin(value: string) {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  if (
    url.protocol !== "https:"
    || !url.hostname.endsWith(".cloudflareaccess.com")
    || url.username
    || url.password
    || (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error("CF_ACCESS_TEAM_DOMAIN 配置不正确");
  }
  return url.origin;
}

async function accessKeys(origin: string) {
  const cached = jwksCache.get(origin);
  if (cached && cached.expiresAt > Date.now()) return cached.keys;
  const response = await fetch(`${origin}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error("Cloudflare Access 公钥读取失败");
  const body = await response.json() as { keys?: JwksKeys };
  if (!Array.isArray(body.keys) || !body.keys.length) throw new Error("Cloudflare Access 公钥格式不正确");
  jwksCache.set(origin, { keys: body.keys, expiresAt: Date.now() + 6 * 60 * 60 * 1_000 });
  return body.keys;
}

async function accessIdentity(c: Context<UserContext>) {
  const token = c.req.header("cf-access-jwt-assertion") ?? "";
  const teamDomain = c.env.CF_ACCESS_TEAM_DOMAIN?.trim() ?? "";
  const audience = c.env.CF_ACCESS_AUD?.trim() ?? "";
  if (!teamDomain || !audience) throw new Error("Cloudflare Access JWT 校验尚未配置");
  if (!token) return undefined;
  const cacheKey = `${teamDomain}\0${audience}\0${token}`;
  const cached = identityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.email;
  const origin = accessOrigin(teamDomain);
  const payload = await verifyWithJwks(token, {
    keys: await accessKeys(origin),
    allowedAlgorithms: ["RS256"],
    verification: { iss: origin, aud: audience },
  });
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
  const headerEmail = c.req.header("cf-access-authenticated-user-email")?.trim().toLowerCase();
  if (!email || !Number.isFinite(payload.exp) || (headerEmail && headerEmail !== email)) return undefined;
  if (identityCache.size >= 32) identityCache.delete(identityCache.keys().next().value!);
  identityCache.set(cacheKey, { email, expiresAt: Math.min(Number(payload.exp ?? 0) * 1_000, Date.now() + 60 * 60 * 1_000) });
  return email;
}

export const requireUser = createMiddleware<UserContext>(async (c, next) => {
  let email: string | undefined;
  try {
    email = c.env.APP_ENV === "development"
      ? c.env.DEV_USER_EMAIL?.trim().toLowerCase()
      : await accessIdentity(c);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cloudflare Access 校验失败";
    return c.json({ message }, message.includes("尚未配置") ? 503 : 401);
  }
  if (!email) return c.json({ message: "需要通过 Cloudflare Access 登录" }, 401);
  c.set("ownerEmail", email);
  await next();
});

export const requireAgent = createMiddleware<UserContext>(async (c, next) => {
  const expected = c.env.LORACHEF_AGENT_TOKEN;
  const supplied = bearer(c.req.header("authorization"));
  if (!expected || !supplied || !(await equalSecret(supplied, expected))) {
    return c.json({ message: "LoRAChef Agent 凭据无效" }, 401);
  }
  await next();
});
