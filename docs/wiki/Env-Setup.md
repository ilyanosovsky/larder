# Environment variables

Three places a value can live:

| Place | What goes there |
|---|---|
| `.env.local` (gitignored) | All variables, local development values |
| Railway → app service → Variables | All variables, production values |
| GitHub → repo secrets | Only `WIKI_TOKEN`, and only if the default token can't push to the wiki |

CI runs without secrets by design — tests must never call external services.

## Variables

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | ✅ | Local: `docker compose up -d` gives `postgresql://postgres:postgres@localhost:5432/larder`. Prod: reference the Railway Postgres service |
| `BETTER_AUTH_SECRET` | ✅ | ≥ 32 chars; `openssl rand -base64 32` |
| `BETTER_AUTH_URL` | ✅ | Base URL: `http://localhost:3000` locally, the public domain in prod |
| `GOOGLE_CLIENT_ID` | ✅ | Google Cloud Console → APIs & Services → Credentials → OAuth client (Web). Add redirect URI `{BETTER_AUTH_URL}/api/auth/callback/google` for both localhost and prod |
| `GOOGLE_CLIENT_SECRET` | ✅ | Same OAuth client |
| `RESEND_API_KEY` | ✅ | resend.com → API Keys. **Prod requires a verified custom domain** (magic links won't send to arbitrary addresses without it) — this is a launch prerequisite |
| `EMAIL_FROM` | ✅ | e.g. `Larder <noreply@yourdomain.tld>`; the domain must be the one verified in Resend |
| `OPENAI_API_KEY` | ✅ | platform.openai.com. Cheap model + `reasoning_effort: low` for parsing; assistant respects the budget cap |
| `AI_MONTHLY_BUDGET_USD` | — | Default 20. At the cap the assistant switches off until next month; import keeps working |
| `FIRECRAWL_API_KEY` | ✅ | firecrawl.dev — fallback recipe scraping only (~1000 free credits/month) |
| `UPLOADTHING_TOKEN` | ✅ | uploadthing.com (2 GB free tier — images are client-compressed to ~300 KB before upload) |
| `NEXT_PUBLIC_APP_URL` | ✅ | Public app URL, exposed to the client |

Adding a new variable? Update `.env.example`, the README table, and this page — in the same PR (rule in [CLAUDE.md](https://github.com/ilyanosovsky/larder/blob/main/CLAUDE.md)).
