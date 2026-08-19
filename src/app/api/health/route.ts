/**
 * Deploy-time readiness probe (railway.json healthcheckPath). Deliberately
 * env-free and DB-free: migrations run in the pre-deploy command, so by the
 * time this responds the schema is already in place; a DB ping here would
 * only turn transient DB hiccups into failed deploys.
 */
export function GET(): Response {
  return Response.json({ ok: true });
}
