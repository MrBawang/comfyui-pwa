import type { Env } from "./env";
import { now } from "./utils";

export class R2BudgetError extends Error {}

function usageMonth() {
  return new Date().toISOString().slice(0, 7);
}

function limit(value: string, label: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new R2BudgetError(`${label} 保护线配置不正确`);
  return parsed;
}

export async function r2Usage(env: Env) {
  const row = await env.DB.prepare(`SELECT class_a, class_b FROM r2_usage_monthly WHERE usage_month = ?1`)
    .bind(usageMonth()).first<{ class_a: number; class_b: number }>();
  return {
    classA: Number(row?.class_a ?? 0),
    classB: Number(row?.class_b ?? 0),
    classAStop: limit(env.R2_CLASS_A_STOP, "R2 Class A"),
    classBStop: limit(env.R2_CLASS_B_STOP, "R2 Class B"),
  };
}

async function reserveR2Operations(env: Env, classA: number, classB: number) {
  if (!classA && !classB) return;
  const classAStop = limit(env.R2_CLASS_A_STOP, "R2 Class A");
  const classBStop = limit(env.R2_CLASS_B_STOP, "R2 Class B");
  const month = usageMonth();
  await env.DB.prepare(`INSERT OR IGNORE INTO r2_usage_monthly
    (usage_month, class_a, class_b, updated_at) VALUES (?1, 0, 0, ?2)`).bind(month, now()).run();
  const result = await env.DB.prepare(`UPDATE r2_usage_monthly
    SET class_a = class_a + ?1, class_b = class_b + ?2, updated_at = ?3
    WHERE usage_month = ?4 AND class_a + ?1 <= ?5 AND class_b + ?2 <= ?6`)
    .bind(classA, classB, now(), month, classAStop, classBStop).run();
  if (Number(result.meta.changes ?? 0) !== 1) {
    throw new R2BudgetError("R2 月度操作数已达到免费套餐保护线，已停止新的对象操作");
  }
}

export async function r2Get(env: Env, key: string, options?: R2GetOptions) {
  await reserveR2Operations(env, 0, 1);
  return options ? env.ASSETS_BUCKET.get(key, options) : env.ASSETS_BUCKET.get(key);
}

export async function r2Head(env: Env, key: string) {
  await reserveR2Operations(env, 0, 1);
  return env.ASSETS_BUCKET.head(key);
}

export async function r2Put(env: Env, key: string, value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob, options?: R2PutOptions) {
  await reserveR2Operations(env, 1, 0);
  return env.ASSETS_BUCKET.put(key, value, options);
}

export async function r2Delete(env: Env, keys: string | string[]) {
  const count = Array.isArray(keys) ? keys.length : 1;
  if (!count) return;
  await reserveR2Operations(env, count, 0);
  await env.ASSETS_BUCKET.delete(keys);
}

export async function r2List(env: Env, options?: R2ListOptions) {
  await reserveR2Operations(env, 1, 0);
  return options ? env.ASSETS_BUCKET.list(options) : env.ASSETS_BUCKET.list();
}
