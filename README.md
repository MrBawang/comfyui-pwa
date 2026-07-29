# LoRAChef Studio Cloud

Personal Cloudflare workbench for ComfyUI workflows, character material generation, private outputs, chat, and PC-side LoRAChef screening. Cloudflare handles authentication, metadata, storage, and streaming. ComfyUI and the custom Qwen3.6 GGUF run as separate scale-to-zero Modal applications.

The editable system diagram is [docs/cloud-workbench-architecture.drawio](docs/cloud-workbench-architecture.drawio).

## Local Development

Requirements: Node.js 22+, [uv](https://docs.astral.sh/uv/), a configured Modal account, and Wrangler authentication. Test and Modal commands use the pinned Python 3.11 environment from `requirements-modal.txt`.

```bash
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev:cloud
```

Open `http://127.0.0.1:8787`. `DEV_USER_EMAIL` is accepted only when explicitly configured; production uses the Cloudflare Access identity header.

Routine checks do not call Modal or start a GPU:

```bash
npm run typecheck
npm test
npm run deploy:dry-run
```

## Cloudflare Setup

1. Create D1, replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.jsonc`, and reuse the existing `comfyui` R2 bucket after a capacity check. `luminaflow.space` must be the Worker's custom domain, not an R2 public-bucket domain; R2 objects remain private and are served through authenticated Worker routes.

```bash
npx wrangler d1 create lorachef-studio
npx wrangler r2 bucket info comfyui
npm run db:migrate:remote
```

2. `wrangler.jsonc` locks ComfyUI to the `luminaflow-studio` Workspace. Store `MODAL_API_URL=https://luminaflow-studio--comfy-desk-api.modal.run`, `MODAL_API_TOKEN`, and `LORACHEF_AGENT_TOKEN` with `wrangler secret put`. A URL from another Workspace is rejected before a cost quote is created. Leave all Modal Qwen values unset in Stage 1. After confirming the Modal Workspace and Environment hard budgets, set the Worker Secret `MODAL_BUDGET_CONFIRMED` to exactly `true`; without it, every Modal quote and submission is locked.
3. Protect the complete custom domain with Cloudflare Access. Configure `CF_ACCESS_TEAM_DOMAIN` (for example `team.cloudflareaccess.com`) and the application's audience tag as `CF_ACCESS_AUD` on the Worker. Production API requests verify the Access JWT and do not trust a caller-supplied email header by itself. Do not leave asset paths outside the Access application.

```bash
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
npx wrangler secret put CF_ACCESS_AUD
```
4. In Cloudflare Workers Builds, keep `main` as the production branch, set the build command to `npm run build`, and use the default deploy command `npx wrangler deploy`. Run `npm run deploy:dry-run` locally, then merge and push to `main`; Cloudflare deploys the commit automatically. Use `npm run deploy` only as an explicit manual fallback.

The Worker warns at 8 GiB and blocks new R2 writes at 9 GiB. It also stops app-managed R2 operations at 800,000 Class A or 8,000,000 Class B per month. Workers AI reserves a worst-case response allowance before each call, forwards browser cancellation to inference, times out after 90 seconds, and hard-stops at 9,000 Neurons per day. No threshold silently changes providers. Workflows are read from D1; only an explicitly approved directory sync wakes the Modal API.

These counters cover only operations routed through this Worker. Confirm before deployment that no other application continuously writes to the shared `comfyui` bucket; external R2 or Modal usage is outside this application's budget controls. Keep Workers and Zero Trust on Free and R2 on Standard so Cloudflare rejects over-quota operations instead of moving the application to paid capacity.

Every Modal-triggering action first creates a five-minute, single-use cost approval. The approval is bound to the action, workflow or resource, file size, and batch count. Ambiguous submissions are marked for manual review and never retried automatically. See [docs/DEPLOYMENT_CHECKLIST.md](docs/DEPLOYMENT_CHECKLIST.md) for every manually entered value and the safe rollout order.

## Modal Qwen3.6 (Stage 2, Deferred)

The LLM uses a dedicated Volume and only receives its own API token. It does not receive ComfyUI, R2, or Cloudflare credentials.

Get each GGUF SHA-256 from the pinned Hugging Face LFS pointer (`oid sha256:...`), then create the secrets:

```bash
modal secret create huggingface-secret HF_TOKEN=hf_...
modal secret create lorachef-qwen36-config \
  LLM_API_TOKEN="$(openssl rand -hex 32)" \
  LLM_MODEL_SHA256_Q6_K_P=<sha256> \
  LLM_MODEL_SHA256_Q5_K_P=<sha256> \
  LLM_MODEL_SHA256_Q4_K_M=<sha256>

uv run --python 3.11 --with-requirements requirements-modal.txt modal run modal_app/llm_app.py --quant Q6_K_P
uv run --python 3.11 --with-requirements requirements-modal.txt modal deploy modal_app/llm_app.py
```

Only explicitly installed, checksum-verified files are eligible. Startup tries the active quant and then lower variants, rejects peak startup memory over 44 GiB, uses a 16K context, one concurrent request, and no vision projector. Run the billable 20-prompt gate only when ready:

```bash
python3 scripts/benchmark_llm.py --url "$MODAL_LLM_URL" --token "$MODAL_LLM_TOKEN" --confirm-gpu
```

Activate a lower quant with `modal run modal_app/llm_app.py --quant Q5_K_P` if any acceptance gate fails.

## PC LoRAChef Agent

In the local LoRAChef checkout:

```bash
mkdir -p ~/.lorachef
cp cloud-agent.example.json ~/.lorachef/cloud-agent.json
chmod 600 ~/.lorachef/cloud-agent.json
./start_lorachef_web.command
```

Set the deployed site URL, the same `LORACHEF_AGENT_TOKEN`, and the Cloudflare Access Service Token Client ID/Secret. Restrict that Access token to `/api/agent/v1/*`. The Agent makes outbound requests only. It downloads one leased batch, runs the existing local pipeline, keeps the processed dataset under `~/LoRAChefCloud`, and returns only candidate decisions and `report.json` data.

## Legacy Migration

Migration is dry-run by default and never deletes source data:

```bash
python3 scripts/migrate_legacy.py --project <legacy-project-id>
python3 scripts/migrate_legacy.py --project <legacy-project-id> --apply \
  --url https://studio.example.com \
  --access-client-id "$CF_ACCESS_CLIENT_ID" \
  --access-client-secret "$CF_ACCESS_CLIENT_SECRET"
```

Select fewer projects if the projected total crosses the R2 protection line.
