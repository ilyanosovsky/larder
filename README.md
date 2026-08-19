# Larder 🥫

[![CI](https://github.com/ilyanosovsky/larder/actions/workflows/ci.yml/badge.svg)](https://github.com/ilyanosovsky/larder/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

**Shared household food hub.** Plan the week's dishes → the shopping cart assembles itself → shop together → groceries land in the pantry → cook from your own recipe library → repeat.

Larder replaces the shared iPhone note a couple actually uses today: a shared shopping list without duplicates where every edit saves instantly (instant push sync is planned post-MVP), a pantry of what's at home, recipes imported from Instagram screenshots and links into one clean format, a weekly menu pool, and an AI assistant that suggests — never dictates.

> Status: **in active development.** Live task board: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) (ru). UI is Russian (i18n-ready, English planned).

## Features (MVP scope)

- 🛒 **Shared cart** — two people, different stores: every change saves instantly, and the partner's view catches up on focus, pull-to-refresh, and gentle background polling (instant push is planned post-MVP). Optimistic UI that survives dead spots near the checkout. Statuses: needed → ordered (delivery: Wolt/Carrefour) → bought. Duplicates are impossible by construction.
- 🏠 **Pantry** — what's at home (presence, no quantity bookkeeping). "Ran out" → one tap → back in the cart. Swipe-through revision mode.
- 📖 **Recipes** — one clean format: ingredients linked to the product catalog, steps, portions, required equipment. Import from a **photo/screenshot** (primary path), URL (JSON-LD → microdata → FireCrawl cascade), pasted text, or manually. Everything the AI produces is editable.
- 🗓 **Weekly menu** — a pool of dishes for the week; one button merges all ingredients into the cart, checked against the pantry.
- 🤖 **Assistant** — "build me a menu for the week", "what can I cook from what's home?", substitutions, portion scaling, adaptation to your actual kitchen equipment. Hard monthly budget cap.
- 📱 **Mobile-first PWA** — installable on the home screen; desktop layout included.

## Tech stack

Next.js 15 (App Router) · TypeScript strict · PostgreSQL + Drizzle · tRPC v11 + TanStack Query (optimistic updates + refetch sync; instant realtime is post-MVP) · Better Auth (Google + magic link) · OpenAI (vision parsing + assistant) · FireCrawl (fallback scraping) · UploadThing (images) · Resend (email) · next-intl · vitest · Vercel (app) + Railway (Postgres)

Architecture details and the reasoning behind every choice: [VISION.md](VISION.md) (ru). Screens and design system (Paper Ledger): [DESIGN_BRIEF.md](DESIGN_BRIEF.md) (ru) + [design/](design/).

## Getting started

Prerequisites: Node.js 22+, pnpm, Docker (for local Postgres) or a Postgres instance.

```bash
git clone https://github.com/ilyanosovsky/larder.git
cd larder
pnpm install
cp .env.example .env.local   # fill in the values (see table below)
docker compose up -d         # local Postgres
pnpm db:migrate
pnpm dev
```

Scripts: `pnpm dev` · `pnpm build` · `pnpm lint` · `pnpm typecheck` · `pnpm test` (vitest) · `pnpm format` · `pnpm db:generate` · `pnpm db:migrate` · `pnpm db:push` · `pnpm db:studio` · `pnpm db:seed`.

## Environment variables

Local values go to `.env` / `.env.local` (gitignored; keep `DATABASE_URL` pointing at localhost — drizzle-kit auto-loads `.env`, and a prod URL there would aim local migrations at production). Production values go to **Vercel → Project → Settings → Environment Variables**; the production `DATABASE_URL` additionally lives as a **GitHub Actions secret** for the migration workflow. The test CI needs no secrets.

| Variable                                    | Purpose                            | Where to get it                                                                |
| ------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------ |
| `DATABASE_URL`                              | Postgres connection string         | Railway Postgres plugin / local Docker                                         |
| `BETTER_AUTH_SECRET`                        | Auth encryption secret (≥32 chars) | `openssl rand -base64 32`                                                      |
| `BETTER_AUTH_URL`                           | App base URL for auth callbacks    | `http://localhost:3000` locally                                                |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google sign-in                     | Google Cloud Console → OAuth client (add redirect URIs for localhost and prod) |
| `RESEND_API_KEY`                            | Magic-link and invite emails       | resend.com (verified custom domain required in prod)                           |
| `EMAIL_FROM`                                | From address for emails            | e.g. `Larder <noreply@yourdomain.tld>`                                         |
| `OPENAI_API_KEY`                            | Recipe parsing + assistant         | platform.openai.com                                                            |
| `AI_MONTHLY_BUDGET_USD`                     | Hard cap for AI spend (default 20) | —                                                                              |
| `FIRECRAWL_API_KEY`                         | Fallback recipe scraping           | firecrawl.dev                                                                  |
| `UPLOADTHING_TOKEN`                         | Image uploads                      | uploadthing.com                                                                |
| `NEXT_PUBLIC_APP_URL`                       | Public app URL                     | `http://localhost:3000` locally                                                |

Details and step-by-step setup: [wiki → Env Setup](https://github.com/ilyanosovsky/larder/wiki/Env-Setup).

## Development workflow

- Every change goes through a PR into `main`. The branch is protected: CI must be green, and **every review conversation must be resolved** before merge (yes, including the admin).
- [CodeRabbit](https://coderabbit.ai) reviews every PR; all its comments get a fix or a reasoned reply.
- Tests: vitest. Business logic (cart merge rules, parsers, invariants) is covered; recipe parsers run against saved HTML fixtures.
- The task board lives in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) and is updated in the same PR that does the work.
- The [wiki](https://github.com/ilyanosovsky/larder/wiki) is generated from [`docs/wiki/`](docs/wiki/) and auto-synced on merge — edit it there, never on GitHub directly.
- Working rules for AI agents (and humans): [CLAUDE.md](CLAUDE.md).

## Deployment

App on **Vercel** (auto-deploys `main`, Hobby tier, $0), PostgreSQL on **Railway** (Hobby plan, $5/month including its usage credit — Postgres fits inside). Migrations reach production only through the [`migrate.yml`](.github/workflows/migrate.yml) GitHub Action (triggered by migration changes on `main`), so they must stay backward-compatible. Full setup guide: [wiki → Deploy](https://github.com/ilyanosovsky/larder/wiki/Deploy).

## License

[MIT](LICENSE) © Ilya Nosovsky
