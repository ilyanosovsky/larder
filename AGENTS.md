# AGENTS.md — rules for working on Larder

## Project

Larder — shared household food hub: realtime shopping cart, pantry, recipe library with AI import, weekly menu pool, AI assistant. Mobile-first PWA (Next.js), Russian UI.

Read before working:
- [VISION.md](VISION.md) (ru) — product concept, data model, architecture decisions. Architecture decisions there are settled; don't relitigate them silently.
- [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) (ru) — live task board. Source of truth for what to build next.
- [DESIGN_BRIEF.md](DESIGN_BRIEF.md) (ru) + [design/](design/) — screens and Paper Ledger design tokens ([design/uploads/tokens.css](design/uploads/tokens.css)).

## Language rules

- **Chat with the user: always Russian.**
- Code, comments, commits, PR titles/descriptions, wiki: English.
- UI strings: Russian, only via next-intl dictionaries. Never hardcode a user-visible string.

## Workflow (non-negotiable)

- Every change lands via PR into `main`. `main` is protected by a ruleset (applies to admins too): PR required, CI green, **all review conversations resolved**.
- Branch per plan task: `feat/<task-id>-<slug>` (e.g. `feat/2.1-cart-model`), `fix/...`, `chore/...`. Conventional Commits. Squash merge.
- Every PR MUST:
  1. Update its task row in IMPLEMENTATION_PLAN.md (status, PR link) — same PR, not after.
  2. Add/adjust vitest tests for the logic it touches.
  3. Update `docs/wiki/**` when behavior, env vars, or setup change. The GitHub wiki is auto-synced from `docs/wiki/` on merge to main — **never edit the wiki directly on GitHub**.
- **CodeRabbit** reviews every PR. Every comment must be worked through: implement the fix, or reply with a reasoned rejection — then resolve the thread. Merge is blocked until every thread is resolved. Do not resolve threads without a fix or a reply.
- **Merging is pre-authorized by the user**: once CI is green and every review thread is resolved, the orchestrator squash-merges the PR without asking and proceeds to the next plan task.

## Model routing

- **Fable** (main session): orchestration, task planning, architecture decisions, reviewing subagent output, updating the plan.
- Implementation is delegated to subagents by the task's label in IMPLEMENTATION_PLAN.md: `opus` → complex tasks, `sonnet` → simple tasks. Trivial glue edits may be done inline by the orchestrator.
- A delegated task prompt must include: task id, acceptance criteria, relevant file paths, and a pointer to this file's rules.

## Engineering rules

- TypeScript strict, no `any`. Zod at every boundary: tRPC inputs/outputs, env parsing, AI structured outputs. For OpenAI strict mode use `.nullable()`, never `.optional()`.
- DB: Drizzle schema is the single source of truth. Migrations via drizzle-kit; never edit an applied migration. Better Auth tables are generated with `@better-auth/cli generate` and versioned with regular migrations.
- DB migrations are **pre-authorized by the user**: generate and apply drizzle-kit migrations (local dev DB and Railway) without asking for confirmation.
- Realtime invariants (VISION §6.3): `LISTEN` runs on a dedicated non-pooled connection with auto-reconnect + re-LISTEN; SSE reconnect ⇒ invalidate the household's query cache.
- Cart invariant: **one active CartItem per product** — partial unique index `WHERE trip_id IS NULL`. Never bypass it in application code.
- AI calls: cheap model + `reasoning_effort: "low"` for parsing/normalization. Record cost in `AiJob.costUsd` — always, from the very first AI feature. `AI_MONTHLY_BUDGET_USD` caps the **assistant only** (import and icon-picking keep working at the cap); the check lives in the assistant (task 6.1). AI endpoints are rate-limited from the first one (task 1.3).
- Tests: vitest, colocated `*.test.ts`. Business logic (cart merge rules, menu→cart summing, parsers, invariants) must be covered. Recipe parsers are tested against saved HTML fixtures (`__fixtures__/`), not live network.
- Secrets: never commit. A new env var lands in the same PR in three places: `.env.example`, README env table, `docs/wiki/Env-Setup.md`.
- Match existing patterns and file structure; no drive-by refactors inside feature PRs.

## Definition of Done

Code follows these rules · tests added and green · CI green (lint, typecheck, test, build) · CodeRabbit threads all resolved · plan row updated · wiki updated if needed.
