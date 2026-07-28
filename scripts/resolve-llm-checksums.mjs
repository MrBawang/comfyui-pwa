#!/usr/bin/env node

const repo = "HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive";
const revision = "f12a584fecbeb5f20001130d8ecd66c9327ae685";
const files = {
  LLM_MODEL_SHA256_Q6_K_P: "Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-Q6_K_P.gguf",
  LLM_MODEL_SHA256_Q5_K_P: "Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-Q5_K_P.gguf",
  LLM_MODEL_SHA256_Q4_K_M: "Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-Q4_K_M.gguf",
};

const headers = { accept: "application/json" };
if (process.env.HF_TOKEN) headers.authorization = `Bearer ${process.env.HF_TOKEN}`;
const url = `https://huggingface.co/api/models/${repo}/revision/${revision}?blobs=true`;
const response = await fetch(url, { headers });
if (!response.ok) throw new Error(`Hugging Face metadata request failed (${response.status})`);
const metadata = await response.json();
const siblings = Array.isArray(metadata.siblings) ? metadata.siblings : [];

console.log(`# ${repo}`);
console.log(`# revision=${revision}`);
for (const [name, filename] of Object.entries(files)) {
  const sibling = siblings.find((item) => item.rfilename === filename);
  const raw = sibling?.lfs?.sha256 ?? sibling?.lfs?.oid ?? "";
  const checksum = String(raw).replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/i.test(checksum)) throw new Error(`Missing LFS SHA-256 for ${filename}`);
  console.log(`${name}=${checksum.toLowerCase()}`);
}
