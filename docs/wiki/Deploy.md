# Deployment

Production topology (decided 2026-08-19):

| Piece         | Where                                                                                                             | Cost     |
| ------------- | ----------------------------------------------------------------------------------------------------------------- | -------- |
| Next.js app   | **Vercel** (Hobby), auto-deploys `main`                                                                           | $0       |
| PostgreSQL    | **Railway** (Postgres service only)                                                                               | ~$1–3/mo |
| DB migrations | **GitHub Action** [`migrate.yml`](https://github.com/ilyanosovsky/larder/blob/main/.github/workflows/migrate.yml) | —        |

Production URL: https://larder-ecru-mu.vercel.app

## Environment

- **Vercel → Project → Settings → Environment Variables**: every variable from [[Env-Setup]] with production values. Watch two of them:
  - `BETTER_AUTH_URL` = `https://larder-ecru-mu.vercel.app` (auth callbacks break if this is localhost)
  - `NEXT_PUBLIC_APP_URL` = same
  - `DATABASE_URL` = the Railway Postgres public URL
- **GitHub → repo → Settings → Secrets and variables → Actions**: secret `DATABASE_URL` (same Railway URL) — used only by the migration workflow.

## Migrations

Vercel never runs migrations. The `migrate.yml` workflow applies them to production when `src/db/migrations/**` changes land on `main` (plus a manual "Run workflow" button). Consequences:

- Code deploy (Vercel) and migration (Action) are **not atomic** — write backward-compatible, additive migrations (rule in AGENTS.md).
- Locally, `.env` must keep only the localhost `DATABASE_URL`: **drizzle-kit preloads `.env` with its own bundled dotenv**, so a production URL there would silently point local `pnpm db:migrate` / `db:push` at production. The prod URL lives commented-out as `# PROD_DATABASE_URL=` for deliberate use only.

## External services checklist

- **Google OAuth**: two authorized redirect URIs — `http://localhost:3000/api/auth/callback/google` and `https://larder-ecru-mu.vercel.app/api/auth/callback/google`.
- **Resend**: until a custom domain is verified, magic-link emails deliver only to the account owner's address (test mode). Domain verification is the launch prerequisite (plan task 7.3).

## Verifying a deploy

- `https://larder-ecru-mu.vercel.app/api/health` → `{"ok":true}`
- `/login` renders; `/` redirects to `/login` when signed out
- After schema changes: the migrate workflow run is green in the Actions tab

## Post-MVP note

Instant realtime (VISION §6.3) will need either a managed channel (Pusher/Ably — serverless-friendly) or moving the app to an always-on host. The client-side `splitLink` groundwork already exists in `src/trpc/client.tsx`.
