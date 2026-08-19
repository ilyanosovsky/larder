# Development workflow

## The loop

1. Pick the next unblocked task from [IMPLEMENTATION_PLAN.md](https://github.com/ilyanosovsky/larder/blob/main/IMPLEMENTATION_PLAN.md).
2. Branch from `main`: `feat/<task-id>-<slug>` (e.g. `feat/2.1-cart-model`), `fix/...` or `chore/...`.
3. Implement with tests (vitest). Conventional Commits.
4. Open a PR. The same PR updates the task's row in IMPLEMENTATION_PLAN.md and any affected `docs/wiki/` pages.
5. CodeRabbit reviews. Work through **every** comment: fix it, or reply with a reasoned rejection — then resolve the thread.
6. Merge (squash) when CI is green and all conversations are resolved. `main` is protected by a ruleset that applies to admins as well.

## Branch protection (ruleset on `main`)

- PR required, direct pushes blocked
- Required status check: **CI**
- Required conversation resolution — merge impossible with unresolved review threads
- Squash merge only, no force pushes, no deletions
- No bypass actors: the rules apply to admins too (platform caveat: the repo owner can still edit or delete the ruleset itself — don't)

## CI

`.github/workflows/ci.yml`: lint → typecheck → vitest → build, on every PR and push to main. No secrets in CI — tests never call external services; parsers run on saved HTML fixtures.

## Wiki sync

`.github/workflows/wiki-sync.yml` publishes `docs/wiki/**` to this wiki on every merge to `main` that touches those files. The sync overwrites the wiki — never edit pages on GitHub directly. If the sync job fails with a permissions error, create a classic PAT with `repo` scope and add it as the `WIKI_TOKEN` repository secret.

## Auth (Better Auth)

Two ways in, no passwords: **Google OAuth** and a **magic link** emailed through Resend. The OAuth redirect URI to register in Google Cloud Console is `{BETTER_AUTH_URL}/api/auth/callback/google` — see [[Env-Setup]].

Layout of the pieces:

| File                         | Role                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `src/lib/auth.ts`            | Lazy singleton `auth()` — importing it never reads env, so CI builds without secrets |
| `src/lib/auth-client.ts`     | Shared browser client (`authClient`) for client components                           |
| `src/lib/session.ts`         | `getSession()` for server components, layouts and server actions                     |
| `src/app/api/auth/[...all]/` | The Better Auth request handler                                                      |
| `src/middleware.ts`          | Optimistic cookie check — fast redirect, no database round-trip                      |
| `src/app/(app)/layout.tsx`   | Authoritative session check for every signed-in screen                               |
| `src/app/(auth)/login/`      | S1 «Вход» — the only screen rendered without the app shell                           |

**Adding a protected screen:** put it under `src/app/(app)/`. The layout's session check covers it automatically; no middleware change is needed.

### Regenerating the auth tables

The `users` / `sessions` / `accounts` / `verifications` tables are generated — never hand-written, and never hand-edited afterwards. Regenerate them when the Better Auth version or its plugin list changes, pinning the generator to the `better-auth` version in `package.json` (currently 1.7.1):

```bash
pnpm dlx auth@1.7.1 generate --config better-auth.config.ts --output src/db/auth-schema.ts -y
pnpm db:generate   # drizzle-kit turns the schema diff into a migration
pnpm db:migrate
```

`better-auth.config.ts` in the repository root exists _only_ for that generator: the CLI needs a plain `auth` export, while the runtime instance is a lazy factory. It shares the adapter shape with the runtime through `src/lib/auth-drizzle-config.ts`, so the two cannot drift.

## API (tRPC)

tRPC v11 + TanStack Query v5, superjson on the wire, Zod at every boundary. The client side uses the current `@trpc/tanstack-react-query` integration (option builders such as `trpc.cart.list.queryOptions()`), not the legacy `@trpc/react-query` hook proxy.

| File                               | Role                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/server/api/trpc.ts`           | `initTRPC` — superjson transformer, `errorFormatter`, `publicProcedure`, `protectedProcedure` |
| `src/server/api/context.ts`        | `createTRPCContext()` — `{ session, user, db }` for one request                               |
| `src/server/api/root.ts`           | `appRouter`, the `AppRouter` type, `createCaller`                                             |
| `src/server/api/routers/*.ts`      | One router per feature, with its Zod output schemas next to it                                |
| `src/app/api/trpc/[trpc]/route.ts` | The single HTTP endpoint (`fetchRequestHandler`)                                              |
| `src/trpc/query-client.ts`         | `makeQueryClient()` — shared defaults, superjson dehydrate/hydrate                            |
| `src/trpc/client.tsx`              | `TRPCReactProvider` (mounted in the root layout), `useTRPC()`, the links                      |
| `src/trpc/server.tsx`              | `caller`, `trpc` options proxy, `prefetch`, `HydrateClient` for server components             |

### Adding a router

1. Create `src/server/api/routers/<feature>.ts`. Export the Zod output schemas from the same file — a form and an OpenAI structured output should reuse the identical contract. Nullable fields use `.nullable()`, never `.optional()`.
2. Build procedures from `publicProcedure` / `protectedProcedure`, never from a fresh `t`.
3. Mount it on `appRouter` in `src/server/api/root.ts` under its own namespace.
4. Add colocated vitest coverage with `createCaller(<fabricated context>)` — no database, no network.

Keep `import "server-only"` out of `trpc.ts`, `root.ts` and the routers: the client type-imports `AppRouter`, and later screens will reuse those Zod schemas. Only `context.ts` and `src/trpc/server.tsx` are marked server-only.

### Public vs protected

`src/middleware.ts` excludes `/api/**`, so nothing gates the endpoint — **authorization is per-procedure**.

- `publicProcedure` — reachable signed out. `ctx.session` and `ctx.user` are nullable.
- `protectedProcedure` — throws `UNAUTHORIZED` (HTTP 401) without a session, and narrows the context so `ctx.user` is non-null in the resolver. No `!` assertions downstream.

Household membership is a separate check, added with the first household-scoped router (VISION §6.7).

### Calling it

- Client component: `const trpc = useTRPC(); useQuery(trpc.health.ping.queryOptions())`.
- Server component, one value: `await caller.health.whoami()` from `@/trpc/server` — in-process, no HTTP.
- Server component, prefetch for a client child: `prefetch(trpc.health.ping.queryOptions())` and wrap the child in `<HydrateClient>`.

`staleTime` defaults to 30 s. It must stay above zero, or every server-prefetched query is refetched the instant the client hydrates.

### Errors

`errorFormatter` adds `data.zodError` to every error response — `null` for non-validation failures, `{ formErrors, fieldErrors }` for a `BAD_REQUEST` caused by an input schema. Forms map `fieldErrors` straight onto inputs.

### splitLink groundwork (for task 2.2)

The client already routes through `splitLink({ condition: (op) => op.type === "subscription", ... })`. Both branches currently point at the same `httpBatchStreamLink`, because the router exposes no subscriptions yet. When the realtime household channel lands (VISION §6.3), the `true` branch becomes `httpSubscriptionLink({ transformer: superjson, url: getUrl() })` and nothing else in the client has to change.

## Model routing (AI-assisted development)

- **Fable** — orchestration: planning, architecture, task decomposition, reviewing subagent output, plan updates.
- **Opus** — tasks labeled `opus` in the plan (realtime infra, cart invariants, import pipeline, assistant).
- **Sonnet** — tasks labeled `sonnet` (UI screens from the design export, CRUD, seeds, settings).

Full rules: [CLAUDE.md](https://github.com/ilyanosovsky/larder/blob/main/CLAUDE.md).
