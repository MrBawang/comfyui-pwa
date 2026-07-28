# Repository Guidelines

## Project Structure & Module Organization

`web/` contains the Vite React PWA and responsive workbench components. `worker/` contains the Hono API, Cloudflare Access middleware, D1/R2 access, chat routing, and the Durable Object GPU queue. Shared TypeScript contracts live in `shared/`. Modal applications are isolated under `modal_app/`: `comfy_app.py` runs ComfyUI and `llm_app.py` runs Qwen3.6. Database changes belong in `migrations/`; operational scripts belong in `scripts/`; JavaScript and Python tests live in `tests/`.

## Build, Test, and Development Commands

Use Node.js 22+ and `uv`; Python commands are pinned to 3.11 through `requirements-modal.txt`.

```bash
npm install                 # install frontend and Worker dependencies
npm run dev:cloud           # build assets and start Wrangler locally
npm run typecheck           # check web and Worker TypeScript
npm test                    # frontend, Worker, and Python suites
npm run deploy:dry-run      # validate the Cloudflare bundle without deployment
```

Run `npm run db:migrate:local` after changing D1 migrations. Routine tests must not start Modal GPU containers.

## Coding Style & Naming Conventions

TypeScript uses strict mode, two-space indentation, `camelCase` values, `PascalCase` React components, and kebab-case filenames. Python follows PEP 8 with four-space indentation and `snake_case`. Prefer existing helpers over duplicate request, storage, or workflow logic. Keep Worker handlers streaming; never buffer large R2 objects or model outputs. Production identity must come from a verified Cloudflare Access JWT. Comments should explain non-obvious constraints rather than restate code.

## Testing Guidelines

Use Node's test runner for pure frontend contracts, Vitest for Worker behavior, and `unittest` for Python. Name tests `*.test.mjs` or `test_*.py`. Cover retries, idempotency, interrupted SSE, expired Agent leases, queue recovery, and storage thresholds when changing those paths. Real GPU acceptance is an explicit, separately confirmed operation.

## Commit & Pull Request Guidelines

History is minimal, so use imperative, scoped commits such as `Add serial GPU queue recovery`. Keep unrelated changes separate. Pull requests should explain user-visible behavior, migrations, secrets, verification commands, and cost impact. Include desktop and mobile screenshots for UI changes and never commit `.dev.vars`, Access credentials, model files, or generated datasets.
