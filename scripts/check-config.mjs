#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(resolve(root, "wrangler.jsonc"), "utf8"));
const localVarsPath = resolve(root, ".dev.vars");
const localNames = new Set();
if (existsSync(localVarsPath)) {
  for (const line of readFileSync(localVarsPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=/);
    if (match) localNames.add(match[1]);
  }
}
for (const name of Object.keys(process.env)) localNames.add(name);

let failed = false;
function check(label, ok, detail) {
  console.log(`${ok ? "OK  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failed = true;
}

function configured(name) {
  return localNames.has(name);
}

const d1 = config.d1_databases?.find((item) => item.binding === "DB");
const vars = config.vars ?? {};
const productionDomain = config.routes?.some((item) =>
  item.pattern === "luminaflow.space" && item.custom_domain === true,
);

console.log("Stage 1 - repository configuration");
check("D1 database_id", /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(d1?.database_id ?? ""),
  d1?.database_id === "REPLACE_WITH_D1_DATABASE_ID" ? "replace the placeholder with `wrangler d1 create lorachef-studio` UUID" : "UUID format");
check("Worker custom domain", productionDomain, "luminaflow.space");
check("R2 bucket", config.r2_buckets?.some((item) => item.binding === "ASSETS_BUCKET" && item.bucket_name === "comfyui"), "comfyui");
check("Modal workspace lock", vars.MODAL_WORKSPACE === "luminaflow-studio", "luminaflow-studio");
check("R2 byte hard stop", vars.STORAGE_STOP_BYTES === "9663676416", "9 GiB");
check("R2 operation hard stops", vars.R2_CLASS_A_STOP === "800000" && vars.R2_CLASS_B_STOP === "8000000", "800,000 A / 8,000,000 B");
check("Workers AI hard stop", vars.WORKERS_AI_STOP_NEURONS === "9000", "9,000 Neurons/day");

console.log("\nStage 1 - local/production secret names (values are never printed)");
for (const name of [
  "CF_ACCESS_TEAM_DOMAIN",
  "CF_ACCESS_AUD",
  "MODAL_API_URL",
  "MODAL_API_TOKEN",
  "LORACHEF_AGENT_TOKEN",
  "R2_BROWSER_PASSWORD_SHA256",
  "MODAL_BUDGET_CONFIRMED",
]) {
  check(name, configured(name), configured(name) ? ".dev.vars or process environment" : "missing locally; production uses Worker Secret");
}
if (configured("MODAL_BUDGET_CONFIRMED") && process.env.MODAL_BUDGET_CONFIRMED) {
  check("Modal budget acknowledgement", process.env.MODAL_BUDGET_CONFIRMED === "true", "must be exactly true");
}

console.log("\nStage 1 - Cloudflare dashboard manual checks");
console.log("MANUAL Workers plan: Free (no paid upgrade)");
console.log("MANUAL Zero Trust plan: Free");
console.log("MANUAL R2 storage class: Standard; no other application continuously writes to comfyui");
console.log("MANUAL Access application domain: luminaflow.space/*");
console.log("MANUAL Access Allow policy: exactly one real login email");
console.log("MANUAL Agent service-token policy: only /api/agent/v1/*");
console.log("MANUAL Modal Workspace Budget: at most verified free credit (nominally USD 30/month)");
console.log("MANUAL Modal Environment Budget: not greater than Workspace Budget");

console.log("\nStage 2 - intentionally deferred");
for (const name of [
  "HF_TOKEN",
  "MODAL_LLM_URL",
  "MODAL_LLM_TOKEN",
  "LLM_MODEL_SHA256_Q6_K_P",
  "LLM_MODEL_SHA256_Q5_K_P",
  "LLM_MODEL_SHA256_Q4_K_M",
]) console.log(`DEFER ${name}`);

if (failed) {
  console.error("\nPreflight failed. No remote resources were changed.");
  process.exitCode = 1;
} else {
  console.log("\nPreflight passed for locally visible values. Dashboard-only checks still require manual confirmation.");
}
