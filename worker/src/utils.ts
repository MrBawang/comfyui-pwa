import type { Context } from "hono";

import type { Env, UserContext } from "./env";

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_SYSTEM_PROMPT_CHARS = 12_000;
export const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function id() {
  return crypto.randomUUID().replaceAll("-", "");
}

export function now() {
  return Date.now();
}

export function owner(c: Context<UserContext>) {
  return c.get("ownerEmail");
}

export function jsonError(c: Context, message: string, status = 400) {
  return c.json({ message }, status as 400);
}

export interface ModalEndpointStatus {
  workspace: string;
  configured: boolean;
  valid: boolean;
}

export function modalEndpointStatus(env: Env): ModalEndpointStatus {
  const workspace = String(env.MODAL_WORKSPACE ?? "").trim();
  const configured = Boolean(env.MODAL_API_URL && env.MODAL_API_TOKEN);
  if (!workspace || !env.MODAL_API_URL) return { workspace, configured, valid: false };
  try {
    const url = new URL(env.MODAL_API_URL);
    const expectedHost = `${workspace}--comfy-desk-api.modal.run`;
    const valid = url.protocol === "https:"
      && url.hostname === expectedHost
      && (url.pathname === "/" || url.pathname === "")
      && !url.search
      && !url.hash;
    return { workspace, configured, valid };
  } catch {
    return { workspace, configured, valid: false };
  }
}

export function modalBase(env: Env) {
  const status = modalEndpointStatus(env);
  if (!status.workspace) throw new Error("尚未配置 MODAL_WORKSPACE");
  if (!env.MODAL_API_URL) throw new Error("尚未配置 MODAL_API_URL");
  if (!status.valid) throw new Error(`Modal 地址不属于已锁定的 ${status.workspace} Workspace`);
  return env.MODAL_API_URL.replace(/\/$/, "");
}

export function modalHeaders(env: Env, source?: HeadersInit) {
  const incoming = new Headers(source);
  const headers = new Headers();
  for (const name of ["accept", "content-length", "content-type", "idempotency-key"]) {
    const value = incoming.get(name);
    if (value) headers.set(name, value);
  }
  if (!env.MODAL_API_TOKEN) throw new Error("尚未配置 MODAL_API_TOKEN");
  headers.set("authorization", `Bearer ${env.MODAL_API_TOKEN}`);
  return headers;
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function validId(value: string) {
  if (!/^[a-f0-9]{32}$/.test(value)) throw new Error("编号格式不正确");
  return value;
}

export function contentTypeFilename(mediaType: string, fallback: string) {
  if (fallback.includes(".")) return fallback;
  if (mediaType === "image/jpeg") return `${fallback}.jpg`;
  if (mediaType === "image/webp") return `${fallback}.webp`;
  if (mediaType.startsWith("video/")) return `${fallback}.mp4`;
  return `${fallback}.png`;
}

export async function safeResponseMessage(response: Response, fallback: string) {
  if (!response.body) return fallback;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const maximumBytes = 64 * 1024;
  let total = 0;
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      text += decoder.decode(chunk.value.subarray(0, Math.max(0, chunk.value.byteLength - (total - maximumBytes))));
      break;
    }
    text += decoder.decode(chunk.value, { stream: true });
  }
  text += decoder.decode();
  if (!text) return fallback;
  try {
    const body = JSON.parse(text) as { detail?: string; message?: string; error?: { message?: string } };
    return body.detail ?? body.message ?? body.error?.message ?? fallback;
  } catch {
    return text.slice(0, 1_000);
  }
}

export async function storageUsage(env: Env, ownerEmail: string) {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(bytes), 0) AS bytes FROM storage_objects WHERE owner_email = ?1",
  ).bind(ownerEmail).first<{ bytes: number }>();
  return Number(row?.bytes ?? 0);
}
