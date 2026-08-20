# Environment variables

Places a value can live:

| Place                                    | What goes there                                                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `.env` / `.env.local` (gitignored)       | All variables, local development values. `DATABASE_URL` must stay localhost — see the warning below                 |
| Vercel → Project → Environment Variables | All variables, production values (`BETTER_AUTH_URL`/`NEXT_PUBLIC_APP_URL` = the vercel.app domain)                  |
| GitHub → repo → Actions secrets          | `DATABASE_URL` (Railway Postgres URL) for the migration workflow; `WIKI_TOKEN` only if the default token can't push |

The test CI runs without secrets by design — tests must never call external services. The only secret-bearing workflow is `migrate.yml`.

> ⚠️ **drizzle-kit preloads `.env` with its own bundled dotenv** before our config runs, so a production `DATABASE_URL` in `.env` would silently point local `pnpm db:migrate` / `db:push` at production. Keep the localhost URL as the active value. A commented `# PROD_DATABASE_URL=` line in `.env` is storage only — nothing reads it; a deliberate production operation enters the URL via a hidden prompt so it never lands in shell history: `read -r -s -p 'Prod DATABASE_URL: ' DATABASE_URL && export DATABASE_URL && pnpm db:migrate; unset DATABASE_URL` (the shell environment beats env files).

## Variables

| Variable                | Required | Notes                                                                                                                                                                                          |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`          | ✅       | Local: `docker compose up -d` gives `postgresql://postgres:postgres@localhost:5432/larder`. Prod: reference the Railway Postgres service                                                       |
| `BETTER_AUTH_SECRET`    | ✅       | ≥ 32 chars; `openssl rand -base64 32`                                                                                                                                                          |
| `BETTER_AUTH_URL`       | ✅       | Base URL: `http://localhost:3000` locally, the public domain in prod                                                                                                                           |
| `GOOGLE_CLIENT_ID`      | ✅       | Google Cloud Console → APIs & Services → Credentials → OAuth client (Web). Add redirect URI `{BETTER_AUTH_URL}/api/auth/callback/google` for both localhost and prod                           |
| `GOOGLE_CLIENT_SECRET`  | ✅       | Same OAuth client                                                                                                                                                                              |
| `RESEND_API_KEY`        | ✅       | resend.com → API Keys. **Prod requires a verified custom domain** (magic links won't send to arbitrary addresses without it) — this is a launch prerequisite                                   |
| `EMAIL_FROM`            | ✅       | e.g. `Larder <noreply@yourdomain.tld>`; the domain must be the one verified in Resend                                                                                                          |
| `OPENAI_API_KEY`        | ✅       | platform.openai.com. **Used at runtime since task 1.3** — `product.create` calls it to pick an icon and a department. Cheap model + `reasoning_effort: low`; assistant respects the budget cap |
| `AI_MONTHLY_BUDGET_USD` | —        | Default 20. At the cap the assistant switches off until next month; import keeps working                                                                                                       |
| `FIRECRAWL_API_KEY`     | ✅       | firecrawl.dev — fallback recipe scraping only (~1000 free credits/month)                                                                                                                       |
| `UPLOADTHING_TOKEN`     | ✅       | uploadthing.com (2 GB free tier — images are client-compressed to ~300 KB before upload)                                                                                                       |
| `NEXT_PUBLIC_APP_URL`   | ✅       | Public app URL, exposed to the client                                                                                                                                                          |

Adding a new variable? Update `.env.example`, the README table, and this page — in the same PR (rule in [CLAUDE.md](https://github.com/ilyanosovsky/larder/blob/main/CLAUDE.md)).

**Missing `OPENAI_API_KEY` is not fatal.** It is declared required, but the app never reads it until an AI call happens, and the one AI path that exists (`product.create` with `source: "new"`) treats a client it cannot build exactly like any other enrichment failure: the product is still created, with 🛒 / «Бакалея» / «шт», and the `ai_jobs` row records the error. So a deployment without the key loses icon-picking, not product creation — and `pnpm build`, which runs with no environment at all, is unaffected.
