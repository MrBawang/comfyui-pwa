import { Hono } from "hono";
import { createMiddleware } from "hono/factory";

import type { Env, UserContext } from "./env";
import { r2Get, r2List } from "./r2-budget";
import { now, owner } from "./utils";

const COOKIE_NAME = "__Host-r2-browser";
const SESSION_TTL_MS = 15 * 60 * 1_000;
const LOCK_TTL_MS = 15 * 60 * 1_000;
const MAX_FAILURES = 5;
const MAX_PASSWORD_CHARS = 256;
const MAX_CURSOR_CHARS = 4_096;
const MAX_KEY_BYTES = 1_024;
const LIST_LIMIT = 100;

const PREVIEW_TYPES = new Set([
  "application/pdf",
  "audio/mpeg",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/webm",
]);

interface AttemptRow {
  failed_attempts: number;
  locked_until: number;
}

interface SessionPayload {
  email: string;
  expiresAt: number;
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
}

function secretBytes(env: Env) {
  const value = env.R2_BROWSER_PASSWORD_SHA256?.trim().toLowerCase() ?? "";
  if (!/^[a-f0-9]{64}$/.test(value)) return undefined;
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16));
}

async function hmacKey(secret: Uint8Array) {
  return crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function createSession(secret: Uint8Array, email: string, expiresAt: number) {
  const encodedPayload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ email, expiresAt })));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), new TextEncoder().encode(encodedPayload));
  return `${encodedPayload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

function cookieValue(header: string | undefined) {
  for (const part of (header ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === COOKIE_NAME) return value.join("=");
  }
  return undefined;
}

async function validSession(env: Env, cookieHeader: string | undefined, email: string) {
  const secret = secretBytes(env);
  const token = cookieValue(cookieHeader);
  if (!secret || !token || token.length > 2_048) return false;
  try {
    const [encodedPayload, encodedSignature, extra] = token.split(".");
    const signature = encodedSignature ? base64UrlToBytes(encodedSignature) : undefined;
    if (!encodedPayload || !signature || extra) return false;
    const verified = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      signature,
      new TextEncoder().encode(encodedPayload),
    );
    if (!verified) return false;
    const payloadBytes = base64UrlToBytes(encodedPayload);
    if (!payloadBytes) return false;
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as SessionPayload;
    return payload.email === email
      && Number.isSafeInteger(payload.expiresAt)
      && payload.expiresAt > now()
      && payload.expiresAt <= now() + SESSION_TTL_MS;
  } catch {
    return false;
  }
}

async function passwordMatches(password: string, expected: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(password));
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(digest, expected);
  }
  const actual = new Uint8Array(digest);
  let mismatch = 0;
  for (let index = 0; index < actual.length; index += 1) mismatch |= actual[index] ^ expected[index];
  return mismatch === 0;
}

function sessionCookie(token: string) {
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=${SESSION_TTL_MS / 1_000}; Secure; HttpOnly; SameSite=Strict`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict`;
}

function validOpaqueValue(value: string, maximumBytes = MAX_KEY_BYTES) {
  return !value.includes("\0") && new TextEncoder().encode(value).byteLength <= maximumBytes;
}

function mediaType(key: string, stored?: string) {
  const normalized = stored?.split(";", 1)[0].trim().toLowerCase();
  if (normalized && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized)) return normalized;
  const extension = key.split(".").pop()?.toLowerCase();
  return ({
    avif: "image/avif",
    gif: "image/gif",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    ogg: "audio/ogg",
    pdf: "application/pdf",
    png: "image/png",
    wav: "audio/wav",
    webm: "video/webm",
    webp: "image/webp",
  } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

function objectName(key: string) {
  const name = key.replace(/\/$/, "").split("/").pop();
  return name || key;
}

function contentDisposition(filename: string, inline: boolean) {
  const fallback = filename.replace(/[^A-Za-z0-9._ -]/g, "_").replace(/[\r\n"]/g, "_") || "download";
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${inline ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function recordFailure(env: Env, email: string) {
  const timestamp = now();
  return env.DB.prepare(`INSERT INTO r2_browser_auth_attempts
    (owner_email, failed_attempts, locked_until, updated_at) VALUES (?1, 1, 0, ?2)
    ON CONFLICT(owner_email) DO UPDATE SET
      failed_attempts = CASE
        WHEN r2_browser_auth_attempts.locked_until > 0 AND r2_browser_auth_attempts.locked_until <= ?2 THEN 1
        ELSE r2_browser_auth_attempts.failed_attempts + 1
      END,
      locked_until = CASE
        WHEN r2_browser_auth_attempts.locked_until > ?2 THEN r2_browser_auth_attempts.locked_until
        WHEN r2_browser_auth_attempts.locked_until > 0 AND r2_browser_auth_attempts.locked_until <= ?2 THEN 0
        WHEN r2_browser_auth_attempts.failed_attempts + 1 >= ?3 THEN ?4
        ELSE 0
      END,
      updated_at = ?2
    RETURNING failed_attempts, locked_until`)
    .bind(email, timestamp, MAX_FAILURES, timestamp + LOCK_TTL_MS)
    .first<AttemptRow>();
}

async function activeLock(env: Env, email: string) {
  const row = await env.DB.prepare(`SELECT failed_attempts, locked_until FROM r2_browser_auth_attempts
    WHERE owner_email = ?1`).bind(email).first<AttemptRow>();
  return row && Number(row.locked_until) > now() ? row : undefined;
}

const requireStorageSession = createMiddleware<UserContext>(async (c, next) => {
  if (!secretBytes(c.env)) return c.json({ message: "R2 查看密码尚未配置" }, 503);
  if (!(await validSession(c.env, c.req.header("cookie"), owner(c)))) {
    return c.json({ message: "R2 查看已锁定，请在“更多”中输入密码" }, 401);
  }
  await next();
});

export const storageBrowserRoutes = new Hono<UserContext>();

storageBrowserRoutes.use("/api/r2-browser/*", async (c, next) => {
  c.header("cache-control", "private, no-store");
  await next();
});

storageBrowserRoutes.get("/api/r2-browser/session", async (c) => {
  const configured = Boolean(secretBytes(c.env));
  return c.json({
    configured,
    unlocked: configured && await validSession(c.env, c.req.header("cookie"), owner(c)),
  });
});

storageBrowserRoutes.post("/api/r2-browser/unlock", async (c) => {
  const secret = secretBytes(c.env);
  if (!secret) return c.json({ message: "R2 查看密码尚未配置" }, 503);
  const locked = await activeLock(c.env, owner(c));
  if (locked) {
    const retryAfter = Math.max(1, Math.ceil((Number(locked.locked_until) - now()) / 1_000));
    c.header("retry-after", String(retryAfter));
    return c.json({ message: `密码尝试次数过多，请在 ${Math.ceil(retryAfter / 60)} 分钟后重试`, retryAfter }, 429);
  }
  const body: { password?: unknown } = await c.req.json<{ password?: unknown }>().catch(() => ({}));
  const password = typeof body.password === "string" ? body.password : "";
  if (!password || password.length > MAX_PASSWORD_CHARS) {
    return c.json({ message: "请输入有效的 R2 查看密码" }, 400);
  }
  if (!(await passwordMatches(password, secret))) {
    const failure = await recordFailure(c.env, owner(c));
    const lockedUntil = Number(failure?.locked_until ?? 0);
    if (lockedUntil > now()) {
      c.header("retry-after", String(LOCK_TTL_MS / 1_000));
      return c.json({ message: "密码尝试次数过多，已锁定 15 分钟", retryAfter: LOCK_TTL_MS / 1_000 }, 429);
    }
    const remaining = Math.max(0, MAX_FAILURES - Number(failure?.failed_attempts ?? 1));
    return c.json({ message: `密码不正确，还可尝试 ${remaining} 次`, attemptsRemaining: remaining }, 401);
  }
  await c.env.DB.prepare("DELETE FROM r2_browser_auth_attempts WHERE owner_email = ?1").bind(owner(c)).run();
  const expiresAt = now() + SESSION_TTL_MS;
  c.header("set-cookie", sessionCookie(await createSession(secret, owner(c), expiresAt)));
  return c.json({ ok: true, expiresAt });
});

storageBrowserRoutes.post("/api/r2-browser/lock", (c) => {
  c.header("set-cookie", clearSessionCookie());
  return c.json({ ok: true });
});

storageBrowserRoutes.use("/api/r2-browser/objects", requireStorageSession);
storageBrowserRoutes.use("/api/r2-browser/object", requireStorageSession);

storageBrowserRoutes.get("/api/r2-browser/objects", async (c) => {
  const prefix = c.req.query("prefix") ?? "";
  const cursor = c.req.query("cursor") ?? "";
  if (!validOpaqueValue(prefix) || (prefix && !prefix.endsWith("/"))) {
    return c.json({ message: "R2 目录格式不正确" }, 400);
  }
  if (cursor.length > MAX_CURSOR_CHARS || cursor.includes("\0")) {
    return c.json({ message: "R2 分页游标格式不正确" }, 400);
  }
  const listed = await r2List(c.env, {
    prefix,
    delimiter: "/",
    limit: LIST_LIMIT,
    include: ["httpMetadata"],
    ...(cursor ? { cursor } : {}),
  });
  return c.json({
    prefix,
    prefixes: listed.delimitedPrefixes.map((directoryPrefix) => ({
      prefix: directoryPrefix,
      name: objectName(directoryPrefix),
    })),
    objects: listed.objects.map((object) => {
      const contentType = mediaType(object.key, object.httpMetadata?.contentType);
      return {
        key: object.key,
        name: objectName(object.key),
        size: object.size,
        uploadedAt: object.uploaded.getTime(),
        contentType,
        storageClass: object.storageClass,
        previewable: PREVIEW_TYPES.has(contentType),
      };
    }),
    truncated: listed.truncated,
    nextCursor: listed.truncated ? listed.cursor : undefined,
  });
});

storageBrowserRoutes.get("/api/r2-browser/object", async (c) => {
  const key = c.req.query("key") ?? "";
  if (!key || !validOpaqueValue(key)) return c.json({ message: "R2 对象 Key 格式不正确" }, 400);
  const rangeHeader = c.req.header("range");
  let object;
  try {
    object = await r2Get(c.env, key, rangeHeader ? { range: c.req.raw.headers } : undefined);
  } catch (error) {
    if (rangeHeader) return c.json({ message: "请求的文件范围不可用" }, 416);
    throw error;
  }
  if (!object) return c.json({ message: "R2 对象不存在" }, 404);
  const type = mediaType(key, object.httpMetadata?.contentType);
  const inline = c.req.query("mode") === "inline" && PREVIEW_TYPES.has(type);
  const headers = new Headers({
    "accept-ranges": "bytes",
    "cache-control": "private, no-store",
    "content-disposition": contentDisposition(objectName(key), inline),
    "content-type": inline || type !== "text/html" ? type : "application/octet-stream",
    "cross-origin-resource-policy": "same-origin",
    "etag": object.httpEtag,
    "last-modified": object.uploaded.toUTCString(),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  let status = 200;
  if (object.range) {
    const offset = "offset" in object.range && object.range.offset !== undefined
      ? object.range.offset
      : Math.max(0, object.size - ("suffix" in object.range ? object.range.suffix : object.size));
    const length = "length" in object.range && object.range.length !== undefined
      ? object.range.length
      : object.size - offset;
    headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("content-length", String(length));
    status = 206;
  } else {
    headers.set("content-length", String(object.size));
  }
  return new Response(object.body, { status, headers });
});
