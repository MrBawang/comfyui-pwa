# Stage 1 Deployment Checklist

This release keeps Modal Qwen disabled. GitHub/Cloudflare builds run only `npm run build` and `wrangler deploy`; they must never run `modal deploy`, model downloads, resource installation, or GPU tests.

## Free Plan Guardrails

Keep Workers and Zero Trust on Free and the `comfyui` bucket on R2 Standard. Do not enable a paid Workers plan or automatic upgrade. Cloudflare's own Free-plan limits stop Workers, D1, Durable Objects, and Workers Builds when their included quota is exhausted; the application does not attempt a paid fallback.

| Service | Stage 1 protection |
|---|---|
| Workers | Free plan; 100,000 dynamic requests/day and 10 ms CPU per request |
| D1 | Free plan; 5 million rows read/day, 100,000 rows written/day, 5 GB total |
| Durable Objects | SQLite-backed only; Free-plan request and GB-s limits |
| Workers AI | Reserve worst-case output first; reject requests that could cross 9,000 Neurons/day |
| R2 | Warn at 8 GiB; reject writes at 9 GiB; stop at 800,000 Class A or 8,000,000 Class B operations/month |
| Workers Builds | Free plan; builds stop after 3,000 minutes/month |

R2 byte and operation counters cover only objects managed through this Worker. Before rollout, confirm that no other application continuously writes to `comfyui`; external R2 or Modal usage cannot be stopped by this code.

## Values You Must Enter

| Field | Exact content or source |
|---|---|
| D1 `database_id` | UUID printed by `npx wrangler d1 create lorachef-studio`; replace `REPLACE_WITH_D1_DATABASE_ID` in `wrangler.jsonc` |
| Access domain | `luminaflow.space/*` |
| Access Allow email | Your one real login email; no wildcard or additional user |
| `CF_ACCESS_TEAM_DOMAIN` | Your team hostname, for example `team.cloudflareaccess.com`, without `https://` |
| `CF_ACCESS_AUD` | Audience Tag from the `luminaflow.space` Access application overview |
| `MODAL_API_URL` | Exactly `https://luminaflow-studio--comfy-desk-api.modal.run`; other Workspace hosts are rejected |
| `MODAL_API_TOKEN` | Exactly the same value as `COMFY_API_TOKEN` in Modal Secret `comfy-desk-config` |
| `LORACHEF_AGENT_TOKEN` | Complete output of `openssl rand -hex 32` |
| `R2_BROWSER_PASSWORD_SHA256` | Lowercase SHA-256 of a separate strong viewer password; store the plaintext password only in your password manager |
| `MODAL_BUDGET_CONFIRMED` | Set to `true` only after both Modal budgets below are confirmed |
| Workspace Budget | At most the free credit currently shown by Modal; use `30 USD` only if the dashboard still shows USD 30 |
| Environment Budget | Equal to or lower than Workspace Budget |

Create Worker Secrets without placing values in Git:

```bash
npx wrangler secret put CF_ACCESS_TEAM_DOMAIN
npx wrangler secret put CF_ACCESS_AUD
npx wrangler secret put MODAL_API_URL
npx wrangler secret put MODAL_API_TOKEN
npx wrangler secret put LORACHEF_AGENT_TOKEN
npx wrangler secret put R2_BROWSER_PASSWORD_SHA256
npx wrangler secret put MODAL_BUDGET_CONFIRMED
```

Create an Access Service Token restricted to `/api/agent/v1/*`, then fill `~/.lorachef/cloud-agent.json` with `base_url`, the shared Agent token, `agent_id: "zhouw-mac"`, and the Service Token Client ID/Secret. The Agent opens outbound connections only.

## Safe Order

1. Confirm Workers and Zero Trust are Free, R2 is Standard, and the shared bucket has no unknown continuous writer.
   Confirm `luminaflow.space` is not connected under R2 **Custom Domains**; it belongs to the `comfyui-pwa` Worker custom domain.
2. Run `npx wrangler d1 create lorachef-studio`, copy the returned UUID into `wrangler.jsonc`, then run `npm run config:check`.
3. Apply additive D1 migrations with `npm run db:migrate:remote`.
4. Configure Access and the Stage 1 Worker Secrets.
5. Confirm Modal budgets, then set `MODAL_BUDGET_CONFIRMED=true`.
6. Push the feature branch for a Cloudflare preview. Run only auth, D1, R2, Workers AI, and UI checks.
7. In the Workflows page, approve one directory sync and one minimal ComfyUI run. Compare Modal usage before and after.
8. Merge `main` only after the usage delta is accepted.

Stage 2 Qwen values remain unset. `npm run llm:checksums` reads pinned Hugging Face LFS metadata and prints exact SHA assignments without downloading a model.

## Stage 2 Values (Do Not Configure Yet)

The read-only metadata check for revision `f12a584fecbeb5f20001130d8ecd66c9327ae685` currently returns:

```text
LLM_MODEL_SHA256_Q6_K_P=90281d33e0790d6da2f125aa3f4352f429d8cc2ce2b32caafd78896397756fc3
LLM_MODEL_SHA256_Q5_K_P=2a3b72ab458f99028b65cce7ef6a9d6e4c79aa4318296d1b01bac9923d6a3b12
LLM_MODEL_SHA256_Q4_K_M=bbef58c37ce88820be9d98b6437f1cf4bac890c947bd55fc7b68e22098574231
```

Re-run `npm run llm:checksums` immediately before Stage 2 and require an exact match. `HF_TOKEN`, `LLM_API_TOKEN`, `MODAL_LLM_TOKEN`, and `MODAL_LLM_URL` remain deliberately unset in Stage 1.
