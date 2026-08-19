# Deploying to Railway

One Railway project hosts both services: the Next.js app (always-on Node process — SSE realtime requires it; Railway's serverless mode is incompatible) and Postgres. Realistic cost with RAM billing: **$5–10/month**.

The repo side is already configured in [`railway.json`](https://github.com/ilyanosovsky/larder/blob/main/railway.json):

- build: Nixpacks (detects pnpm via the `packageManager` field)
- pre-deploy: `pnpm db:migrate` — migrations run against the service's `DATABASE_URL` before the new version goes live
- start: `pnpm start`
- healthcheck: `GET /api/health` (env-free, DB-free readiness probe)

## One-time dashboard setup

1. **Create a project** → add **PostgreSQL** (template) to it.
2. **Add a service from GitHub repo** `ilyanosovsky/larder`, deploy branch `main`.
3. **Variables** on the app service (Variables → Raw Editor — paste values yourself, they should never transit through chat):
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (a reference, not a copy)
   - everything else from your local `.env` (see [[Env-Setup]]), except the local-only values below.
4. **Networking → Generate Domain** on the app service. Then update:
   - `BETTER_AUTH_URL` = `https://<your-domain>`
   - `NEXT_PUBLIC_APP_URL` = `https://<your-domain>`
5. **Google OAuth**: add `https://<your-domain>/api/auth/callback/google` as a second authorized redirect URI in Google Cloud Console (keep the localhost one for dev).
6. **Resend**: production magic links require a verified custom domain in Resend; until then email sign-in works only to the account owner's address (Resend test mode). Google sign-in is unaffected.

## Verifying a deploy

- `https://<your-domain>/api/health` → `{"ok":true}`
- `https://<your-domain>/login` renders; `/` redirects to `/login` when signed out.
- Deploy logs show `migrations applied successfully!` in the pre-deploy step.

## Notes

- Merges to `main` auto-deploy (Railway watches the branch). CI must be green to merge, so broken builds don't reach deploys.
- Never point a local shell at the production `DATABASE_URL` — migrations reach production only via the pre-deploy command.
