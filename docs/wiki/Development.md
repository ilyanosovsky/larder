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
| `src/app/(app)/layout.tsx`   | Authoritative session + household check for every signed-in screen                   |
| `src/app/(auth)/login/`      | S1 «Вход» — rendered without the app shell                                           |

**Adding a protected screen:** put it under `src/app/(app)/`. The layout's session and household checks cover it automatically; no middleware change is needed.

### Where you land after signing in (`?next=`)

A signed-out visitor is not simply dumped on `/login`: `resolveAuthRedirect` builds `/login?next=<encoded pathname>`, and the login page hands that path to Better Auth as the `callbackURL` for both Google and the magic link. Without it, a partner who taps an invite link while signed out lands on the cart, gets bounced to onboarding, and may create a household of their own — after which the invitation can never be accepted (one household per user, and MVP has no way to leave one).

`next` is attacker-controlled, so **every read of it goes through `sanitizeNextPath()`** (`src/lib/auth-redirect.ts`), which falls back to `/` for anything that is not plainly an in-app path: absolute URLs, protocol-relative `//host` and `/\host`, values hiding a second URL behind a control character or space, relative paths, and `/login` itself. Skipping it turns our own sign-in screen into an open redirect. `loginPathFor(pathname)` is the matching builder — use it instead of a bare `LOGIN_PATH` wherever a server component redirects someone to sign in.

### Regenerating the auth tables

The `users` / `sessions` / `accounts` / `verifications` tables are generated — never hand-written, and never hand-edited afterwards. Regenerate them when the Better Auth version or its plugin list changes, pinning the generator to the `better-auth` version in `package.json` (currently 1.7.1):

```bash
pnpm dlx auth@1.7.1 generate --config better-auth.config.ts --output src/db/auth-schema.ts -y
pnpm db:generate   # drizzle-kit turns the schema diff into a migration
pnpm db:migrate
```

`better-auth.config.ts` in the repository root exists _only_ for that generator: the CLI needs a plain `auth` export, while the runtime instance is a lazy factory. It shares the adapter shape with the runtime through `src/lib/auth-drizzle-config.ts`, so the two cannot drift.

## Onboarding & households

Everything in Larder belongs to a household (VISION §5). A signed-in user without one has no data to look at, so `src/app/(app)/layout.tsx` runs a second gate right after the session check: `caller.household.current()` returns `null` → redirect to `/onboarding`.

Both onboarding screens therefore live **outside** the `(app)` group, in `src/app/(onboarding)/` — inside it, the gate would redirect them to themselves:

| Route             | What it is                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `/onboarding`     | S2: create a household, then the «Пригласи своих» view with the invite link and a copy button |
| `/invite/[token]` | The screen an invite link opens: «Аня приглашает тебя в «Наш дом»» + «Вступить»               |

Both are still behind the auth middleware, so only signed-in visitors reach them — signed-out ones go through `/login?next=…` and come back (see above).

`/onboarding` runs in two phases, and the split is load-bearing: **once the household exists it exists for good.** Creating it and minting the first invite are separate steps with separate error states, because folding a failed mint back into the create form would strand the user — every retry would hit the "one household per user" CONFLICT and show the same error forever. So a CONFLICT from `household.create` is treated as success (it already exists: this submit is a retry, or a second tab won), the invite step owns its own retry button, and «Продолжить» is always available — the link can be minted later, the household cannot be created twice. `isConflictError()` in `src/lib/trpc-errors.ts` reads the code off the client error.

### Invite links

One-time, with a TTL (VISION §6.7). The rules live in `src/server/invites.ts`, free of tRPC and the database so every branch is unit-tested:

- `createInviteToken()` — 32 random bytes, base64url, so the token needs no URL escaping.
- `INVITE_TTL_MS` — 7 days. An invite is `expired` from its `expiresAt` instant onwards; the boundary itself is already too late.
- `previewInvite()` / `decideInviteAccept()` — the decision tables the two routers execute.

Unknown, expired and already-used tokens all surface as one indistinguishable `invalid` (preview) / `NOT_FOUND` (accept): someone guessing tokens must not learn which of the three they hit. The exception is a caller who is already a member of the invite's household — they get a friendly "you're already in" instead, which leaks nothing they don't know.

**The claim UPDATE is the single authority on whether an invite may be redeemed.** `decideInviteAccept()` runs against the application clock on a row read a moment earlier, so it decides what to _tell_ the caller and nothing more. Every condition is then repeated in the write, evaluated once and atomically against the database clock:

```sql
UPDATE invites SET used_at = now(), used_by = $2
WHERE id = $1 AND used_at IS NULL AND expires_at > now()
```

Both conditions have to be there. Dropping `used_at IS NULL` lets two people redeem one link; dropping `expires_at > now()` lets a request that crosses the TTL in flight redeem an expired one. The membership insert is guarded the same way, by the unique index on `household_members.user_id` (the "one household per user" MVP invariant). Two people opening the same link therefore race in Postgres; the loser gets `NOT_FOUND` or `CONFLICT`, never a duplicate row.

`isUniqueViolation()` in `src/server/db-errors.ts` turns that index violation into a domain error instead of a 500 — reuse it for the cart invariant in task 2.1. It **walks the `cause` chain**, which is not optional: since drizzle-orm 0.44 the postgres.js error arrives wrapped in a `DrizzleQueryError`, so a top-level `code` check silently stops matching and every lost race becomes an INTERNAL_SERVER_ERROR.

### Household routers

| Procedure           | Boundary             | Notes                                                           |
| ------------------- | -------------------- | --------------------------------------------------------------- |
| `household.current` | `protectedProcedure` | `{ household, members } \| null` — null is normal, not an error |
| `household.create`  | `protectedProcedure` | CONFLICT if the caller already has one                          |
| `invite.create`     | `householdProcedure` | Mints a link for the caller's own household                     |
| `invite.preview`    | `protectedProcedure` | Read-only, for rendering the join screen                        |
| `invite.accept`     | `protectedProcedure` | Redeems the link and creates the membership                     |

The three `protectedProcedure` entries cannot use `householdProcedure`: their whole audience is people who have no household yet.

## Categories (store departments)

Every household groups its cart and catalog by department — "отдел" — (VISION §3.1, §5): `categories` (`src/db/schema.ts`) is `id`, `householdId`, `name`, `icon` (emoji), `sortOrder`, unique on `(householdId, name)`.

- **Defaults.** `src/server/catalog/default-categories.ts` holds the 7 departments in DESIGN_BRIEF §5's route order (Овощи и фрукты → Молочное и яйца → Мясо и курица → Хлеб и выпечка → Бакалея → Заморозка → Хозяйственное). `household.create` inserts them, in that order as `sortOrder` 0–6, in the same transaction that creates the membership — a household is never left without departments to group its cart by.
- **Backfill.** Migration `0003_true_tigra` adds the table and then backfills the same 7 rows into any household that predates it (`INSERT ... WHERE NOT EXISTS (SELECT 1 FROM categories WHERE household_id = ...)`). Only that backfill `INSERT` is idempotent — a household that already has categories is left alone if it runs again. The migration as a whole is not re-runnable: `CREATE TABLE "categories"` has no `IF NOT EXISTS`, so drizzle's migration journal (which runs each migration file exactly once) is what actually keeps it from executing twice, not the `INSERT`'s own guard.
- **Reference catalog.** `src/server/catalog/reference-products.ts` is a separate, static, in-code list of common Russian household products (189 items, pinned by test) with an icon/department/default unit — the free, instant half of the task 1.3 autocomplete. It is not database data and the seed script does not touch it.
- **Units.** `src/lib/units.ts` is the shared `UNITS`/`Unit`/`unitSchema` contract — cart items, the reference catalog and recipe ingredients all reuse it rather than redeclaring their own unit list.

### `category` router

| Procedure          | Boundary             | Notes                                                                           |
| ------------------ | -------------------- | ------------------------------------------------------------------------------- |
| `category.list`    | `householdProcedure` | The caller's departments, ordered by `sortOrder`                                |
| `category.reorder` | `householdProcedure` | `{ orderedIds: uuid[] }` (1–100). Rewrites `sortOrder` to each id's array index |

`reorder` validates `orderedIds` with `checkReorderPermutation()` (`src/server/catalog/reorder.ts`, pure and unit-tested on its own) before writing anything: it must be exactly the household's own category ids, each appearing once — a missing id, an extra/foreign id, or a duplicate all reject with `BAD_REQUEST` and touch no row. There is no create/delete endpoint yet and no drag UI (task 7.1 adds the screen for this router).

## Product catalog & AI enrichment

The household's own product list (VISION §3.1, §5). **Everything that will ever go into the cart resolves to a row here first** — that is what makes "одна активная строка на продукт" expressible at all, and what keeps «помидоры» from appearing twice in one list.

`products` (`src/db/schema.ts`): `householdId`, `categoryId` (FK `restrict` — a department with products in it must not vanish), `name`, `icon`, `defaultUnit`, `aliases[]`, `createdBy` (`set null`). The unique index is on **`(householdId, lower(name))`**, not on `name`: "Молоко" and "молоко" are one product.

### Normalization

`normalizeProductName()` (`src/server/catalog/normalize.ts`) is the single definition of "the same product": trim, lower-case, **ё → е**, collapse whitespace. Every comparison in the feature goes through it — ranking, the reference merge, the duplicate check, and the reference-catalog invariants test. Only case-insensitivity is also enforced in the database; the rest is matching, and a near-duplicate that slips past it stays editable.

The module is pure string code with no server dependencies, so the S4 sheet imports it too — that is how the client and the server agree on when to offer «Создать „…“».

### Search (`src/server/catalog/search.ts`, pure, unit-tested)

`searchCatalog({ query, products, categories })` ranks the household's rows and the built-in 189-item reference catalog **by the same rules**, and the sheet renders both identically. That sameness is the feature: a shopper typing «пом» should not care whether «Помидоры» already exists in their catalog.

Tiers, best first: exact name → name prefix → word-boundary prefix → substring, then the same four again for aliases. Every name match beats every alias match. Ties break by source (the household's own row first), then shorter name, then alphabetically. At most 10 results; an empty query returns nothing.

Two things worth not breaking:

- **Matching is `indexOf`/`startsWith`, never a regex built from the query.** A regex would need escaping, and «сыр (твёрдый)» would otherwise be a `SyntaxError` in the middle of someone's shopping.
- **A reference entry is dropped when the household already owns it under any spelling** — names _and_ aliases compared in both directions. Without that, someone who created «Помидорки» with the alias «помидоры» would see their row next to the built-in «Помидоры», and picking the wrong one makes the exact duplicate this design exists to prevent.

Reference entries carry a `categorySlug`; `resolveCategoryIdForSlug()` (`src/server/catalog/resolve-category.ts`) maps it onto the household's own department **by name**, because `categories` rows carry no slug — a household may rename or reorder them. A department that no longer matches falls back to «Бакалея», and failing that to the first department by walking order. That same `fallbackCategoryId()` is what the AI failure path uses.

### `product` router

| Procedure        | Boundary             | Notes                                                                        |
| ---------------- | -------------------- | ---------------------------------------------------------------------------- |
| `product.search` | `householdProcedure` | `{ query }` → ≤ 10 hits; `productId` is `null` for a reference hit           |
| `product.list`   | `householdProcedure` | The whole catalog, ordered by department `sortOrder` then name               |
| `product.create` | `householdProcedure` | `{ source: "reference" \| "new", name }` → `{ product, enriched, aiFailed }` |
| `product.update` | `householdProcedure` | Partial patch; `categoryId` is checked against the caller's own departments  |

**`create` never trusts the client with anything but a name.** `source: "reference"` re-resolves the entry out of `REFERENCE_PRODUCTS` server-side and takes the icon, department, unit and aliases from there — a tampered request cannot file a product under an arbitrary category. `source: "new"` is the only path that spends money.

**`create` is idempotent by name.** It looks for an existing row first (`lower(name)` _or_ an alias match), so a repeat create returns the existing product without an AI call; and if a concurrent insert wins the `lower(name)` unique index, the loser reads the winner's row back instead of surfacing a violation. Two taps, two tabs and two partners all end with one product.

### AI enrichment

`enrichProduct()` (`src/server/ai/enrich-product.ts`) asks for `{ icon, categoryId, unit }` in one structured-output call.

- Model and prices live in `src/server/ai/pricing.ts` — `gpt-5-mini`, `reasoning_effort: "low"` (VISION §6.5: invisible reasoning tokens are billed as output and would multiply a sub-cent call).
- The JSON schema comes from the Zod schema through **Zod v4's own `z.toJSONSchema`**, not the OpenAI SDK's `zodResponseFormat` helper — that helper targets Zod v3 internals. One schema both describes the response and validates it, so the two cannot drift. Schemas for AI use `.nullable()`, never `.optional()`: strict mode cannot express an optional property.
- **`categoryId` is re-checked against the ids we actually sent**, after parsing. Strict mode constrains the shape of the field, never its value, and a hallucinated uuid would otherwise file the product into nothing. The icon is checked for being plausibly a single emoji.
- **The function never throws.** Network error, refusal, malformed JSON, invented department — all come back as `ok: false`.

**Failure is not an error the user sees as one.** Whatever goes wrong, the product is still created, with 🛒 / «Бакалея» / «шт», and `aiFailed: true` tells the sheet to show a calm amber "проверь иконку и отдел" (DESIGN_BRIEF §6: yellow, not red). VISION §3.1 is explicit that the AI is a helper and everything is editable — one tap opens the edit form. This covers a missing `OPENAI_API_KEY` too: the router catches `ctx.openai()` failing to build a client and treats it the same way.

### `AiJob` lifecycle and cost

`ai_jobs` is written for **every** AI call, from this first one (AGENTS.md):

1. Insert `status: "running"`, `type: "product_enrich"`, `inputRef: <product name>` — **before** the call, so the rate limiter counts requests that are still in flight.
2. On success: `status: "done"`, `outputJson`, `costUsd`, `finishedAt`.
3. On failure: `status: "error"`, `error`, `costUsd`, `finishedAt`.

`costUsd` is recorded on the failure branch too whenever a response came back: a validation failure after a successful HTTP call **was billed**, and a ledger that only counts successes under-reports exactly when things go wrong. `numeric(10, 6)` — six decimals, so a $0.0002 icon lookup does not round to zero.

`AI_MONTHLY_BUDGET_USD` is **not** checked here. It caps the assistant only (task 6.1); icon-picking and recipe import keep working at the cap.

### Rate limiting

`src/server/ai/rate-limit.ts`: **10 per minute and 100 per day, per user**, applied to the enrichment path only (the free reference path is never limited).

Counted with one indexed `count(*)` over `ai_jobs` — the day's rows counted once, the minute's counted again with a `FILTER` over the same scan. **In the database, not in memory**, because the app is serverless: two requests a second apart routinely land in different Vercel instances, so an in-process counter would limit nothing. Windows slide, so nobody gets a fresh allowance at the top of the minute. The decision itself is a pure `checkRateLimit()`; the router turns a refusal into `TOO_MANY_REQUESTS`, and `isRateLimitedError()` (`src/lib/trpc-errors.ts`) is how the sheet tells it apart from a generic failure.

One trap worth knowing: a bare `Date` interpolated into a raw `sql` fragment is bound **without its column's type**, and postgres.js rejects it at bind time. The `FILTER` predicate therefore goes through `gte(aiJobs.createdAt, …)`, which reuses the column's encoder. A stub-based test cannot see this — the regression test compiles the projection and asserts no parameter is still a `Date`.

### Screens

| File                                    | Role                                                                 |
| --------------------------------------- | -------------------------------------------------------------------- |
| `src/components/bottom-sheet.tsx`       | Shared sheet shell: scrim, Esc, square paper panel                   |
| `src/components/autocomplete-sheet.tsx` | S4 «Добавление продукта» — search, «Создать „…“», AiProgress, result |
| `src/components/product-edit-form.tsx`  | «Изменить продукт»: emoji, name, department, unit                    |
| `src/app/(app)/catalog-screen.tsx`      | The catalog grouped by department, with the FAB that opens S4        |

The sheet debounces input by 200 ms and keeps the previous list on screen while the next one loads, so it never blinks empty between keystrokes. «Создать „…“» appears only when nothing already _is_ what was typed.

The «Покупки» tab is a deliberately lean catalog view — **task 2.3 replaces it with S3 «Корзина»**, reading from this same router. The quantity stepper DESIGN_BRIEF S4 describes belongs to the cart and lands with it; there is a `TODO(2.3)` on the line where an added product will join it.

## API (tRPC)

tRPC v11 + TanStack Query v5, superjson on the wire, Zod at every boundary. The client side uses the current `@trpc/tanstack-react-query` integration (option builders such as `trpc.cart.list.queryOptions()`), not the legacy `@trpc/react-query` hook proxy.

| File                               | Role                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------- |
| `src/server/api/trpc.ts`           | `initTRPC` — superjson transformer, `errorFormatter`, the three procedure builders |
| `src/server/api/context.ts`        | `createTRPCContext()` — `{ session, user, db, openai }` for one request            |
| `src/server/api/root.ts`           | `appRouter`, the `AppRouter` type, `createCaller`                                  |
| `src/server/api/routers/*.ts`      | One router per feature, with its Zod output schemas next to it                     |
| `src/app/api/trpc/[trpc]/route.ts` | The single HTTP endpoint (`fetchRequestHandler`)                                   |
| `src/trpc/query-client.ts`         | `makeQueryClient()` — shared defaults, superjson dehydrate/hydrate                 |
| `src/trpc/client.tsx`              | `TRPCReactProvider` (mounted in the root layout), `useTRPC()`, the links           |
| `src/trpc/server.tsx`              | `caller`, `trpc` options proxy, `prefetch`, `HydrateClient` for server components  |

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
- `householdProcedure` — additionally loads the caller's membership and throws `FORBIDDEN` (HTTP 403) when there is none, narrowing the context with `ctx.household` and `ctx.membership`. This is the per-request membership check VISION §6.7 asks for.

`ctx.openai` is a **factory**, not a client: building one reads `OPENAI_API_KEY`, and only a procedure that actually makes an AI call should need it (`next build` runs with no environment at all). It is on the context for the same reason `db` is — so an AI procedure is testable without a network.

**Build every household-scoped procedure on `householdProcedure`, and scope its queries by `ctx.household.id`.** A `householdId` arriving in the input is an authorization hole; `ctx.household.id` is derived from the session and cannot be forged.

`FORBIDDEN` rather than `UNAUTHORIZED` for a household-less caller is deliberate: they are authenticated, they simply have not finished onboarding. The UI gate normally redirects them long before a procedure runs; this is the backstop for direct API calls.

### Testing routers

`src/server/api/test-support.ts` holds the fixtures — it is imported by tests only, never by application code:

- `unusableDb` — a Proxy that throws on any property access, so a test can prove a procedure rejected _before_ it queried.
- `unusableOpenai` — the same idea for `ctx.openai()`. It is the default in both contexts below, so a test that unexpectedly reaches an AI call fails loudly instead of dialing a paid API.
- `createDbStub(results)` — a drizzle-shaped query-builder stub. Every clause returns the builder, and awaiting one shifts the next queued result off `results`; an `Error` in the queue is thrown instead, which is how a constraint violation is simulated. `stub.statements` records what the resolver ran, in order — including `wheres`, `orderBys` and the `fields` projection, each of which can be compiled with `PgDialect` to assert on the real SQL and its parameters.
- `anonymousContext(db, openai?)` / `signedInContext(db, openai?)` — the two contexts to hand `createCaller`.

Business rules that do not need a query at all (invite validity, accept decisions) live as pure functions and are tested directly. No test opens a database connection.

### Calling it

- Client component: `const trpc = useTRPC(); useQuery(trpc.health.ping.queryOptions())`.
- Server component, one value: `await caller.health.whoami()` from `@/trpc/server` — in-process, no HTTP.
- Server component, prefetch for a client child: `prefetch(trpc.health.ping.queryOptions())` and wrap the child in `<HydrateClient>`.

`staleTime` defaults to 30 s. It must stay above zero, or every server-prefetched query is refetched the instant the client hydrates.

### Errors

`errorFormatter` adds `data.zodError` to every error response — `null` for non-validation failures, `{ formErrors, fieldErrors }` for a `BAD_REQUEST` caused by an input schema. Forms map `fieldErrors` straight onto inputs.

### splitLink groundwork (post-MVP realtime)

The client already routes through `splitLink({ condition: (op) => op.type === "subscription", ... })`. Both branches currently point at the same `httpBatchStreamLink`, because the router exposes no subscriptions yet. Instant realtime moved to post-MVP (VISION §6.3, decision 2026-08-19) — MVP sync is refetch-based (plan task 2.2). If/when a realtime channel lands, the `true` branch becomes `httpSubscriptionLink({ transformer: superjson, url: getUrl() })` and nothing else in the client has to change.

## Model routing (AI-assisted development)

- **Fable** — orchestration: planning, architecture, task decomposition, reviewing subagent output, plan updates.
- **Opus** — tasks labeled `opus` in the plan (realtime infra, cart invariants, import pipeline, assistant).
- **Sonnet** — tasks labeled `sonnet` (UI screens from the design export, CRUD, seeds, settings).

Full rules: [CLAUDE.md](https://github.com/ilyanosovsky/larder/blob/main/CLAUDE.md).
