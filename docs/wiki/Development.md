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

`isUniqueViolation()` in `src/server/db-errors.ts` turns that index violation into a domain error instead of a 500 — the cart's own invariant reuses it (see [Cart](#cart)). It **walks the `cause` chain**, which is not optional: since drizzle-orm 0.44 the postgres.js error arrives wrapped in a `DrizzleQueryError`, so a top-level `code` check silently stops matching and every lost race becomes an INTERNAL_SERVER_ERROR.

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

`products` (`src/db/schema.ts`): `householdId`, `categoryId` (FK `restrict` — a department with products in it must not vanish), `name`, `normalizedName`, `icon`, `defaultUnit`, `aliases[]`, `createdBy` (`set null`).

The unique index is on **`(householdId, normalizedName)`** — a stored canonical column, not an expression over `name`. That is the whole point: the database enforces **the application's own** definition of "the same product" rather than a weaker approximation of it. An index on `lower(name)` folds case and nothing else, so it would happily admit «Сёмга» and «Семга» as two rows that the autocomplete treats as one — a permanent duplicate, mintable through a rename or a concurrent create, which is exactly what this feature exists to prevent.

The column is redundant with `name` by construction, and that is the trade: a canonical value can be indexed and compared exactly, while a normalization this specific is not something Postgres would still use an index for. **Nothing may write `name` without writing `normalizedName` in the same statement** — `insertProduct()` derives it centrally so no create path can forget, and `product.update` rewrites both together on a rename. A `name` that outran its canonical form would leave the row indexed under its old identity, silently switching uniqueness off for it.

### Normalization

`normalizeProductName()` (`src/server/catalog/normalize.ts`) is the single definition of "the same product": trim, lower-case, **ё → е**, collapse whitespace. Every comparison in the feature goes through it — ranking, the reference merge, the duplicate check, and the reference-catalog invariants test — and so does the database, via the stored `normalizedName` its unique index is built on. There is one definition of product identity and both layers use it.

Migration `0005_breezy_shaman` carries a SQL twin of the function for its backfill (`regexp_replace` + `translate(lower(…), 'ё', 'е')`). If the normalization ever changes, that backfill is a snapshot of the old rule, not a live copy — existing rows need a fresh backfill migration.

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

**`create` is idempotent by name.** It looks for an existing row first (`normalizedName` _or_ an alias match), so a repeat create returns the existing product without an AI call; and if a concurrent insert wins the unique index, the loser reads the winner's row back instead of surfacing a violation. Two taps, two tabs and two partners all end with one product.

The lookup probes **the indexed column itself**, so it and the index can never disagree about what a duplicate is. That equality is load-bearing: a probe that could miss what the index catches would miss precisely the row an insert just collided with, and the conflict would surface as a 500 — on the paid path, after the AI call was already billed.

### AI enrichment

`enrichProduct()` (`src/server/ai/enrich-product.ts`) asks for `{ icon, categoryId, unit }` in one structured-output call.

- Model and prices live in `src/server/ai/pricing.ts` — `gpt-5-mini`, `reasoning_effort: "low"` (VISION §6.5: invisible reasoning tokens are billed as output and would multiply a sub-cent call).
- The JSON schema comes from the Zod schema through **Zod v4's own `z.toJSONSchema`**, not the OpenAI SDK's `zodResponseFormat` helper — that helper targets Zod v3 internals. One schema both describes the response and validates it, so the two cannot drift. Schemas for AI use `.nullable()`, never `.optional()`: strict mode cannot express an optional property.
- **`categoryId` is re-checked against the ids we actually sent**, after parsing. Strict mode constrains the shape of the field, never its value, and a hallucinated uuid would otherwise file the product into nothing. The icon is checked for being plausibly a single emoji.
- **The function never throws.** Network error, refusal, malformed JSON, invented department — all come back as `ok: false`.

**Failure is not an error the user sees as one.** Whatever goes wrong, the product is still created, with 🛒 / «Бакалея» / «шт», and `aiFailed: true` tells the sheet to show a calm amber "проверь иконку и отдел" (DESIGN_BRIEF §6: yellow, not red). VISION §3.1 is explicit that the AI is a helper and everything is editable — one tap opens the edit form. The router also catches `ctx.openai()` itself throwing and treats that the same way, which covers an **invalid or revoked** key.

It does **not** cover a **missing** one: `env()` validates the whole schema on first call and `db()` calls `env()`, so a deployment without `OPENAI_API_KEY` fails every request at context construction, well before the enrichment fallback is reachable. That is the intended behaviour for an absent required variable — see [[Env-Setup]].

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

| File                                    | Role                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| `src/components/bottom-sheet.tsx`       | Shared sheet shell: scrim, Esc, square paper panel                                |
| `src/components/autocomplete-sheet.tsx` | S4 «Добавление продукта» — search, «Создать „…“», AiProgress, quantity step       |
| `src/components/product-edit-form.tsx`  | «Изменить продукт»: emoji, name, department, unit                                 |
| `src/app/(app)/cart-screen.tsx`         | S3 «Корзина» — the screen S4 adds to (see [Cart screen](#cart-screen-s3-task-23)) |

The sheet debounces input by 200 ms and keeps the previous list on screen while the next one loads, so it never blinks empty between keystrokes. «Создать „…“» appears only when nothing already _is_ what was typed.

There is no separate catalog screen. Task 1.3 shipped one as a stand-in so newly created products had somewhere to land; task 2.3 replaced it with the cart, and the catalog is now reached only through S4's search. Editing an existing product's icon or department therefore goes through «Изменить» on the quantity step for now; row-level editing on S3 is task 2.5.

**S4 resolves a product _and_ a quantity, then hands both over.** `onAdded({ product, qty, unit })` fires on «В корзину», and the sheet deliberately does **not** close itself: only the caller knows what `cart.add` answered, and a merge, a unit conflict and an already-bought line are three different screens. It also never imports the `cart` router, so the same flow can later feed a recipe's ingredient list or the pantry. A successful `product.create` invalidates the `product` queries before moving on — otherwise the same search inside `staleTime` would offer «Создать „…“» again for a product that now exists.

## Cart

The shared shopping list (VISION §3.1) — the product's core screen, and the one place a database invariant does most of the design work.

`cart_items` (`src/db/schema.ts`): `householdId`, `productId` (FK `restrict` — purchase history must not lose what was actually bought), `qty`, `unit`, `status`, `note`, `addedBy`/`buyerId` (both `set null` — the cart belongs to the household, not to whoever typed the line), `orderedVia`, `tripId`, `createdAt`, `updatedAt`.

### The one-active-row invariant

```sql
CREATE UNIQUE INDEX "cart_items_productId_active_uidx"
  ON "cart_items" ("product_id") WHERE trip_id is null;
```

**Active** means "not yet carried off by a closed trip", so a product appears at most once in the live cart and any number of times across history. The index needs no `household_id`: a product row belongs to exactly one household, so uniqueness per product is already at least as strict as uniqueness per (household, product) — never weaker.

That is a property of `products`, not of `cart_items`' own foreign keys. Those are independent, so the database alone does **not** force `cart_items.household_id` to equal `products.household_id` — keeping the two in step is the router's job (`cart.add` checks the client's `productId` against the caller's own catalog before inserting). This is the same app-level guard `product.update` already applies to a `categoryId`, and it is a deliberate consistency choice rather than an oversight: closing it in the database would mean composite `(household_id, id)` keys on `products`, `categories` and `shopping_trips` alike, which is a repo-wide tenancy decision rather than something one feature PR should introduce for one table.

The index is the **authority, not a pre-check**. Adding a product that is already in the cart raises the existing line instead of minting a second one, and two partners doing it at the same instant race in Postgres rather than on a read. «Помидоры и вверху, и внизу» — the note-app pain this whole product started from — is impossible by construction. Application code must never work around it (AGENTS.md).

`shopping_trips` is written by exactly one endpoint, `trip.close` (task 3.2, see [Closing a trip](#closing-a-trip-завершить-закупку) below). There is deliberately no "open trip" row: a trip is only ever created at the moment it is closed, and "the current trip" is simply the set of rows with `trip_id IS NULL`. An open-trip row would be a second source of truth for the same fact, and a household could then have zero or two of them.

`qty` is `numeric(10, 3)` in drizzle's `number` mode — «0.5 кг» has to survive a round trip, and a float would make «0.1 + 0.2» a support ticket. `unit` and `orderedVia` are `text` re-validated on read (the same treatment `products.default_unit` gets); `status` is a real pg enum, because it drives every branch of the merge rules and an unknown value there would have no safe fallback.

### Merge rules (`src/server/cart/merge.ts`, pure, unit-tested)

`decideCartAdd({ existing, addition, restore })` is the decision half of `cart.add` with no database in it. Given the product's existing **active** row:

| Existing active row            | Outcome        | What happens                                                                                                       |
| ------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------ |
| none                           | `added`        | new `needed` line, `addedBy` = caller                                                                              |
| `needed`/`ordered`, same unit  | `merged`       | `qty += added` (capped at `MAX_QTY`), nothing else changes; response carries `previousQty`                         |
| `needed`/`ordered`, other unit | `unitMismatch` | row untouched — the screen asks                                                                                    |
| `bought`                       | `boughtExists` | row untouched — the screen offers «вернуть в нужно»                                                                |
| `bought` + `restore: true`     | `restored`     | → `needed`, **new** qty and unit, re-credited to the caller (`addedBy`), buyer and `orderedVia` cleared, note kept |

Three of those are decisions rather than implementation details:

- **Different units are never summed.** «200 г» + «1 шт» has no answer a program can pick, so the row is left alone — the same principle VISION §3.4 states for building the cart from the week's menu. Guessing would quietly corrupt a shopping list and the shopper would find out at the shelf.
- **`ordered` merges without falling back to `needed`.** The partner has already put that line in a delivery order; raising the quantity does not un-order it. Symmetrically, `ordered → bought` **keeps** `orderedVia`: a delivered Wolt order was still bought at Wolt.
- **A `bought` line takes two calls.** The restored line takes the _new_ quantity rather than a sum, because the old one has been paid for. `restore` is scoped to exactly that case — sent for a line that is not bought it is ignored and the ordinary rules apply, so a stale confirmation cannot mean something the shopper never asked for.

Quantities are rounded to the column's own scale, so the number a decision reports is the number the row will hold: 0.1 + 0.2 decides `0.3`, not `0.30000000000000004`. Both bounds are real rather than pedantry: `MIN_QTY` (0.001) because anything smaller rounds down to zero and creates a line for none of something, and `MAX_QTY` (10 000) because it bounds **a merged total as well as a single addition** — nobody buys ten thousand of anything, and capping the sum keeps a long run of merges from pushing `numeric(10, 3)` past its own range and turning an ordinary tap into a 500.

A unit is compared **exactly as the row stores it**. `list` degrades a unit the app no longer recognizes to «шт» so one out-of-band row cannot fail the whole cart's output validation, but the merge decision never sees that substitution — otherwise a row holding «мешок» would look like a «шт» row and silently sum into it, changing the quantity while leaving the stored unit alone. Compared raw, it simply falls to `unitMismatch` and a person decides.

### Concurrency in `cart.add`

Inside one transaction: `SELECT … FOR UPDATE` the product's active row, decide, write. The lock is what makes the read-decide-write safe — two partners adding «помидоры» at once would otherwise both read «2 шт», both compute «3 шт», and one increment would vanish.

A product with **no** active row locks nothing, so the insert can still lose the unique index. It therefore runs inside a **savepoint** (drizzle's nested `transaction`), and that is not decoration: in Postgres a unique violation aborts the _entire_ enclosing transaction, so catching 23505 without one would leave the recovery read failing with 25P02 instead of finding the winner. Rolling back to the savepoint restores a usable transaction, the loser re-reads the winner's row under a lock, and the same merge rules apply to it. Two passes is the whole budget — after a lost race an active row provably exists, so a second miss is a bug, not something to retry.

`isUniqueViolation()` (`src/server/db-errors.ts`) is what recognizes the violation; it walks the `cause` chain, which is not optional since drizzle 0.44 wraps driver errors.

### `cart` router

| Procedure           | Boundary             | Notes                                                                          |
| ------------------- | -------------------- | ------------------------------------------------------------------------------ |
| `cart.list`         | `householdProcedure` | Active lines only, joined with product, department and both member names       |
| `cart.add`          | `householdProcedure` | `{ productId, qty, unit, note?, restore? }` → the five-way outcome union above |
| `cart.updateItem`   | `householdProcedure` | Partial patch of qty/unit/note/buyerId/orderedVia; LWW                         |
| `cart.setStatus`    | `householdProcedure` | `{ id, status, orderedVia? }`; LWW                                             |
| `cart.remove`       | `householdProcedure` | Hard delete of the active line — **idempotent**                                |
| `cart.receiveOrder` | `householdProcedure` | `{ orderedVia? }` — bulk `ordered → bought` (task 2.5), see below              |

`list` returns rows ordered by department `sortOrder` then product name, which is exactly the contract `groupProductsByCategory` (`src/lib/group-products.ts`) assumes — it cuts an already-ordered list into sections by walking it, so a different order would silently produce two sections for one department. `addedBy` and `buyerId` join `users` twice under aliases: «кто добавил» and «кто купил» are both on the row and are usually different people. `updatedAt` is on the wire for task 2.2, which highlights lines that changed between refetches.

`setStatus` gives each status the fields that only make sense in it, so a row can never describe two states at once: `bought` stamps the caller as buyer, `needed` clears both the buyer and the delivery service, `ordered` records `orderedVia` when the screen offers one.

**Every statement repeats `household_id` alongside the primary key**, and every mutation additionally requires `trip_id IS NULL` — an id from the client never reaches a write on its own (VISION §6.7), and a line carried off by a closed trip is purchase history rather than something the cart screen may edit. A client-sent `productId` is checked against the caller's own catalog before it reaches a write, and a `buyerId` against the household's members, for the same reason `product.update` checks a `categoryId`: the foreign key only proves the row exists, not that it belongs here.

`remove` is deliberately idempotent — no NOT_FOUND when nothing matched. The cart is shared, so both partners removing the same line is ordinary rather than an error, and the offline queue task 2.4 adds will replay mutations after a reconnect.

### `cart.receiveOrder` (task 2.5)

«Заказ получен»: every active `ordered` line becomes `bought` in **one** `UPDATE`, instead of ticking each one by hand. `orderedVia` is `.nullable().optional()` — both an absent key and an explicit `null` mean "every ordered line, regardless of service"; a concrete `wolt`/`carrefour`/`other` narrows the statement to just that service's lines. There is no third reading worth telling apart, and the UI never has a reason to ask for "no service" specifically.

The buyer rule mirrors `setStatus`'s single-row one, expressed for a whole batch in the same statement — `` buyerId: sql`coalesce(${cartItems.buyerId}, ${ctx.user.id})` `` — so a line already assigned (`updateItem`'s «кто берёт») keeps its buyer and only an unclaimed line is credited to whoever tapped the control — decided per row by Postgres, not by a loop in the procedure. `orderedVia` is cleared on every receipted line: the badge exists to answer "is this on its way", and once it has arrived that question is moot the same way the checkbox's `ordered → bought` needs no separate "received" state.

A household with nothing ordered (or nothing ordered through the given service) is a no-op — `{ count: 0, ids: [] }`, no error — the same idempotence `remove` already has. The output is Zod'd (`receiveOrderOutput`) so the caller gets typed ids back rather than a bare count.

The UI on top of both routers is [Cart screen](#cart-screen-s3-task-23) below.

### Cart sync (task 2.2)

VISION §6.3's MVP sync model is refetch, not push: every mutation persists immediately, and a partner's view catches up the next time it refetches — on focus, on a background interval, or by hand. `src/lib/sync/` is the reusable toolkit that model needs; the S3 screen wires it in rather than reimplementing any of it.

| File                    | Exports                                                                               | What it's for                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `cart-sync-presets.ts`  | `CART_REFETCH_INTERVAL_MS`, `cartSyncQueryOptions`                                    | The refetch preset for cart-family `queryOptions()` call sites                            |
| `diff-list-snapshot.ts` | `SyncRow`, `ListDiff`, `diffListSnapshot`                                             | Pure: compares two refetches of the same list, reports added/updated ids                  |
| `highlight-state.ts`    | `ChangedRowsState`, `INITIAL_HIGHLIGHT_STATE`, `nextHighlightState`, `clearHighlight` | Pure: the state machine behind the highlight, one snapshot fold at a time                 |
| `use-changed-rows.ts`   | `HIGHLIGHT_MS`, `ChangedRows`, `useChangedRows`                                       | Thin hook shell around the state machine above — `{ changedIds }`                         |
| `use-manual-refresh.ts` | `ManualRefresh`, `useManualRefresh`                                                   | Thin hook shell around `queryClient.refetchQueries(filter)` — `{ refresh, isRefreshing }` |

**The preset.** `cartSyncQueryOptions` spreads `refetchInterval: CART_REFETCH_INTERVAL_MS` (45s, the middle of VISION §6.3's "~30–60 с" band) plus `refetchOnWindowFocus: "always"` and `refetchOnReconnect: "always"` into a `useQuery(trpc.cart.list.queryOptions(undefined, { ...cartSyncQueryOptions }))` call — the same spread-at-the-call-site pattern `autocomplete-sheet.tsx` already uses to override `trpc.product.search.queryOptions(...)` with `placeholderData: keepPreviousData`. `"always"` matters specifically because `query-client.ts` sets `staleTime: 30_000` for SSR-hydration reasons unrelated to the cart — under the _default_ focus/reconnect behavior, TanStack Query skips refetching a query that isn't stale yet, so a focus landing inside that 30s window would silently do nothing. That is exactly the "opened the phone by the shelf" moment the model exists for, so the cart opts out of the staleness check rather than inheriting it.

This is deliberately **not** a `QueryClient` default. The catalog, settings and kitchen-profile screens have no partner racing to see their own edits, and polling every one of them every 45s would burn requests for nothing; only the cart (the one shared, actively-edited list, VISION §3.1) opts in.

**The highlight.** `diffListSnapshot(prev, next)` compares two `{ id, updatedAt }` arrays — `cart.list` rows satisfy this structurally — and returns `{ addedIds, updatedIds }` by comparing `updatedAt.getTime()`; a row missing from `next` is not reported, it just disappears. `useChangedRows(items)` keeps a `ChangedRowsState` (the last snapshot plus the currently-highlighted ids) in a ref, folds each new snapshot through `nextHighlightState`, and clears `changedIds` again after `HIGHLIGHT_MS` (4s) via `clearHighlight`. The first-ever snapshot never highlights anything — there is nothing to diff it against yet, and a first load is not a "change" a person made while looking.

`nextHighlightState` has one more property beyond the diff itself: when the diff between the last snapshot and the new one is empty, it returns its input `state` **unchanged, same reference**, rather than a fresh object with an equally-empty `changedIds`. That is not a micro-optimization — `cart.list` rows carry a `Date`, and superjson mints a new `Date` instance (and TanStack Query a new array) on essentially every refetch, changed or not, so an empty diff is the _common_ case under `cartSyncQueryOptions`'s 45s poll and always-refetch-on-focus, not an edge case. `useChangedRows` uses the reference itself as the signal to skip its `setState` and leave any running highlight timer alone; without that, a highlight started by one refetch would get wiped — and its clear timer cancelled — by the very next no-op poll, typically well before `HIGHLIGHT_MS` elapses. "Latest diff wins" under rapid refetches (mentioned above) accordingly only applies to _non-empty_ diffs; an empty one is defined to change nothing.

All of the actual branching lives in the two pure functions in `highlight-state.ts`, not in the hook. That split is not just taste: this repo's vitest config (`vitest.config.ts`) runs in a **node** environment and only collects `src/**/*.test.ts` — no `.tsx`, no DOM — so a hook cannot be rendered or tested here at all. The pure state machine is what carries the test coverage; the hook itself is a ref, a `setState` and a `setTimeout`. (`items` still has to be the query's own `data` reference, or a `useMemo`-stabilized derivative of it — an inline-derived array recreated every render defeats the effect's `[items]` dependency, which the same-reference bail-out only turns from an infinite render loop into wasted work, not into a no-op.)

**Manual refresh.** `useManualRefresh(filter)` wraps `queryClient.refetchQueries({ type: "active", ...filter })` with an `isRefreshing` boolean — the «Обновить» control in S3's toolbar. `filter` is `trpc.cart.list.queryFilter()`, the same idiom the screen uses for invalidation, just handed to `refetchQueries` instead of `invalidateQueries`. `type: "active"` overrides `matchQuery`'s own default of `"all"`, so a manual refresh only ever touches the query actually mounted on screen, not every cached-but-unmounted query under the same key prefix. `isRefreshing` is tracked by an in-flight counter rather than a single `try`/`finally` around one call: `refetchQueries` **cancels** an in-flight fetch by default rather than deduping it, and the cancelled call's own promise still resolves — so two overlapping taps would otherwise flip `isRefreshing` back to `false` as soon as the first (now-cancelled) call settles, while the second tap's fetch, the one that actually wins, is still running.

**Push is still post-MVP.** None of this touches `src/trpc/client.tsx`'s `splitLink` groundwork (see [splitLink groundwork](#splitlink-groundwork-post-mvp-realtime)) — refetch is the whole sync story until a realtime channel exists.

### Cart screen (S3, task 2.3)

`/` (`src/app/(app)/page.tsx` → `cart-screen.tsx`), the app's main screen. The page prefetches `cart.list` and `category.list` server-side and hydrates; everything else is client.

**Composition.** Toolbar («Корзина», the item count, «Обновить») → one block per department → a fixed bottom action bar holding «+ Добавить». Sections come from `groupProductsByCategory` walking `cart.list`'s server-decided order (department `sortOrder`, then product name); the screen re-orders nothing else except `sortBoughtLast` **inside** each section, which is DESIGN_BRIEF S3's «строка зачёркивается и опускается вниз секции». Sorting the flat list first would move a bought row across a department boundary and split that department into two sections under the same walk.

The four decisions the screen makes are pure modules under `src/lib/cart/`, for the same reason `src/lib/sync/` splits its hooks: vitest here runs in a **node** environment and collects `src/**/*.test.ts` only, so nothing that must be rendered can be covered.

| File               | Exports                                     | What it decides                                              |
| ------------------ | ------------------------------------------- | ------------------------------------------------------------ |
| `sort-rows.ts`     | `sortBoughtLast`                            | Stable partition, bought last, `ordered` staying live        |
| `status-toggle.ts` | `toggledCartStatus`, `applyStatusToggle`    | What the checkbox means, and the optimistic cache patch      |
| `add-outcome.ts`   | `describeCartAddOutcome`, `CartAddToastKey` | `cart.add`'s five outcomes → toast / highlight / confirm     |
| `qty-step.ts`      | `clampQty`, `stepQty`, `canStepQty`, bounds | The S4 stepper's arithmetic, pinned to the router's bounds   |
| `own-changes.ts`   | `markOwnChange`, `withoutOwnChanges`        | Which rows _this_ client changed, so the highlight is honest |

**The optimistic checkbox** is the first optimistic mutation in the repo and the pattern the rest should copy. `onMutate` awaits `queryClient.cancelQueries(cartFilter)`, applies `applyStatusToggle`, and remembers the row's **previous status**; `onError` re-applies that one status; `onSettled` invalidates. Two fields are deliberately **not** patched: `updatedAt` (see the highlight note below) and `buyerId` (the server stamps the caller on `bought` and clears it on `needed`; guessing would render a «кто берёт» a failed request has to take back).

**Rollback is per row, not a whole-list snapshot.** Overlapping toggles are ordinary — ticking down a shelf is exactly that — and a snapshot taken before row A's request knows nothing about row B's. Restoring it would wipe B's optimistic tick when A fails, and re-apply A's when B fails. Re-applying the inverse to the failed row alone touches only what actually failed, cannot resurrect a row a refetch removed in the meantime, and leaves `onSettled`'s invalidate as the healer for everything else.

**Three separate things stop a refetch from un-ticking a row mid-flight**, and they cover different windows:

- `cancelQueries` in `onMutate` stops what is **already** in flight.
- The query options mute `refetchInterval` / `refetchOnWindowFocus` / `refetchOnReconnect` while `useIsMutating({ mutationKey: trpc.cart.pathKey() })` is non-zero, because a trigger firing _after_ `onMutate` starts a fresh request that was dispatched before the write landed and answers with the pre-write list. `pathKey()` is already the shared key across every `cart.*` mutation — tRPC sets `mutationKey` itself, after spreading the caller's options, so it cannot be overridden per call site. «Обновить» is disabled for the same window.
- Nothing is lost by waiting: `onSettled`'s invalidate refetches the moment the write settles. What remains is a genuine last-write-wins tolerance (partner writing the same row in the same instant), which VISION §3.1 accepts.

**The highlight only ever means "someone else".** `useChangedRows` diffs `updatedAt` and cannot tell whose change it is looking at — and every toggle ends with the server stamping `now()` and the screen invalidating, so without help the refetch reports your own tick and lights your own row up. Not patching `updatedAt` optimistically is necessary but **not sufficient**: the snapshot the diff compares against still holds the old timestamp, so the flash happens on the refetch regardless. `own-changes.ts` closes it — `markOwnChange` records the id in `onMutate` with an expiry of `now + HIGHLIGHT_MS`, and `withoutOwnChanges` filters those ids out of `changedIds` at render. It is time-bounded rather than consume-on-first-sight because `changedIds` stays populated for the whole window, so a mark that cleared on first observation would just let the highlight reappear on the next render. The cost is that a partner's change to the same row inside that window is muted too — a few seconds of silence on one row, against a false "someone else touched this" on every single tap. Scoped to `setStatus`: the add flow's own highlight is wanted.

**Two highlight treatments, not one.** `.rowChanged` is mockup 1b's plain `--accent-soft` wash — «партнёр что-то поменял», arriving unprompted, so it stays quiet. `.rowActed` adds mockup #1h's `inset 2px 0 0 var(--accent)` edge — it answers a tap, and on a merge it is the only thing pointing at the row the quantity went into. Own action wins when both would apply.

**Double-tap guards are refs, never render state.** Worth stating plainly, because the wrong version _looks_ correct: `mutation.isPending`, a `useState` flag and a `disabled` attribute are all applied by React **after** the handler returns, so two taps landing in the same event-loop turn read the same pre-tap value and both get through. Only a ref is written and read synchronously.

What losing that race costs differs per call site, which is why each one is locked:

- **The checkbox** — `pendingRef`, a `Set` keyed by row id. Per row, because ticking three things one after another is ordinary shopping and must never block. Two `setStatus` calls for one row race, and last-write-wins settles on whichever arrived second rather than on what the shopper last tapped.
- **«В корзину»** — `addBusyRef` in the screen, plus the sheet's own `busyRef`. `cart.add` **merges**, so two adds of «2 шт» leave 4 in the cart: stateful damage, with nothing on screen admitting the second tap did anything. Both entry points (S4 and the restore confirmation) route through `submitAdd`, so one lock covers both.
- **«Создать „…“»** — the sheet's `busyRef` again. Two AI calls and two `ai_jobs` rows; this one costs money.

`isPending` and `disabled` stay, but for **rendering only** — the pending label and the greyed-out button. They are feedback, not the guard. A `useState` mirror of `pendingRef` exists for exactly that reason.

**The row checkbox is never given the `disabled` attribute**, though. A control that becomes disabled loses focus (verified in-browser: focus survives `aria-disabled`, and is dropped by the real attribute), so every keyboard toggle would throw the user back to the top of the page mid-shop. The ref lock is what prevents the second fire; `aria-disabled` and `aria-busy` expose the state, and a `data-pending` attribute carries the visual affordance.

**The toast is a permanently-mounted live region plus a separate visual card.** A `role="status"` node that is mounted together with its content is not reliably announced — assistive technology has to have been watching the region before the text arrived — so the region is an always-present visually-hidden `<p>` whose text swaps, and the ink card is `aria-hidden`. Toast state is `{ message, seq }` rather than a bare string: raising the same message twice (adding «Помидоры» twice in a row) must restart the 2.5s dismiss timer, and an unchanged string leaves the effect's dependency unchanged.

**Add flow.** «+ Добавить» opens S4; S4 reports `{ product, qty, unit }` and the screen calls `cart.add`. `describeCartAddOutcome` maps the answer:

| Outcome        | Toast                                   | Highlight | Then                                             |
| -------------- | --------------------------------------- | --------- | ------------------------------------------------ |
| `added`        | «{icon} {name} — в корзине»             | the row   | close S4                                         |
| `merged`       | «…уже в корзине — количество обновлено» | the row   | close S4 (mockup #1h)                            |
| `unitMismatch` | «…в других единицах — измени вручную»   | the row   | close S4; no auto-edit — that is 2.5             |
| `boughtExists` | none                                    | the row   | confirmation sheet → re-add with `restore: true` |
| `restored`     | «{name} — снова в корзине»              | the row   | close S4                                         |

Every outcome highlights its row rather than leaving it to the refetch. For the three that wrote something the refetch would eventually notice anyway and this just beats the round trip; for `unitMismatch` and `boughtExists` it is the only way, because nothing was written, `updatedAt` did not move and `diffListSnapshot` has nothing to see. `boughtExists` carries no toast on purpose: a question and an announcement competing for the same corner is how the question gets missed. The confirmation is a **separate** `BottomSheet` that opens as S4 closes rather than a second modal stacked on it — focus, Esc and the body scroll lock all stay owned by exactly one sheet.

**The header** (`app-header.tsx`) shows the participants' avatars — partners first, the caller's own last so the one that is also a 44px link into Settings is never partly covered — and DESIGN_BRIEF's «тихая иконка-часики» while `useIsFetching(trpc.cart.pathFilter())` or `useIsMutating({ mutationKey: trpc.cart.pathKey() })` is non-zero. Both are router-level key helpers and TanStack matches keys by prefix, so one filter each covers `cart.list`'s refetches and every `cart.*` mutation, including the ones 2.5 adds. Idle shows nothing at all; offline (the brief's third state) replaces the mark with a `--null-txt` dot — see the offline queue below for why that state has to win over «синхронизируем». Members come from the `household.current` the `(app)` layout already loads for its gate, passed down as props — no second query.

**Deferred, and why the screen looks incomplete without it:** the «Корзина | Кладовая» segment control (3.1, replaces the toolbar's title/count pair) and «Завершить закупку» (3.2, joins «+ Добавить» in the action bar). An `ordered` row renders with an unticked box, and ticking it sets `bought` — which is the safe direction under last-write-wins whichever way the line got there.

### Row action sheet, badge, buyer avatar, «Заказ получен» (task 2.5)

**A tap on a row's body — not the checkbox — opens `CartItemSheet`.** The checkbox needed its own dedicated hit area to make that split possible: `.checkboxTarget` is a `<label>` padded out to the 44pt minimum and pulled back with an equal negative margin (the standard "bigger tap target, same footprint" trick), and `.rowBody` is a plain reset `<button>` holding everything else in the row. Splitting a `<label>` that used to wrap the whole row into these two siblings is what lets the checkbox keep doing exactly one thing while the rest of the row does another.

`CartItemSheet` is **plain mutate + invalidate**, deliberately unlike the checkbox: none of qty/unit/note, «кто берёт» or «заказано» is perf-critical the way ticking down a shelf is, so there is no optimistic cache patch to keep in sync with a rollback for any of it. One `busyRef` locks the whole sheet rather than one per control — a person edits one field at a time here. `item` is looked up fresh from `cart.list`'s cache on every render of the parent screen (`cart-screen.tsx`'s `editingItem = items.find(...)`) rather than captured once at open, so a save is visible in the sheet itself the moment the invalidate it triggers lands, without closing and reopening it.

**The local qty/unit/note draft is reset on the _edited row's id_, not on the `item` object.** Task 2.2's background poll and always-refetch-on-focus give every `cart.list` snapshot a fresh object identity whether or not the row actually changed, so an effect keyed on `item` itself would reset the draft on every one of those refetches — silently overwriting a note or a stepped qty the shopper has typed but not yet saved. Keying the effect's dependency array on `item?.id` instead (reading the current `item.qty`/`.unit`/`.note` inside it, deliberately left out of the array) makes it re-seed only when the sheet opens or the row it is showing changes, never merely because the same row's object reference did.

**A paused `updateItem`/`setStatus` is not "busy" — a paused `remove` still is.** All three use the default `networkMode: "online"`, so a write made offline pauses before its request ever leaves (task 2.4) and its `mutateAsync` promise does not settle until the connection returns — sometimes minutes later. For `updateItem`/`setStatus`, `busy` is derived as `isPending && !isPaused`, not from a plain `useState`, and a separate effect releases `busyRef` the moment either pauses rather than holding it for the whole round trip: both are last-write-wins on a row that still exists, never merging like `cart.add`, so a second tap queuing a newer edit behind an already-paused one is an ordinary conflict the queue already resolves.

`remove` gets no such exception — `busy` includes a bare `remove.isPending`, paused or not, and the release effect skips entirely while it is pending. Once a removal is queued the row is on its way out entirely, and the offline queue delivers concurrently rather than in dispatch order (`Promise.all` over whatever is queued): a same-row `updateItem`/`setStatus` allowed to queue behind it can just as easily land _after_ the delete, and `activeItemScope` then finds no row to act on — a NOT_FOUND for an edit the shopper has no reason to think failed. Locking the whole sheet for as long as a removal is in flight, including while it waits in the queue, is what rules that race out; a `queued` boolean (the same three `isPaused` flags, `remove` included) renders S3's own «ждёт синхронизации» copy as a status line so the lock does not look like nothing is happening.

**The sheet's own edits get the same own-change suppression the checkbox does.** `CartItemSheet` takes an `onMutated(rowId)` prop — `cart-screen.tsx` wires it to `markOwnChange(ownChangesRef.current, rowId, …)` — called once before an action dispatches and again on success, the same double-mark `setStatus` already does for the same reason: a write queued offline lands, and triggers its own refetch, minutes later, well past the first mark's window. Without this a note, buyer or service set from the sheet would flash as «партнёр что-то поменял» on the very next refetch the sheet's own invalidate causes.

Sections:

- **Qty/unit** reuse `QtyStepper` (`src/components/qty-stepper.tsx`), extracted out of `AutocompleteSheet` in this task so S4's stepper and the row sheet's editor can never quietly drift apart on step size or bounds. It takes its aria-label strings as props rather than calling `useTranslations` itself — S4 and the row sheet read different namespaces (`autocomplete`, `cart`), and a shared presentational component has no business picking one for the other.
- **Note** is a plain text input; saving trims it and maps an empty string to `null` (`updateItem`'s "clear it" reading), bundled into the same `updateItem` call as qty/unit.
- **«Кто берёт»** is a chip row: «Никто» plus one chip per household member (`household.current`'s `members`, prefetched in `page.tsx` alongside `cart.list`/`category.list` — a plain client `useQuery` in the screen, not props threaded through the `(app)` layout, since a layout cannot hand a page anything but an opaque `children`). Tapping a chip calls `updateItem({ buyerId })` immediately.
- **«Заказано»** shows the three services; tapping one calls `setStatus({ status: "ordered", orderedVia })` on a still-`needed` line or `updateItem({ orderedVia })` on one already `ordered` (re-picking the same service on an ordered line needs the latter — `setStatus`'s `ordered` branch only touches `orderedVia` when the _status_ is changing). Hidden entirely once a line is `bought` — nothing here un-buys a line; the checkbox does. «Вернуть в «нужно»» (`setStatus({ status: "needed" })`) only shows once the line actually is `ordered`.
- **«Удалить»** calls `cart.remove` and closes the sheet on success.

**The badge, the avatar, and the note are the same `ProductRow`, rendered differently.** `avatarInitial` (`src/lib/avatar-initial.ts`) — the first _grapheme_ of a name, upper-cased, via `Intl.Segmenter` rather than `.charAt(0)` (which would cut a leading surrogate-pair emoji in half) — is shared between this avatar and the header's own, so the two can never disagree about which letter represents the same person. An `ordered` row switches `.rowName` to `flex: none` and gives `.rowQty` `margin-left: auto` (mockup 1a): the badge sits right after the name instead of being stretched away from it, and the quantity — and the buyer avatar after it — claim the freed-up space instead. The badge itself (`.rowBadge`) is `«Заказано · Wolt»` / `«· Carrefour»` for those two services and plain `«Заказано»` for `other`; `orderedVia` is cleared by `receiveOrder`, so a received line shows no badge at all, plain `bought` like any other.

**«Заказ получен»** (`groupOrderedByService`, `applyReceiveOrder`, `rollbackReceiveOrder`, `receivableServiceGroups` — all pure, in `src/lib/cart/receive-order.ts`) is the bulk counterpart of the checkbox's optimistic toggle, adapted to a batch:

- `groupOrderedByService(items)` walks the current list and returns one entry per distinct `orderedVia` among `ordered` rows (fixed order `wolt` → `carrefour` → `other` → `null`, so the bar does not reshuffle as rows move between services), each with a count.
- `receivableServiceGroups(groups)` drops the `null` group before the bar renders anything: `cart.receiveOrder({ orderedVia: null })` means "every service" server-side, not "only the service-less rows", so a button for that group could mark Wolt/Carrefour rows bought too. Such a row cannot arise from this app's own writes (`CartItemSheet`'s service picker always supplies a concrete service alongside the `ordered` transition) — it stays individually receivable via its own checkbox regardless. `cart-screen.tsx`'s `handleReceiveOrder` is typed on a bare `OrderedVia` (no `null`) so this cannot regress by accident at a call site.
- `applyReceiveOrder(list, orderedVia)` is the optimistic patch: every `ordered` row (or, narrowed, every row ordered through the given service) moves to `bought` with `orderedVia` cleared. `buyerId` and `updatedAt` are deliberately left alone — same reasoning as `applyStatusToggle`'s single-row patch: the server decides the buyer (`COALESCE`) and stamps the real timestamp, and guessing either here would just have to be taken back the moment the invalidate lands.
- `rollbackReceiveOrder(list, snapshots)` undoes exactly the rows `applyReceiveOrder` touched — the bulk analogue of the checkbox's per-row inverse, for the same reason: an unrelated tick landing mid-flight on a different row must survive a failed batch's rollback.
- The own-change mark (`markOwnChange`) is written for **every** affected row, both at the tap (`onMutate`) and again at settle (`onSettled`) — same double-mark reasoning `setStatus` already has for the queue: a receive queued offline can be delivered minutes later, well past the first mark's window, and the refetch it triggers must not light those rows up as «партнёр что-то поменял».
- Per-group pending state (`receivePendingRef`/`receivePendingKeys`, keyed by `orderedVia ?? "__none__"`) is the same ref-then-state pairing the checkbox's `pendingRef`/`pendingIds` uses, sized for the handful of buttons the bar ever shows.

**The offline queue (task 2.4) now also covers `cart.receiveOrder`.** `installOfflineQueue` registers it exactly like the other three mutations; the persist filter needed no change at all — `matchesTrpcPath` is a path-**prefix** match against `trpc.cart.pathKey()`, so anything under `cart.*` is already covered, new procedures included (a dedicated test proves this rather than assumes it).

The 🕐 "queued" mark needed real work, though, and not the first version this task shipped: `queuedCartRowIds` (`src/lib/sync/queued-mutations.ts`) cannot resolve a queued receive's rows against the _current_ cart list, because by the time anything downstream looks, `onMutate`'s own optimistic patch has already moved every affected row out of the `ordered` status that would otherwise identify it — a `status === "ordered"` lookup against live data finds nothing, every time, for every bulk receive that ever gets queued. The fix reads a queued receive's row ids from its own `onMutate` **context** instead (`applyReceiveOrder`'s return shape, `{ snapshots }`) — `useQueuedCartRows` passes `mutation.state.context` through, and for a mutation whose variables have neither `id` nor `productId` (the one shape left once those two are ruled out — `receiveOrder`'s input is `{ orderedVia? }` and nothing else) `queuedCartRowIds` reads the snapshot ids straight out of it. `dehydrateMutation` persists the whole `state` object, `context` included, so this holds for a mutation restored from IndexedDB after a reload too, not only a live one.

### Offline queue (task 2.4)

VISION §6.3: a tap made in a basement supermarket must survive the phone being put in a pocket and iOS killing the PWA. There is no Background Sync API on iOS and an in-memory queue dies with the process, so the queue is **persisted to IndexedDB** and delivered while the app is open — on the `online` event, and on reopening.

**There is no bespoke queue.** TanStack Query already has one: with the default `networkMode: "online"` a mutation dispatched while offline is _paused_ before its `mutationFn` ever runs, and sits in the mutation cache until something resumes it. Task 2.4 makes that cache durable and gives it delivery triggers, rather than reimplementing it beside itself. Three new dependencies: `@tanstack/react-query-persist-client`, `@tanstack/query-async-storage-persister`, `idb-keyval`. No new env vars.

| File                                                      | What it is                                                                                  |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/lib/sync/offline-cache.ts`                           | Pure: buster/max-age constants, the superjson envelope, the "what may be persisted" filters |
| `src/lib/sync/delivery.ts`                                | Pure: what may be sent again, the retry policy, queue membership, cross-context identity    |
| `src/trpc/offline-queue.ts`                               | Browser wiring: IndexedDB storage, persister, mutation defaults, delivery triggers          |
| `src/lib/sync/use-is-online.ts`                           | `useIsOnline()` over `onlineManager`, plus `primeOnlineManager()`                           |
| `src/lib/sync/queued-mutations.ts` / `use-queued-rows.ts` | Pure extraction + hook: which rows carry a queued change (the 🕐 marks)                     |

**Where it is mounted.** `TRPCReactProvider` (`src/trpc/client.tsx`) now renders `PersistQueryClientProvider` in place of `QueryClientProvider` — the same provider plus a restore-from-storage effect and an `isRestoring` context. It is rendered on the **server** too, with an inert persister that stores nothing (`createInertPersistOptions`). Swapping providers by environment instead would give the two sides different `isRestoring` values, and that context forces `fetchStatus` to `idle` — i.e. a hydration mismatch on any screen that renders a loading state. The browser query client, the tRPC client and the queue's event listeners are all built once, lazily, in a module-level singleton (`getRuntime`), so nothing is installed twice.

**What is persisted** (`dehydrateOptions`, filtered by the real `trpc.cart.pathKey()` / `trpc.cart.list.queryKey()` rather than by hardcoded strings):

- **`cart.*` mutations the router provably has not seen** — `isQueuedMutationState` decides, and it is the same test used to pick what gets resumed. Two states qualify: **paused** (with `networkMode: "online"` a mutation dispatched offline pauses _before_ its `mutationFn` runs, so it never left the device) and **retrying after an undelivered failure** (it left and came back unanswered, so the write did not happen). This is deliberately **wider** than TanStack's own `defaultShouldDehydrateMutation`, which persists paused mutations only — see the retry policy below for why a paused-only filter erases the queue.
- **A successful `cart.list`** — a warm list on reopen when the server prefetch is slow or fails. `hydrate` skips a persisted query when the cache already holds newer data, so this can never overwrite the RSC prefetch: `HydrationBoundary` is a child of the provider, and child effects run first. `cartSyncQueryOptions` sets `gcTime` to the offline cache's own `maxAge` for this reason: the persister dehydrates whatever is in the cache at the time of a save, so under TanStack's 5-minute default, walking away from S3 garbage-collects the list, the `removed` event triggers a save, and the envelope loses it hours early. Scoped to this one query — making every `product.search` immortal would grow the cache with each keystroke.

**What is deliberately not persisted:**

- **A first attempt still in flight.** There is no evidence either way about whether it landed — the tab can be killed between the request leaving and the response arriving — and `cart.add` **merges**, so guessing wrong silently turns «2 шт» into «4 шт».
- **Every other query.** The catalog, categories and kitchen profile are cheap or irrelevant to someone standing in a shop, and would only make the payload bigger and staler.

**When it is written.** The persister saves on every mutation- and query-cache event, but only from the moment `PersistQueryClientProvider` subscribes it — which happens after the restore, not before — so nothing is durable during startup. `throttleTime` is **0** rather than the library's 1000ms default: on iOS a backgrounded PWA has its timers suspended and may then be killed, so a deferred save is a save that never happens, and the payload (one cart list plus a few mutations) is far too small to trade a lost tap for. On top of the event-driven saves there are explicit ones on `pagehide` and on `visibilitychange` → hidden — the last moments an iOS PWA is guaranteed to run — and one after each delivery round, so storage stops listing what has already gone.

**The envelope is validated on the way back in.** `superjson.parse<PersistedClient>` is a type assertion, not a check, and `hydrate` walks `queries` and `mutations` without guards — a truncated write or a hand-edited entry throws mid-loop, leaving the cache half-populated _and_ the storage purged by the restore's error path. `deserializeOfflineCache` runs the decoded value through a Zod schema first, so a bad payload is rejected before anything is hydrated and the app simply boots on the server's data. The schema is deliberately **shallow** — the entries are TanStack's own `DehydratedQuery`/`DehydratedMutation`, and re-declaring their inner `state` would break on the library's next minor release, a worse failure than the one it guards. It checks exactly what `hydrate` dereferences; everything deeper is already treated as untrusted where it is read (`queuedCartRowIds`, `isQueuedMutationState`).

**The envelope is superjson**, not `JSON.stringify`. Query data is already superjson-encoded by the `dehydrate`/`hydrate` hooks in `query-client.ts`, but a mutation is dehydrated **raw** — TanStack copies `state.variables` and whatever `onMutate` returned as context straight into the payload with no `serializeData` hook. Today's cart variables are plain uuids and numbers; the first optimistic context holding a row snapshot (`updatedAt` is a `Date`) would come back as a string and blow up on the next `.getTime()`.

**Buster and max age.** `OFFLINE_CACHE_BUSTER` is derived from `OFFLINE_CACHE_VERSION` (`larder-cart-v1`) — bump the **version**, never the string. Bump it when `cart.list`'s output shape, any `cart.*` mutation **input** shape, or the serializer changes: a stored payload whose buster does not match is dropped whole rather than migrated, which is the right trade against replaying writes at a contract that has moved. `maxAge` is 48h; a queued tap older than that is no longer a fact about the cart (someone has since bought, removed or re-added the thing), and the cached list goes with it because the queue and the snapshot it was made against are one payload.

**Restoring a mutation needs its function back.** A dehydrated mutation carries its key, variables and state — never its `mutationFn`, which is a closure. `installOfflineQueue` therefore calls `queryClient.setMutationDefaults(key, { mutationFn })` for each of `cart.add`/`setStatus`/`updateItem`/`remove`/`receiveOrder`, using the standalone tRPC options proxy (`createTRPCOptionsProxy({ client, queryClient })`). Without it, resuming fails with «No mutationFn found».

The defaults are **only** the function; the rich optimistic wiring stays at the S3 call sites and deliberately does not run on resume. TanStack skips `onMutate` entirely for a mutation whose state is already `pending` (`Mutation#execute`), which is exactly right — the patch it would apply was applied in the previous session — and there is nothing left to roll back to, because the snapshot lived in the cache of a tab that no longer exists. So the resume path is simply: deliver, then re-read the cart.

**Delivery triggers.** `QueryClient#mount` already resumes paused mutations on `onlineManager`'s `online` event _and_ on `focusManager`'s `visibilitychange` — together exactly VISION §6.3's «доставка при открытом приложении», including the iOS-PWA reopen. `installOfflineQueue` subscribes to the same two managers for the parts TanStack's own resume does not cover:

- **Restored mutations that are not paused.** `resumePausedMutations()` looks only at `isPaused`; one retrying after an undelivered failure is just as much a member of the queue. `flush()` calls `mutation.continue()` over everything `isQueuedMutationState` matches, which resumes a paused retryer or executes a restored mutation from its variables.
- **The refetch after the queue drains.** S3 mutes its passive refetch triggers while `useIsMutating` is non-zero, resumed mutations count as mutating, and TanStack's own post-resume `queryCache.onOnline()` can be swallowed by a mute React has not re-rendered out of yet.

`flush()` resolves when the round is done and never rejects; production callers ignore the promise. **`onRestored()` — what `PersistQueryClientProvider`'s `onSuccess` gets — returns void immediately and must keep doing so.** The provider chains `onSuccess` _before_ flipping `isRestoring` to false, and it does not subscribe the persister until that flips: awaiting delivery there would leave the app in its restoring state, with nothing persisted at all, for as long as delivery took — which, with a queue that retries until the server answers, can be the whole session.

**Retry policy: keep what the server has not answered, drop what it has.** This is the one decision that protects the queue from a silent wipe, and it lives in `shouldRetryDelivery`/`isUndeliveredFailure` (`src/lib/sync/delivery.ts`), registered through `setMutationDefaults` so live and resumed writes share it.

TanStack's default `retry: 0` rejects on the first failure without re-consulting `onlineManager`. A **premature `online` event** — a captive-portal Wi-Fi association, where `navigator.onLine` reports a connection that cannot reach anything — therefore resumes the whole queue, every call dies at the network layer, and every mutation settles as an error. An errored mutation is no longer queued, so the next persist writes an envelope without it: the entire queue erased from IndexedDB, silently, having never reached the server, under a banner promising «изменения сохранятся».

The classifier is the tRPC error code (`trpcErrorCode`, `src/lib/trpc-errors.ts`): the router puts a code on everything it produces, so a coded error is the server's _answer_ (fail fast — the row a partner removed, a CONFLICT) and an uncoded one never reached a procedure (a dead fetch, a proxy's 502, a portal's interception page — retry). Retries are **unbounded** for the uncoded case: a capped count would only move the cliff a minute later. The retryer's own backoff (1s, 2s … 30s) makes that cheap, and it is self-limiting where it matters — when the device really goes offline, `canContinue()` fails, the retryer **pauses** rather than running, and the mutation is written back to storage as a paused one.

A dropped mutation settles as an error, stops matching the queue test, and is therefore no longer persisted — it cannot wedge the queue or return on the next reload, and since no mutation sets a `scope`, nothing queues behind it. Nothing is announced: the tap belonged to a previous session, and the invalidate that follows puts the true state on screen. `cart.remove` is already idempotent for exactly this reason (no NOT_FOUND when nothing matched).

**Two contexts, one envelope.** A PWA and a browser tab can be open on the same origin and share this storage, so both can restore the same queue and both would deliver it. Two things guard that:

- Delivery runs under an exclusive **Web Lock** (feature-detected, iOS 15.4+; a 5s acquisition timeout means a context stuck retrying can never block another one's startup — the round is simply skipped and retried on the next trigger). The rewrite-to-storage is **inside** that lock, not after it: released a moment early, the other context could acquire the lock and read an envelope that still listed everything this one just delivered.
- Before sending, `flush()` re-reads the stored envelope and **drops restored mutations storage no longer lists** (`mutationIdentity` = mutation key + `submittedAt`, since `mutationId` is not dehydrated). Only mutations captured at restore are eligible — a live tap has not been anywhere near another context.

An **absent** envelope is deliberately not treated as evidence of delivery: a context that drained the queue always leaves one behind, so "delivered elsewhere" always looks like a _present_ envelope that no longer lists the mutation. Absent means something else (expired, purged by sign-out, a read that raced a write), and dropping on it would throw away taps nobody has sent.

The residual: two contexts that restore in the same instant, before either has rewritten the envelope, can still both deliver. Only `cart.add` is non-idempotent under that, and it surfaces as a quantity the household can see and correct.

**Mutations delivered into a closed trip** land in the current cart by the ordinary merge rules — the server needs no special case, because an active row is trip-less by design (see [the one-active-row invariant](#the-one-active-row-invariant)).

**`onlineManager` is primed from `navigator.onLine`** once, at client creation (`primeOnlineManager`). It otherwise starts optimistically `true` and only moves on the window's `online`/`offline` events, so a tab _loaded_ while offline would report online and every mutation would fail outright instead of joining the queue.

**The UI reads the queue, it does not track it** (mockup 1c). The banner («Нет связи — изменения сохранятся») is `useIsOnline()`, a `useSyncExternalStore` over `onlineManager` — the same source of truth that decides whether a mutation runs or pauses, so it can never disagree with what the queue is doing. `getServerSnapshot` is always `true`: HTML that arrived over the network has no business saying there is none. The per-row 🕐 marks come from `useMutationState` filtered to `trpc.cart.pathKey()`, with `queuedCartRowIds` (pure, tested) pulling row ids out of the variables — or, for `cart.receiveOrder` (task 2.5), out of its own `onMutate` context instead, since by the time this runs the row has already been optimistically moved out of the status that variables-based matching would need (see [«Заказ получен»](#row-action-sheet-badge-buyer-avatar-заказ-получен-task-25) above). **Paused only**, never merely in flight: a mutation on the wire already shows `data-pending` from task 2.3, and 🕐 means "waiting for the connection", not "waiting for the server". **A queued `cart.add` marks nothing** — it names a product, not a row, and the line it will create or merge into does not exist yet. In the header, offline **wins over** «синхронизируем»: a paused mutation still counts as mutating, so without that precedence the header would claim to be syncing for as long as the connection is gone. «Обновить» is disabled while offline, where a refetch would not fail but pause, leaving the control spinning on a promise it cannot keep.

**Signing out clears the cache** (`sign-out-button.tsx`): the query client is a tab-lifetime singleton and sign-out does not reload the page, so without `queryClient.clear()` the next person to sign in on the device would be shown the previous household's cart — now out of storage rather than just out of memory. `clear()` alone is **not** enough for the stored copy: it emits the cache events the persister listens to, but that write goes through the persister's throttle and nothing awaits it, so a reload landing in the gap would restore the household just signed out of. `queue.purge()` (`persister.removeClient()`, which goes straight at the store) is therefore awaited right after. A save already scheduled can still land afterwards, but `asyncThrottle` keeps only the latest arguments and the cache is empty by then, so the worst it re-creates is an empty envelope. Before all of that, one **bounded** delivery attempt runs (`resumePausedMutations()` raced against a 2s timeout) — and it has to run _before_ `signOut()`, because afterwards every queued write would come back UNAUTHORIZED. It is an attempt, not a guarantee: offline, `resumePausedMutations` resolves at once and the queue is dropped with the cache. The auth boundary wins over an undelivered tap, because the alternative is keeping one person's writes on a device the next person is about to sign in on.

**Known limits, all accepted for the MVP.**

- **No service worker yet**, so opening the app cold while offline still fails at the HTML request. The queue covers "went offline while it was open, then the PWA was killed" — the iOS case VISION §6.3 is written about.
- **The per-row tap lock from task 2.3 is not released when a mutation pauses**, so a row with a queued change cannot be re-tapped until the queue drains within that session. Across a reload the lock is gone while the queued mutation is not; two queued changes to one row then resolve by last-write-wins like any other conflict.
- **The add flow is effectively online-only.** S4's autocomplete query pauses offline and says so («Нет связи — поиск недоступен»), so the flow normally dead-ends at the search step. The one way past it is to open S4 online, get results, then go offline before tapping «В корзину»: the `add` is queued and will be delivered, but `submitAdd` awaits `mutateAsync` for the outcome that decides the toast — added / merged / unit conflict / already bought — so the sheet's «Добавляем…» stays up until the connection returns or the person closes it by hand. Guessing an outcome the server has not decided is worse than waiting for it, so the honest fix is an offline add path with its own copy — a job for 2.5, which reworks that sheet anyway.
- **Delivery is at-least-once, not exactly-once.** Two cases can send a write the server already applied: a crash after the write but before the response (indistinguishable from "never arrived"), and two contexts restoring the same envelope in the same instant. `setStatus`, `updateItem` and `remove` are idempotent, so only `cart.add` can show it — as a doubled quantity, which the household can see and correct. The alternative (drop anything unproven) trades a visible, correctable error for an invisible, uncorrectable one; idempotency keys are the real fix and are post-MVP.
- **A queued change delivered in a _later_ session can still flash as a partner change.** `cart-screen.tsx` re-marks the row in `onSettled` so a same-session delivery is suppressed, but a mutation restored from storage has no observer and no `ownChangesRef` continuity across a reload. Highlighting a row that genuinely changed since the screen opened is defensible; it is simply not distinguishable from the partner's edit.

## Pantry

"What's at home" (VISION §3.2) — presence only, no quantities, no expiry dates: a conscious scope cut, the same reasoning VISION gives for why full stock-level tracking gets abandoned in practice. Task 3.1 builds the model, the `pantry` router, the S5 screen and the S3/S5 «Корзина | Кладовая» segment control; task 3.2's «Завершить закупку» ([Closing a trip](#closing-a-trip-завершить-закупку)) is what populates the table — bought cart lines moving here on trip close is the **only** way a row ever appears.

`pantry_items` (`src/db/schema.ts`): `householdId`, `productId` (FK `restrict` — same reasoning as `cart_items.product_id`), `createdAt`, `updatedAt`. No `qty`, no `note` — a row's mere existence is the entire fact.

**The unique index is on `productId` alone, no `householdId`** — exactly `cart_items`' own partial-unique-index reasoning: a product row belongs to exactly one household, so uniqueness per product is already at least as strict as uniqueness per (household, product). Unlike `cart_items`' index it is **not partial** — a pantry row has no `tripId`-style "still active" qualifier to scope it by; one row per product, full stop.

### `pantry` router

| Procedure       | Boundary             | Notes                                                                                                  |
| --------------- | -------------------- | ------------------------------------------------------------------------------------------------------ |
| `pantry.list`   | `householdProcedure` | The household's pantry, in `cart.list`'s own walking order (department `sortOrder`, then product name) |
| `pantry.ranOut` | `householdProcedure` | `{ id }` (the pantry row) → the four-way outcome union below                                           |

There is no `create`/`remove` endpoint. Rows are populated by `trip.close` and emptied exclusively by `ranOut` — a pantry fact is never edited by hand, only asserted true (a purchase) or false (running out).

`ranOut`'s transaction opens with the household's advisory lock (task 3.2) — see [Lock ordering](#lock-ordering-between-tripclose-and-pantryranout) for why that line is load-bearing rather than ceremony.

### «Кончилось» (`pantry.ranOut`, `src/server/pantry/ran-out.ts`, pure, unit-tested)

**Ensure-in-cart, not add-quantity.** «Кончилось» asserts presence-needed, not a quantity to add on top of whatever is already on the list — the pantry itself tracks no quantities to compute one from. `decidePantryRanOut({ existing, defaultUnit })` is the decision half, with no database in it, mirroring `decideCartAdd` (`src/server/cart/merge.ts`) but narrower — no merge branch, no unit-mismatch question, because there is nothing to sum:

| Existing active cart row | Outcome         | What happens                                                                                                                              |
| ------------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| none                     | `added`         | new `needed` line, qty **1**, the product's `defaultUnit`                                                                                 |
| `needed` / `ordered`     | `alreadyInCart` | row left **completely** untouched — not bumped                                                                                            |
| `bought`                 | `restored`      | → `needed`, **keeping** the row's own qty/unit (there is no new quantity to replace them with), buyer and `orderedVia` cleared, note kept |

The router (`src/server/api/routers/pantry.ts`) supplies the locked rows the same way `cart.add` does, reusing its exact tested helpers rather than a second copy: `lockActiveItem`, `insertActiveItem`, `activeItemScope`, `cartItemColumns` and `toCartItemOutput`/`toUnit` are exported from `cart.ts` for this — behaviour unchanged, `export` added to existing functions.

**The delete is one `DELETE … RETURNING`, not a separate locking `SELECT` followed by a delete.** `DELETE FROM pantry_items WHERE id = … AND household_id = … RETURNING product_id` already gives the atomicity a `SELECT … FOR UPDATE` would: it either removes a row nobody else has removed yet and hands back its `productId`, or it matches nothing and the call knows at once there is nothing left to do. Two overlapping calls for the same row — a double tap, or an offline-queue replay racing a live one — can never both see a row to act on; exactly one wins the delete.

**`gone` is a no-op, not an error**, and it is what makes the whole mutation replay-safe for at-least-once delivery: a pantry row a partner already cleared (or a queued tap replayed after this one landed) is simply too late to mean anything — the cart line it would have ensured already exists from whichever call won. A `ranOut` sent twice is `gone` the second time, never a duplicate line.

Ensuring the cart line then follows `cart.add`'s own shape: lock the product's active row, decide, and — for the one outcome with nothing to lock (`added`) — retry once against whatever a concurrent insert won the race with (`RAN_OUT_ATTEMPTS = 2`, same bound and same reasoning as `cart.add`'s `ADD_ATTEMPTS`).

### Pantry screen (S5, task 3.1) and the segment control

`purchases-screen.tsx` is the «Покупки» tab's actual root now (`page.tsx` renders it, prefetching both `cart.list` and `pantry.list`): the «Корзина | Кладовая» segment control, local `useState`, defaulting to «Корзина», with `CartScreen` or the new `PantryScreen` mounted underneath. The control sits **above** both screens rather than folded into `CartScreen`'s own toolbar — `cart-screen.module.css` had a forward-looking comment speculating the control would replace that toolbar's title/count pair; it does not, by decision recorded in that file and in `purchases-screen.tsx`'s own doc comment. `CartScreen` is a large, already-tested, actively-synced component (tasks 2.2–2.5), and reaching into its toolbar to also drive a sibling screen would mean threading tab state through it for no benefit to the cart itself. A thin wrapper gets the same DESIGN_BRIEF layout with a far smaller blast radius.

`PantryScreen` (`pantry-screen.tsx`) is `CartScreen`'s shape pared down to what S5 actually shows: `groupProductsByCategory` sections, no checkbox, one action per row («Кончилось»), no offline banner, no highlight-on-refetch machinery, no row action sheet — none of that is in task 3.1's scope (long-tap «изменить продукт» mirrors S3's row sheet and is still deferred; «Ревизия» shipped in task 3.3, see below). It reuses `cartSyncQueryOptions` (`src/lib/sync/cart-sync-presets.ts`) for `pantry.list` as-is — that preset's own doc comment already anticipated being used for "cart.list and, later, anything else task 2.3+ renders alongside it".

**«Кончилось» is optimistic, the same pattern as the S3 checkbox** — but a **removal**, not a field patch, because a pantry row's whole lifecycle _is_ presence: `removePantryRow`/`restorePantryRow` (`src/lib/pantry/optimistic-remove.ts`, pure, tested) take the row out of the cached `pantry.list` in `onMutate` and can put it back at the exact index it came from if the mutation fails — never appending it at the list's end, which would jump it across a department-section boundary the same way an unscoped `sortBoughtLast` would in the cart. The double-tap guard is a synchronous ref (`pendingRef`), not render state, for the same reason `cart-screen.tsx`'s own is. `describePantryRanOutOutcome` (`src/lib/pantry/ran-out-outcome.ts`, pure, tested) maps the four outcomes to a toast: `added`/`restored` both read «В корзине» (the distinction is server bookkeeping, not something worth a different sentence to the shopper), `alreadyInCart` reads «Уже в корзине», `gone` is silent — the row is already off the screen by the time the answer comes back, so there is nothing left to point a toast at.

**Fire-and-observe, never `mutateAsync` awaited** — `ranOut.mutate(...)`, exactly the rule `cart-screen.tsx` follows for the same reason: a mutation TanStack pauses for being offline may not resolve for as long as the connection is down.

**Not wired into the IndexedDB offline queue** (`src/trpc/offline-queue.ts`), and this is a deliberate, documented scope decision rather than an oversight. That module's persistence filter (`createOfflineCacheFilters`, `src/lib/sync/offline-cache.ts`) is hard-scoped to the `cart` router's path key and `cart.list`'s query key; widening it to a second router — and bumping `OFFLINE_CACHE_VERSION`/the buster, since the persisted shape would change — is a real piece of work with its own blast radius (every existing stored envelope, every offline-cache test), not something that belongs as a side effect of the pantry screen's PR (AGENTS.md: no drive-by refactors inside feature PRs). What this costs in practice: a `pantry.ranOut` made while offline still **pauses** rather than fails — that much is TanStack's own default `networkMode` behaviour, independent of this app's queue — and resumes automatically as long as the app stays open until the connection returns. What it does not survive is the app being killed while still offline (the iOS-PWA case the cart's queue exists for): the paused mutation and its optimistic patch are both only in memory, so on the next load `pantry.list` simply refetches from the server and the row reappears, exactly as if the tap never happened. Nothing is corrupted on either side — the mutation was designed to be replay-safe (`gone`) precisely so that widening the queue to cover it later is a config change, not a rewrite.

### Revision mode (S5, task 3.3)

«Ревизия» (DESIGN_BRIEF S5, VISION §3.2): a full-screen, one-card-at-a-time pass through the pantry — swipe (or tap the two buttons below the card, or ArrowRight/ArrowLeft) «есть» / «кончилось» for each, watch «12 из 34» climb, land on a summary once the deck runs out. `revision-mode.tsx` (`RevisionMode`), launched from a toolbar button on `PantryScreen` (hidden — not disabled — while the pantry is empty).

**Pure logic lives in `src/lib/pantry/`, unit-tested without a DOM:**

- `revision-deck.ts` — `buildRevisionDeck` (a defensive per-row copy, not just an array copy — a future mutation to a cached pantry row, or to a deck row, can never leak across the snapshot boundary either way), the `{ index, ranOutIds }` reducer (`decideRevisionCard`), `revisionProgress` (the «12 из 34» + `finished` flag), and `summarizeRevision` (a discriminated `{ kind: "empty" }` vs. `{ kind: "counted", count }`, not just a bare count — see below for why).
- `swipe-commit.ts` — `decideSwipeCommit({ dx, dy, recentDx, recentElapsedMs })`: a 96px total-distance floor (`dx`/`dy`) commits any deliberate drag regardless of speed; a 24px/0.5px-per-ms pair, measured only over the *most recent* ~100ms window (`recentDx`/`recentElapsedMs`), separately commits a fast short flick; a drag that moved more vertically than horizontally never commits. `recentDx`/`recentElapsedMs` are deliberately not the same span `dx`/`elapsedMs` cover: a drag that holds still for a while and then flings at the very end must still read as fast, and averaging over the whole gesture's elapsed time would dilute a genuinely fast release into a slow one.

**The deck is a one-time snapshot, not a live view.** `buildRevisionDeck` runs once, inside a lazy `useState` initializer in `RevisionMode` — so a `pantry.list` refetch landing behind the overlay (background poll, focus regain, a partner's own tap) can never reshuffle or grow the deck mid-run. A partner's addition simply isn't part of this session; it'll be there next time «Ревизия» opens.

**«Кончилось» reuses `pantry-screen.tsx`'s own `ranOut` mutation, not a second copy.** `fireRanOut` (extracted out of what was `handleRanOut`) does the "mark pending, remember the name, call `ranOut.mutate`" half shared by both the list row's own button and the revision mode; each caller keeps its own pre-guard on top (the row moves focus and starts the fly-to-cart ghost; the revision mode advances its own deck and plays its own card-exit animation instead — DESIGN_BRIEF makes no mention of the ghost for this mode, and the underlying list isn't even visible behind the full-screen overlay to fly toward).

**The mutation fires on commit, before the card's own exit animation plays — not after.** `commitDecision` calls the caller's `onRanOut` synchronously the instant a swipe/tap/arrow-key commits; only the *visible* deck advance (`setState`) waits ~220ms for the fling-away transition to finish. Closing the overlay mid-fling (the header's crest, or Esc) must not "un-decide" a swipe that already committed — decisions made this run stay made, matching the plan's own "выход на середине — крестик в шапке; ... no batch/undo" framing. The double-tap/double-swipe guard is a synchronous ref (`decidingRef`), the same reasoning `pantry-screen.tsx`'s own `pendingRef` documents, backed by a 250ms `COMMIT_COOLDOWN_MS`: `decidingRef` alone unlocks synchronously under `prefers-reduced-motion` (there is no fling to wait out), so without the cooldown a held arrow key's OS auto-repeat — separately rejected outright via `event.repeat` — or a mashed button could otherwise commit the whole remaining deck in under a second.

**A settled or failed outcome surfaces inside the dialog itself, not `pantry-screen.tsx`'s own toast.** `onRanOut`'s second argument is an `onOutcome` callback `RevisionMode` hands the caller; `handleRevisionRanOut`/`fireRanOut` register it per tap (`pendingOutcomeCallbacks`, keyed by pantry-row id, since `ranOut` is one shared mutation instance) and invoke it from `onSuccess`/`onError` in place of `showToast` for that id. This is not cosmetic: `pantry-screen.tsx`'s toast sits at a lower z-index than the overlay and its live region lives outside the dialog's `aria-modal` subtree, so a failed «кончилось» would otherwise be both invisible and unannounced — the card already flung off screen as if the tap succeeded, and the only sign anything went wrong would be the product quietly still sitting in the pantry afterwards. `RanOutFeedback` (`src/lib/pantry/ran-out-outcome.ts`) is the shared `{ visible, sr }` shape both screens' toasts render.

**Every drag in progress is cancelled the instant any commit starts** (`cancelActiveDrag`, first thing inside `commitDecision`, before anything else) — a keyboard/button commit landing while a finger is still down on the card would otherwise leave the drag to resolve against whichever card comes *next* once that finger eventually lifts. Pointer handling is also hardened against a few edge cases a plain drag-and-drop implementation misses: a second finger touching the card while the first is still down is rejected outright (`dragRef.current !== null`, plus `event.isPrimary`), rather than silently overwriting the active drag's baseline and stranding the first finger's own release; `releaseDrag` checks the released pointer's id *before* clearing the drag state, not after, so a mismatched event can never wipe out a still-active drag that belongs to a different pointer; and a right-click (`event.button !== 0`) never starts a drag at all, since some browsers suppress the matching `pointerup` once its context menu opens (`onLostPointerCapture` is wired to the same cleanup as `pointercancel`, as a backstop for exactly that case).

**Not a `BottomSheet` instance.** DESIGN_BRIEF calls this a "полноэкранный режим" — a different register from the bottom-sheet-with-scrim pattern every "add/edit a thing" flow in this app uses. `revision-mode.tsx` copies `BottomSheet`'s focus-trap / Esc / body-scroll-lock conventions rather than importing the component, since none of that behaviour is specific to the sheet shape; `useSheetOpener` (`src/components/use-sheet-opener.ts`) is reused as-is for focus-return-on-close. Unlike `BottomSheet`, the cleanup reads `restoreFocusTo.current` fresh at unmount rather than a value captured once at mount — `pantry-screen.tsx`'s own `onClose` handler redirects that ref to `screenRef` when the toolbar button that opened the overlay has itself unmounted mid-run (the shopper ran the pantry empty), and that redirect only has anywhere to land if the cleanup reads it live.

**Accessibility:** the swipe is never the only way to decide a card — two labelled buttons («Есть» / «Кончилось») sit under it, and ArrowRight/ArrowLeft mirror them. Progress and the final summary are both announced through a `seq`-keyed live region — mounted *inside* the `role="dialog" aria-modal="true"` subtree, not a sibling of it, since assistive tech that honors `aria-modal` (VoiceOver among them) prunes anything outside that subtree from the tree entirely and would otherwise never speak it — seeded once on open with the first card's own progress text (without that seed, a screen-reader user hears nothing at all until their first decision, since the visible «12 из 34» is `aria-hidden`), the same pattern `pantry-screen.tsx`'s own toast uses to force a real node replacement even when consecutive announcements would otherwise be textually identical. Focus moves to the summary screen's own button the instant the run finishes, since the body branch — including whichever control was just focused — unmounts wholesale when the summary replaces it. `prefers-reduced-motion` skips the card's fling/spring-back animation entirely (the deck still advances immediately, nothing waits on a transition that isn't playing).

**N = 0 gets its own copy, not a plural of zero.** `summarizeRevision` returns `{ kind: "empty" }` rather than `{ kind: "counted", count: 0 }` specifically so the summary screen can render «Всё на месте — ничего не кончилось» instead of a grammatically-correct-but-tonally-wrong «Готово: 0 продуктов улетело в корзину». `pantryRevision.summaryDone`'s ICU plural (`one`/`few`/`many`/`other`) only ever has to handle `count >= 1`. This count is taps decided «кончилось» this run, not settled outcomes — it is never revised after the fact if one of those taps later rolls back; the in-dialog error toast above is the compensating fix for that gap, not a reconciled count.

## Closing a trip («Завершить закупку»)

The hinge between the cart and the pantry (VISION §3.1, §3.2), and the moment purchase history comes into existence. Task 3.2: the `trip` router, the S3 bottom-bar button and the S12 history block.

### `trip` router

| Procedure    | Boundary             | Notes                                                                                   |
| ------------ | -------------------- | --------------------------------------------------------------------------------------- |
| `trip.close` | `householdProcedure` | No input. → `{ tripId, count, productIds }`, `tripId` null for the no-op                |
| `trip.list`  | `householdProcedure` | Closed trips, newest first, each with its line count (`LIMIT 50`, no pagination in MVP) |

**What `close` does, in one transaction:**

1. Takes the household's advisory lock (below).
2. `SELECT … FOR UPDATE` over the household's active `bought` lines. It answers "is there anything to close" _and_ pins the answer: with those rows locked, a partner un-ticking one blocks until this transaction commits, so the set counted is exactly the set stamped.
3. Inserts the `shopping_trips` row — **only if step 2 found something**.
4. Stamps `trip_id` on exactly those lines (re-checking `household_id`, `trip_id IS NULL` and `status = 'bought'` — an id never reaches a write on its own, VISION §6.7), then upserts one `pantry_items` row per stamped product.

**The purchase is the household's, not the shopper's.** Every bought line goes, whoever ticked it — VISION §3.1's «чьи бы они ни были: закупка общая на household». `needed` and `ordered` lines stay in the cart: a delivery that has not arrived is not part of the run that just ended.

**The stamp is what frees the partial unique index.** `cart_items_productId_active_uidx` is `WHERE trip_id IS NULL`, so stamping a line is what lets the same product be added — and bought — again next week. This is the only place `trip_id` is ever written.

**Nothing bought is an idempotent no-op**: `{ tripId: null, count: 0, productIds: [] }`, no error and **no trip row**, the same shape `cart.receiveOrder` returns when nothing is ordered. Minting a trip for an empty run would put a permanent «0 позиций» line in the S12 history for a tap that did nothing. If the stamp somehow matches no rows after the trip row has been inserted (unreachable while step 2 holds its locks), the procedure throws rather than returning: the trip row is already in the transaction, and rolling back is the only way not to leave an empty one behind.

**The pantry upsert is `ON CONFLICT (product_id) DO UPDATE SET updated_at = now()`**, not `DO NOTHING`: buying something the pantry already lists is a fresher fact about the same product, not a no-op. Presence only — the insert carries the pair of ids and nothing else (VISION §3.2). The product ids are de-duplicated first: the partial unique index already guarantees one active line per product, but a multi-row `ON CONFLICT DO UPDATE` whose values hit one key twice is a hard Postgres error (21000, "cannot affect row a second time"), and an impossible state should not become a failed purchase.

**The partner sees the closure on their next refetch** (VISION §6.3) — no realtime in the MVP. The plan row's mention of "realtime-события" is legacy wording from before that decision.

### Lock ordering between `trip.close` and `pantry.ranOut`

`src/server/household-lock.ts`, and it is a real bug fixed rather than a precaution:

- `pantry.ranOut` locks **pantry row → cart row**: `DELETE … RETURNING` on `pantry_items`, then `SELECT … FOR UPDATE` (or an insert against the cart's unique index).
- `trip.close` has to lock **cart rows → pantry row**: the stamping `UPDATE … RETURNING` is what authoritatively decides which products were bought, so it cannot come second.

Run both for the same product at the same instant and Postgres has a lock-order cycle: `ranOut` holds the pantry-row delete and waits for the cart row, `close` holds the cart row and waits on the pantry key's uncommitted delete. One of them is aborted with **40P01** — a 500 for a tap that did nothing wrong.

**The resolution is a coarse per-household serialization**: both transactions take `pg_advisory_xact_lock(hashtextextended(household_id::text, 0))` as their **first** statement (a lock taken after the first row lock orders nothing). Transaction-scoped rather than session-scoped, so Postgres releases it on commit or rollback — there is no unlock to forget, which matters on serverless where the connection outlives the request. The cost is nothing in practice: a household is two people, these are the only two transactions that take it, and the contention window is one tap against the partner's.

**The alternative was reordering `close`, and it does not survive its own correctness requirement.** For `close` to touch the pantry first it would have to read the bought lines without locking them; any line un-bought in that gap would leave a pantry row for something still sitting in the cart. Hash collisions between two households are possible in principle and harmless: two unrelated households briefly serialize with each other, which is not a data problem.

Both sides are covered by a test that fails if the lock moves or disappears (`trip.test.ts`, `pantry.test.ts`) — the db stub records `db.execute()` statements and their position, so "first statement of the transaction" is assertable without a database.

### S3 «Завершить закупку (N)»

`cart-screen.tsx`: a second button in the existing bottom action bar (never a second floating pill — the bar is one decision), rendered only while at least one row is `bought`, with `N` = that count. One tap, no confirmation dialog, per DESIGN_BRIEF S3.

**Deliberately not optimistic**, unlike everything else on this screen. The server decides which lines were bought at that instant — including the partner's ticks this client may not have refetched yet — so a client-side guess would routinely be wrong about the count and about which rows to remove. It is also not till-critical the way the checkbox is: one tap at the end of a run, with a «Завершаем…» label, is the honest shape. The double-tap guard is still a synchronous ref (`isPending` lands a render too late, and two closes in one tick would mint two trips), and the button uses `aria-disabled`, never `disabled`, so a keyboard user is not thrown to the top of the page mid-tap; on success focus moves deliberately to «+ Добавить», since the button is about to unmount with the rows it counted. That move waits for the refreshed list to render rather than happening in `onSuccess` — a trip that empties the cart swaps the action bar for the empty state, so the button to focus does not exist yet at that point — and it only ever rescues focus that was actually lost (`document.activeElement` is `body`), never steals it from a sheet the shopper has since opened.

`onSettled` invalidates **three** queries: `cart.list` (it loses the bought lines), `pantry.list` (it gains a row for each of them, so leaving it alone shows a stale «Кладовая» one segment-control tap away) and `trip.list` (S12's history is missing exactly the trip just closed; with a 30s `staleTime` and Next's client-side Back restoring a cached page without re-running its server prefetch, the block would otherwise be a tap out of date). `trip.close` also mutes the cart's passive refetch triggers while it is in flight, the same way `cart.*` mutations do (`useIsMutating` on `trpc.trip.pathKey()`).

**The button is refused while offline or while a write of ours is still out** — the same two conditions «Обновить» is disabled by, and here they prevent a wrong purchase rather than a wasted request. A `trip.close` tapped offline does not fail, it _pauses_, alongside the bought ticks made offline; nothing orders those on reconnect (`resumePausedMutations()` fires the whole set together), so the close can reach the server ahead of the ticks it counted and close a trip missing exactly them — the button said 5, the toast says 3, and two lines stay in the cart as bought. The online miniature is the same race inside one second: tick the last item, tap close immediately, and the close can be served before that `setStatus`. `useIsMutating` counts paused mutations as well as in-flight ones, so the guard also holds the button closed until the offline queue has actually drained. This is the accepted-scope answer while `trip.close` stays out of the IndexedDB queue; ordering the queue itself is what a proper integration would do instead.

The S3 live region's child is now keyed on the toast sequence, the solved version from `pantry-screen.tsx`: React skips an in-place text update when the new string is identical to the old one, so two consecutive identical toasts used to be announced once.

**It is never sent offline in the first place** (the guard above), so unlike `pantry.ranOut` it does not sit paused in memory waiting for a connection. It is also not wired into the IndexedDB queue (`src/trpc/offline-queue.ts`), for the reason `ranOut` is not: that module is hard-scoped to the `cart` router's path key, and widening it to a second router is its own piece of work rather than a side effect of this PR. The cost is that closing a trip is an online-only action — correct, since the set of bought lines it stamps is a server-side fact and the offline backlog is precisely what would make it wrong. A duplicate delivery cannot duplicate a trip either: the second one finds whatever is bought _at that moment_, which for an immediate replay is nothing at all — the no-op, no second trip row.

### S12 «История закупок»

`settings/trip-history-section.tsx`, prefetched with the page like the kitchen profile beside it. One row per trip: the date and «N позиций». Skeleton level on purpose — DESIGN_BRIEF's «строка раскрывается в список купленного» needs a per-trip read that task 7.1 adds with the rest of the S12 assembly, which is also why `trip.list` returns a count rather than the lines themselves.

The date goes through **next-intl's `useFormatter`**, not `toLocaleDateString`: this is a client component, so it renders on the server too, and next-intl resolves the time zone once on the server and hands that same zone to the client provider. A raw `Intl` call would use the server's zone during SSR and the browser's after hydration — a mismatch landing exactly on dates near midnight. No global `timeZone` is configured (`src/i18n/request.ts`), so dates read in the deployment's zone (UTC on Vercel); pinning the household's own zone is a settings question for task 7.1.

## Kitchen profile

A household's equipment checklist + headcount (VISION §3.3, §5) — what a recipe is checked against, and what the assistant reads for "adapt this to what we have" once it exists. Task 1.4 builds the model, the router, the S2 onboarding step and a first S12 settings section; the assistant integration is later.

`kitchen_profiles` (`src/db/schema.ts`) is keyed by `householdId` itself (no separate `id` — the row is 1:1 with the household), plus `householdSize` (default 2) and `equipment` (`text[]`, default `{}`).

**Presets vs. free-form.** `src/server/kitchen/equipment.ts` exports `EQUIPMENT_PRESETS` — the 11 checklist slugs (`oven`, `microwave`, `kettle`, `induction_hob`, `blender`, `grater`, `garlic_press`, `multicooker`, `mixer`, `airfryer`, `food_processor`) DESIGN_BRIEF §5 lists, our own starting profile being the first seven. `equipment` stores a mix of these slugs and whatever free text someone types into the "add your own" field in the same array — the checklist just renders the preset subset as checkboxes.

Recognizing that typed text actually names a preset is a two-layer split:

- **Client** — `resolveEquipmentEntry()` (`src/lib/equipment-entry.ts`, pure, unit-tested) matches an "add your own" entry against both the slug strings and their localized checklist labels (built from the same `kitchenProfile.equipment.*` messages the checkboxes render), case-insensitively. So typing the slug, the checklist's own label for it, or a different casing of either, all resolve to the `oven` box in `kitchen-profile-form.tsx` instead of adding a redundant chip beside it. `withSlugChecked()`, colocated in the same file, also drops any free-form entry that already case-insensitively equals the slug being checked (a stray "Oven" chip, say) before appending the canonical slug — otherwise `normalizeEquipment`'s own dedup would collide with it and the checkbox would silently do nothing.
- **Server** — `normalizeEquipment()` never sees a localized label, only slugs and free text that already agree with the checklist by the time they reach it. It cleans that up: trim, cap at 40 chars, drop empties, dedupe (exact match for a preset slug, case-insensitive for everything else). Both the client (as chips are added) and the server (on every `update`) run this same function, so the two always agree on the final list.

### `kitchenProfile` router

| Procedure               | Boundary             | Notes                                                                                                                            |
| ----------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `kitchenProfile.get`    | `householdProcedure` | `{ householdSize, equipment } \| null` — null means never set; the client falls back to size 2, no equipment                     |
| `kitchenProfile.update` | `householdProcedure` | Upserts via `onConflictDoUpdate` on `householdId` — there is no client-sent id to check, the target is always `ctx.household.id` |

### Screens

| Route                      | What it is                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `/onboarding/kitchen`      | S2 step, reached after a household exists — "Done" or a quiet "Skip", both land on `/`                      |
| `/settings` (S12 scaffold) | Page title, the kitchen-profile section, then signed-in identity + sign-out — task 7.1 adds the rest of S12 |

Both screens render the same `src/components/kitchen-profile-form.tsx` — checklist, free-form chips, a 1–10 household-size stepper — so the two can never drift. The form is a plain controlled component (no autosave): the caller owns the `kitchenProfile.update` mutation and passes `pending`/`onSubmit` in.

`OnboardingScreen`'s "Continue" action and the invite-accept success path both now land on `/onboarding/kitchen` instead of `/` (`ONBOARDING_KITCHEN_PATH` in `src/lib/auth-redirect.ts`); the kitchen step itself is the one that finally lands on `/`.

**The S2 step reads before it writes.** `/onboarding/kitchen`'s `page.tsx` calls `kitchenProfile.get()` server-side and passes the result into `KitchenOnboardingScreen` as `initialProfile` — it does not default the form to size 2 / no equipment unconditionally. The reason is who actually lands on this step: the household's creator may reach it having already filled the profile in, and the _partner_ accepting the invite lands here right after, on the very same household. A hardcoded blank default would let the partner's first, empty "Done" tap silently overwrite whatever the creator already saved — `initialProfile` is what makes the step idempotent instead.

The S12 section (`kitchen-profile-section.tsx`) makes the equivalent guarantee against its own query state: the form only ever mounts once `kitchenProfile.get` has resolved to a real value (success) or `null` (never set) — `profile.isPending` shows a loading line and `profile.isError` shows a retry button instead, so the Save action can never fire against `DEFAULT_VALUE` while the actual profile failed to load.

### Header avatar entry

`src/components/app-header.tsx`, mounted in `AppShell`: household name on the left, the participants' avatars (image, or an initial-letter circle) on the right, the caller's own linking to `/settings` — DESIGN_BRIEF §2's "tapping your own avatar opens Settings". `(app)/layout.tsx` passes `householdName`/`userName`/`userImage`/`partners` down from the same session/household load the gate already does. Task 2.3 completed the header with the partner avatars and the sync mark — see [Cart screen](#cart-screen-s3-task-23).

## Dishes and recipes

The household's recipe library (VISION §3.3, DESIGN_BRIEF S6/S7) and the model phase 5's week menu and phase 6's assistant are both built on. Task 4.1 ships the schema, the `dish` router, S6 and the read-only S7; tasks 4.2–4.7 extend the same aggregate (the S8.3 form, photo/URL/text import, portion rescaling, AI adaptation, cooking mode) and append their own `###` subsections here.

### The aggregate: four tables, one version token

`dishes` ⟶ `recipes` (1:1, `unique(dish_id)`) ⟶ `recipe_ingredients` / `recipe_steps`. All four carry a plain `household_id` (the settled tenant-isolation rule), and every child table carries it in its own right — `DELETE FROM recipe_ingredients WHERE recipe_id = $1` has nowhere else to put the household predicate, and a predicate expressible only through a join is one refactor from vanishing.

**`dishes.version integer` is the concurrency token, not `updated_at`.** Every write to the dish, its recipe, its ingredients or its steps bumps it by one, and `dish.update` refuses a save whose `expectedVersion` no longer matches (`CONFLICT` → «Блюдо изменили — обновить?»). An integer, because every router here writes `updatedAt: sql\`now()\`` at microsecond precision, postgres.js parses `timestamptz` down to a millisecond `Date`, and superjson round-trips that — a `WHERE updated_at = $clientDate` guard could silently never match and turn every legitimate save into a conflict. It doubles as the non-`Date` remount key `` `${id}:${version}` `` the S8.3 form uses in task 4.2, which is what stops a background refetch from wiping a half-typed recipe.

**`recipes` has its own `id` primary key with `unique(dish_id)`, not `PRIMARY KEY (dish_id)`.** Children carry `recipe_id`; a child column named `dish_id` whose foreign key actually points at the `recipes` table would be a trap for every hand-written join and for phase 5. `recipes_dishId_uidx` is where the 1:1 invariant lives, so no writer can give one dish two recipes.

**What that index does *not* do is deduplicate a double-tapped save.** `dish.create` mints a fresh `dishes.id` and inserts the recipe against it, so the index can never fire on that path — a duplicate submit produces a second complete dish. Nothing on the server prevents it today: `normalized_title` is deliberately not unique, and `input.jobId` is recorded into `ai_jobs.output_json` but never read back, so it is not an idempotency key. The defence is the S8.3 form's synchronous ref lock (task 4.2); turning `jobId` into a real idempotency key (read `output_json->>'consumedDishId'` under `FOR UPDATE`, return the dish it names) is the option task 4.3 has if the import path makes retries likely. Duplicate dishes break no invariant, which is why this is a recorded gap rather than a bug — but do not read the unique index as covering it.

**`normalized_title` is indexed but deliberately NOT unique** — the asymmetry with `products.normalized_name` is the point. A duplicate *product* is the bug the catalog exists to prevent; a second «Оладьи» (mum's and the other one) is a library decision the household is allowed to make. The column exists for lookup (task 6.1's assistant resolving «сделай нам лазанью»), not for a constraint. `normalizeDishTitle` (`src/server/dishes/normalize.ts`) is an **alias** of `normalizeProductName`, not a copy: two normalizations that drift apart are worse than one that is imperfect.

### Archive, never delete

`dishes.archived_at` plus `dish.archive` / `dish.unarchive`, and **no `dish.delete` at all**. Phase 5.1's `menu_items.dish_id` and 5.3's «повторить неделю» must not lose the dish a stored week names; a hard delete would either cascade that history away or start throwing 23503 at the user. `dish.list` filters `archived_at IS NULL`, `dish.listArchived` the opposite; the archive is reachable from S7's «…» menu (confirmation sheet, then a banner on the same screen with «Вернуть») and from Settings → «Архив блюд».

Both endpoints take `expectedVersion` and guard on the archive state they expect to find, so a second «В архив» on an already-archived dish matches nothing rather than bumping the version again. When the write matches nothing, one extra scoped read tells `NOT_FOUND` («блюда больше нет») apart from `CONFLICT` («его изменили») — two answers a screen can act on differently.

### `product_id` is `ON DELETE RESTRICT` — task 7.1 must pre-check

`recipe_ingredients.product_id` is `restrict`, like `cart_items.product_id` and `pantry_items.product_id`. **Any future product-delete endpoint (task 7.1) must pre-check**

```sql
SELECT count(*) FROM recipe_ingredients WHERE product_id = $1 AND household_id = $2
```

and report «используется в N блюдах», or the delete fails with a raw 23503 the user cannot act on. `recipe_ingredients_productId_idx` exists for exactly that query, and for task 6.1's reverse lookup product → dishes.

`product_id` is also **nullable**, and that is a first-class state, not a gap: an ingredient nothing in the catalog answers to yet is stored unbound and renders as itself. Task 4.2 added the resolution step in front of the save transaction (reference catalog first, then one batched `enrichProducts` AI call, then savepointed product inserts) — see [Dish form](#dish-form-s83-task-42). The input schema carries `productId` per row and verifies every non-null one against the caller's own catalog before any write.

### The three ingredient states, and why they must look different

`qty` and `unit` are nullable, and that nullability *is* the honesty rule (VISION §6.4). All three states are in DESIGN_BRIEF §5's own sample recipe, and S7 renders each differently:

| stored                                        | S7                                                | meaning                            |
| --------------------------------------------- | ------------------------------------------------- | ---------------------------------- |
| `qty = null`, `needs_review = true`            | amber «уточнить» chip on `--null` / `--null-txt` | the parser failed — a human must look |
| `qty = null`, `is_optional = true`             | neutral grey «опционально» chip                   | the recipe said so                 |
| `qty = null`, `note = 'по вкусу'`              | plain text where the number would be, no chip     | a deliberate absence               |

If they looked alike the amber chip would stop meaning anything, which is the only reason it is worth having (DESIGN_BRIEF §6: «пометки „уточнить“ жёлтые, не красные»).

**`needs_review` is derived server-side and never carried.** `deriveNeedsReview` (`src/server/recipes/needs-review.ts`, pure, unit-tested against the exact NYC-Cookies list) is recomputed by `dish.create`/`dish.update` on every save, and the AI's structured output (task 4.3) has no such field at all — a model that forgets to flag cannot produce a silently confident recipe, and typing a quantity into S8.3 clears the chip without anything else having to remember to.

### Units are data, not copy

`recipe_ingredients.unit` stores one of `RECIPE_UNITS` as text and is re-validated on read, degrading to `null` for anything unrecognized — one row holding a retired measure must not fail a whole dish's output validation (the same rule `cart.ts`'s `FALLBACK_UNIT` encodes).

**`RECIPE_UNITS` is a superset of the cart canon, not a second canon.** `src/lib/units.ts` keeps `UNITS` (the nine purchase units) untouched and adds `RECIPE_ONLY_UNITS = ["ч.л.", "ст.л.", "стакан", "щепотка"]` beside it. Widening `UNITS` itself would put «щепотка» into `QtyStepper`'s cart unit picker and let `decideCartAdd` merge a teaspoon into a kilogram. The bridge is `isPurchaseUnit(unit)`, phase 5.2's gate for turning an ingredient into a cart line.

**A unit is a stored value rendered verbatim — it never enters `src/messages/ru.json`**, exactly as the cart already renders `UNITS`. Same for `recipes.yield_unit` («печений»): it is the source's own noun, imported data like `raw_text`, passed *into* an ICU message (`dish.portionsUnit`) as a parameter so the words around it still come from next-intl. What is *not* data: «7–8 порций» and «9–11 мин» are composed on the client from two integers each (`portions_min`/`portions_base`, `timer_sec`/`timer_max_sec`) — a stored Russian label would be a user-visible string living outside next-intl.

`portions_base` is the **upper** end of a stated range («7–8 печений» → 8) and is the number every ingredient quantity is stated for; `portions_min` (7) is display only. Rescaling divides by `portions_base` (`rescaleQty`, `src/lib/recipes/rescale.ts`) and rounds with the cart's own `roundQty`, so phase 5.2 can sum a rescaled quantity straight into a cart row without a second rounding rule. `formatRecipeQty` renders «285 г», «¾ ч.л.», «1½» — and **never «0»**: a value that rounds below the storage floor renders «—», because «0 г» would claim the recipe asks for none of something.

### `dish` router

| Procedure           | Boundary             | Notes                                                                                                         |
| ------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `dish.list`         | `householdProcedure` | No input. `archived_at IS NULL`, `INNER JOIN recipes`, ingredient/needs-review counts aggregated in one grouped read, `ORDER BY created_at DESC, id DESC` |
| `dish.listArchived` | `householdProcedure` | The opposite predicate, newest archive first — backs Settings → «Архив блюд»                                  |
| `dish.get`          | `householdProcedure` | `{ id }` → the whole aggregate in three scoped selects; `NOT_FOUND` before any second query runs               |
| `dish.create`       | `householdProcedure` | `{ draft, originalDraft, jobId }` → `saveDishOutput` (`{ dish, createdProducts, aiFailed }`)                    |
| `dish.update`       | `householdProcedure` | `{ id, expectedVersion, draft }` → the same `saveDishOutput`; `CONFLICT` on a stale token, raised before any AI spend |
| `dish.archive`      | `householdProcedure` | `{ id, expectedVersion }` → `{ id, version }`                                                                  |
| `dish.unarchive`    | `householdProcedure` | The undo, and Settings' «Вернуть»                                                                              |

**`inPantry` («· дома есть ✓») is a `LEFT JOIN pantry_items` inside `dish.get`, scoped by household on the join condition itself.** `pantry_items` is unique on `product_id`, so the join cannot fan out, and a client cross-reference against the `pantry.list` cache would be a second cache entry that can disagree with the ✓ on screen. An unbound ingredient matches nothing and reads as `false`.

**`saveDishOutput.createdProducts` / `aiFailed`** report what the save did to the catalog: which products it minted for unbound rows, and whether any of them carry fallback values because the enrichment was refused or failed. Task 4.1 always answered `[]` / `false`; 4.2 fills them, and both `create` and `update` return the same shape.

### The save path (and how 4.2+ extends it)

`dish.create` and `dish.update` run in this order, and the order is the design:

1. **Outside any transaction** — normalize the draft (`normalizeDraftForSave`), enforce `ingredients.min(1)` (deliberately *not* in `recipeDraftSchema`: a parse that found steps but no ingredient list must still reach the review form), and verify every client-sent `productId` against this household's catalog in one scoped `SELECT` with a set-size check.
2. **Task 4.2's resolution step runs here, still outside the transaction** — reference catalog first (free), then one batched `enrichProducts` call for what is left, and (on `update`) a version pre-check before either. A 15–40 s OpenAI round trip inside an open transaction would pin a pooled Railway connection and row locks on a Vercel function. Details in [Dish form](#dish-form-s83-task-42).
3. **Inside one transaction** — (update only) `SELECT version … FOR UPDATE` scoped by household → `NOT_FOUND` / `CONFLICT`; write `dishes` (`version = version + 1`, `updated_at = now()`, `normalized_title` derived here) and `recipes`; `DELETE` both child tables by `recipe_id AND household_id`; bulk `INSERT` them again with freshly minted `0..n-1` orders. **Full replace, not diff** — nothing holds a `recipe_ingredients.id` durably, so churning child ids costs nothing and buys a save path with no reorder-or-merge logic to get wrong.
4. **After the commit** — the aggregate is re-read and returned. Outside the transaction on purpose: it carries its own `version`, so reading a state a partner has already moved on from is not a lie, while holding the write's locks through three more round trips would be a real cost.

`recipes.original_draft` is written **only on create, only from an import** — it is the base task 4.6 diffs its adaptation against and reverts to, and an edit is exactly the thing a revert has to be able to go past. When `jobId` is set, the import job is marked consumed with `jsonb_set(coalesce(output_json, '{}'::jsonb), '{consumedDishId}', …)` scoped by household, so `/dishes/import/[jobId]` can redirect to the saved dish instead of re-rendering a draft the household already turned into a recipe. `coalesce` matters: `jsonb_set` on NULL returns NULL, which would erase the ledger entry rather than annotate it.

**No `lockHousehold()` on the dish path, and the router says so in a doc comment.** That advisory lock exists for exactly one reason: `trip.close` walks cart → pantry while `pantry.ranOut` walks pantry → cart, and two at once is a lock-order cycle Postgres resolves by aborting one with 40P01. A dish save touches neither table, so there is no cycle to break, and taking the lock would serialize every «Сохранить блюдо» behind every shopping action.

### `RecipeDraft` — one contract, six producers, one consumer

`src/lib/recipes/draft.ts` holds `recipeDraftSchema` and its helpers (`emptyDraft`, `draftFromDetail`, `normalizeDraftForSave`). It is the single shape every producer feeds — vision parsing, JSON-LD, microdata, FireCrawl + AI, pasted text, the manual form, AI adaptation — and the one shape S8.3 consumes, whether it is creating, reviewing an import or editing.

Client-safe by construction: it imports `zod`, the unit canon and two pure server modules that hold no database. **`src/db/schema.ts` takes `DISH_SOURCE_TYPES` from `draft.ts`, not the other way round** — the same pattern `src/lib/units.ts` sets, so an output schema never drags the schema module into a browser bundle. `.nullable()` everywhere, never `.optional()`: a draft with a missing key and a draft with an explicit `null` would be two shapes for one thing.

`photoUrl` and `sourceUrl` are constrained to `http`/`https` explicitly. zod 4's `z.url()` accepts **any** scheme `new URL()` parses, `javascript:` and `data:` included — and an imported `photoUrl` ends up in an `<img src>`.

### Screens

| Route              | What it is                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `/dishes`          | S6 library — search, tag chips, two-column `DishCard` grid, skeleton tiles, empty state, «+ Блюдо» source sheet            |
| `/dishes/[dishId]` | S7 card (read-only in 4.1) — photo, tags, source line, portions, ingredients, steps, actions, «…» → «В архив»              |
| `/dishes/new`      | S8.3 with an empty draft — «✍️ Вручную» from the «+ Блюдо» sheet and from the empty state (task 4.2)                        |
| `/dishes/[dishId]/edit` | S8.3 seeded from `dish.get` — S7's «Редактировать» (task 4.2)                                                        |
| `/settings`        | gains an «Архив блюд» block reading `dish.listArchived`, one «Вернуть» per row                                             |

**Search and tag filtering never leave the browser.** `dish.list` takes no input and returns the whole library, so one cache entry serves S6: every keystroke re-filters an array (`filterDishes` / `collectTags`, pure and tested), with no debounce and no request per character — and the library keeps working with a dead connection. Documented threshold for revisiting: ~200 dishes, at which point those functions become the pure half of a `dish.search` endpoint mirroring `product.search`. «все» is a UI state (`tag: null`), never a stored tag.

**`cartSyncQueryOptions` is deliberately not applied here.** That preset's polling and focus-refetch exist because two people race over one shopping list at the shelf; a recipe library is not that, and a 45-second poll would burn requests for nobody. The default `staleTime` applies and the writes invalidate what they change.

**Photos are plain `<img decoding="async" referrerPolicy="no-referrer">` with an emoji placeholder on missing/error, not `next/image`.** Dish photos come from UploadThing and from arbitrary imported pages, so `next/image` would need a `remotePatterns` entry per host we have never seen and would spend Vercel's image-optimization quota on a picture the client already compressed to ~300 KB. S6's grid tiles add `loading="lazy"` — most of them are below the fold; S7's single photo is the first thing on the screen and stays eager on purpose.

**Dish writes fail fast offline; they are never queued.** `dish.archive` and `dish.unarchive` declare `networkMode: "always"`, and the IndexedDB offline queue persists `cart.*` only (see [Offline queue](#offline-queue-task-24)). With the default `"online"` mode a mutation dispatched offline *pauses* before its `mutationFn` runs — its `onSettled` never fires, so a synchronous "in flight" mutex is never released and the confirm button reads «Убираем…» for the whole outage, while the write itself is memory-only and dies with the tab. Failing immediately, plus a «нет сети» line rendered next to the control, is the honest behaviour for a write nobody is replaying later. `dish.create` and `dish.update` follow the same rule from 4.2, and the import mutations will in 4.3–4.4: an import costs money and a create is not idempotent, so replaying either from IndexedDB hours later is exactly wrong.

**A `CONFLICT` refreshes the screen instead of asking for a retry.** `expectedVersion` is read from the cache, so re-sending it after a partner's write lands would fail identically forever. Both S7 and S12's archive list invalidate on `CONFLICT`, close the confirmation, and say «Блюдо изменили — обновили карточку» — after which the refreshed banner (or the row's absence) usually means there is nothing left to retry.

**Focus is moved deliberately wherever a write unmounts the element holding it.** Three places in this feature: the S7 «…» sheet swapping its menu for the confirmation (the activated row unmounts while `BottomSheet` stays mounted, so its own one-shot focus effect cannot re-run — the confirmation focuses «Отмена», never the destructive «Убрать»); S7's «Вернуть» unmounting its own banner, on success **and** on the `CONFLICT` whose refresh reveals a partner already restored the dish; and S12's «Вернуть» unmounting its row, which picks the neighbour with `pickNextFocusTarget` while the row is still mounted and falls back to the section heading when the list empties. All are guarded on `document.activeElement` being `body`, so they rescue and never steal. S12's pending rescues are keyed by dish id and consumed only once that dish has actually left the list — the list carries `Date`s, so structural sharing never keeps its identity and any incidental refetch would otherwise spend a token armed for a removal that has not happened yet.

**The message a screen renders is chosen in a pure module, not in the component.** `ingredientsForMessage` (`src/lib/recipes/portions.ts`) and `timerMessage` (`src/lib/recipes/timer.ts`) return `{ key, values }`, and the screen does nothing but `t(message.key, message.values)`. vitest runs in `node` with no DOM harness, so a branch left inside a `.tsx` is unreachable from the suite: both of the bugs this shape prevents — the ranged yield losing its noun, a 30-second step reading «30 мин» — shipped green while the ternary lived in the component. `src/messages/ru.test.ts` renders through the same functions and sweeps the `dish.*` / `settings.dishArchive*` keys for existence, because next-intl returns the key path instead of throwing when an entry is missing.

**Controls whose feature has not shipped are `aria-disabled` and announce «скоро», never `disabled`.** In 4.1 that was the four source-sheet rows, S6's empty-state «📷 С фото», and S7's «В меню недели» / «Ингредиенты в корзину» / «Готовить» / «Редактировать»; task 4.2 turned «✍️ Вручную» and «Редактировать» into real links and gave the empty state a working «✍️ Заполнить вручную» beside the still-pending photo button. `main` deploys to production on every merge, so a button linking to a route that does not exist yet would be worse than one that is honest — and a truly `disabled` control cannot be focused, so a keyboard user would never learn the option exists. The hint renders inside the same container (inside the sheet's `aria-modal` subtree when a sheet is open), because a page-level toast is both hidden behind the scrim and pruned from the accessibility tree.

### Dish form (S8.3, task 4.2)

`src/components/dish-form.tsx` is **one** component for three jobs: creating a dish by hand (`/dishes/new`), editing a saved one (`/dishes/[dishId]/edit`) and — from task 4.3 — reviewing an import. `DishFormTarget` is a discriminated union (`{ mode: "create", originalDraft?, jobId? }` / `{ mode: "edit", dishId, version }`), and **no field branches on it**: the mode picks the mutation, the version guard and one caption. Anything else would be three forms that drift.

#### The save path, in order

`dish.create` and `dish.update` now run:

1. **Outside any transaction** — normalize the draft, enforce `ingredients.min(1)`, (update only) read `dishes.version` scoped by household and fail fast with `NOT_FOUND`/`CONFLICT`, then verify every client-sent `productId` against this household's catalog with a set-size check.
2. **Still outside any transaction** — resolve the rows that carry no `productId` (`resolveIngredientProducts`): deduplicate by normalized name, then `matchIngredients` (the household's own catalog, then the built-in reference list — both free and deterministic), then **one** batched `enrichProducts` call for whatever is left.
3. **Inside the transaction** — (update) `SELECT version … FOR UPDATE`; then the new products, **each inside `tx.transaction(...)`, i.e. a savepoint**; then the 4.1 write path unchanged (dish, recipe, delete + re-insert both child tables).
4. **After the commit** — re-read and return `{ dish, createdProducts, aiFailed }`. `dish.update` returns the same shape as `dish.create` (`saveDishOutput`): the form asks the same question either way.

**Why the AI call is outside the transaction.** A 15–40 s OpenAI round trip inside an open transaction pins a pooled Railway connection and its row locks for the whole call, on a Vercel function with a hard duration ceiling. `dish.test.ts` asserts `txDepth === 0` at the `ai_jobs` insert that fronts the call, and `txDepth === 2` on the product inserts.

**Why the version pre-check exists on top of the `FOR UPDATE` read.** The lock inside the transaction is still the real guard, but by the time it runs the save may already have spent an AI call and minted products for a write that can never land. Reading the version first costs one round trip and refuses a stale editor before any of that. Between the two reads a partner's write turns into the same `CONFLICT`, one round trip later.

**Why the savepoint.** In Postgres a 23505 aborts the *entire* enclosing transaction: without the savepoint, a concurrent insert of the same product would leave the dish, the recipe and both child tables failing with 25P02, and the recovery read would never reach the winner's row. Same lesson `cart.ts`'s `insertActiveItem` encodes. A recovered row is bound but **not** counted in `createdProducts` — «Создано N новых продуктов» counts what actually appeared in the catalog.

**A failed or rate-limited enrichment never fails the save.** `aiRateLimitDecision` (`src/server/ai/rate-limit-guard.ts`) returns a decision instead of throwing, and `enrichProducts` never throws at all; the products are created with the same fallbacks `product.create` uses (🛒 / «Бакалея» / шт) and `aiFailed: true` comes back so the form says «проверь новые продукты». Someone who has just spent a minute reviewing a recipe should not lose it to a quota over a fraction of a cent. The paying form of the guard (`assertWithinRateLimit`) is what `product.create` still uses — one AI call the user can simply ask for again.

**Exactly one `ai_jobs` row per save, or none.** One batched call for up to `MAX_ENRICH_NAMES` (20) names, `reasoning_effort: "low"`, per-name validation (an unknown `categoryId` or a non-emoji icon costs *that* name its icon, not the other nine theirs), and `costUsd` recorded on the failure branch too. Ten sequential enrichments would burn the function's duration budget and ten rate-limit slots on one tap of «Сохранить блюдо». Zero rows when every ingredient is bound or resolves from the reference catalog — the tests prove it with `unusableOpenai`, which throws if anything reaches for a client.

**Rows that can never be products are skipped entirely.** `isUsableProductName` requires a letter or a digit after normalization, so «—» or «(см. шаг 3)» is neither enriched nor created; the row is saved unbound, which is the honest «новый» state the nullable `product_id` column already has.

#### Ingredient matching: which tiers may bind

`src/server/catalog/search.ts` gained two additive exports; `searchCatalog`'s behaviour is unchanged (both now share one private ranker).

- `INGREDIENT_MATCH_TIERS` / `acceptsIngredientTier(rank)` — exact, prefix and word-prefix, on names **and** aliases (tiers 0, 1, 2 and the same three shifted by the alias offset). **A bare substring is refused** (tiers 3 and 7): «масло» is a substring of «Масло сливочное» *and* «Масло подсолнечное», and a silent wrong bind is invisible on S8.3 and buys the wrong thing when phase 5.2 turns the recipe into a shopping list. It is a **set, not a ceiling** — `rank <= 6` would admit tier 3, which is precisely the case being rejected.
- `bestCatalogMatch(args)` — the top hit and its tier, or `null`. **A tie at the top rank returns `null`**: «масло» reaches the prefix tier against three different fats at once, and "best" is not defined there. `matchIngredients` then leaves the row unbound and a human chooses.

`matchIngredients` tries the household's own catalog by exact name/alias first (a curated row wins even against a tie), then `bestCatalogMatch` through the allow-set, then `findReferenceProduct`. It answers **1:1 with the input order** — the caller pairs results back to draft rows by index.

#### The «новый» contract

`AutocompleteSheet` gained an additive `variant?: "quantity" | "product"` (default `"quantity"`; the cart call site is untouched) plus `onPickUnbound` and a `title` override.

In `"product"` mode the sheet **writes nothing**. Picking a catalog row fires `onAdded` immediately with `qty: 1` and the product's default unit — there is no quantity step, because the ingredient row already has its own numbers. Picking a reference entry, or the «Создать „…“» row, fires `onPickUnbound(name)` instead: no `product.create`, no AI call, no `ai_jobs` row. The row wears the neutral «новый» chip and the **save** creates the product (DESIGN_BRIEF S8.3: «новые продукты помечены „новый“ — при сохранении будут созданы в каталоге»). Creating them on tap would mint catalog rows for recipes people abandon, and spend an AI call each time.

#### Form state rules

Each one is a bug this codebase already shipped once (see [Recurring bug classes](#offline-queue-task-24) and the phase 2–3 reviews):

- **Seeded exactly once**, in `useState` initializers. `dish.get`'s payload carries `Date`s through superjson, so TanStack's structural sharing never keeps its identity and an effect copying `initial` into state would wipe a half-typed recipe on the first background refetch. The form is also **never given a `key` derived from a live version** — the edit screen hands the newest aggregate down as `latest`, the form raises «Блюдо изменили», and the server's data replaces what is on screen only when the user taps «Обновить» (`adopt`).
- **`savingRef` is a synchronous mutex.** `dish.create` mints a fresh id every call and has no unique index to catch a duplicate, so two taps in one tick would produce two dishes; `isPending` lands a render too late.
- **Pending controls are `aria-disabled`, never `disabled`** — `disabled` drops focus off the button that was just activated.
- **Deleting a row rescues focus**: `pickNextFocusTarget` picks the neighbour while the row is still mounted, and the effect focuses that row's own delete button, guarded on `document.activeElement === body` so it rescues and never steals.
- **Feedback renders inside the form** (and inside the sheet's `aria-modal` subtree when a sheet is open): a page-level toast is both hidden behind the scrim and pruned from the accessibility tree.
- **Both mutations declare `networkMode: "always"`** and are deliberately **not** in the offline queue (which persists `cart.*` only). A paused mutation's `onSettled` never fires, so the mutex would stay held and the button would read «Сохраняем…» for the whole outage — for a write that dies with the tab. `dish.create` is not idempotent either, so replaying it from IndexedDB hours later would be exactly wrong.
- **Step reorder is a pointer drag *and* «Выше»/«Ниже»**, both ending in the same pure `moveItem` (`src/lib/recipes/reorder.ts`). HTML5 drag and drop does not work on iOS, and a drag is unusable with a keyboard. The gesture filters non-primary pointers, uses `setPointerCapture`, cancels on `pointercancel`/`lostpointercapture`, and clears drag state **before** committing so a re-render cannot resurrect a finished gesture. `stepDropIndex` (pure, tested) is the only geometry.
- **The text ⟷ number edges live in `src/lib/recipes/form-fields.ts`**, not in the component: vitest runs in `node` with no DOM harness, so a branch left in a `.tsx` is unreachable from the suite. An out-of-range quantity becomes `null` rather than being clamped — a silently corrected amount is worse than an honestly missing one, and the amber chip is what says so.

#### After a save

The form does **not** navigate on its own: it replaces itself with a «Блюдо сохранено» panel that names how many products were created (and says «проверь их в каталоге» when `aiFailed`), with «Открыть блюдо» taking focus. The blueprint called for a toast on S7, but S7 (`dish-screen.tsx`) is task 4.5's file in the same wave; a cross-file toast channel would have collided, and a panel where the user already is beats a toast that a navigation immediately unmounts. Revisit when 4.5 lands.

#### What 4.2 deliberately did not build

Photo **upload** (task 4.3): the form renders a saved photo with «Удалить фото» (clearing `photoUrl` + `photoKey`) and exposes a `photoUploadSlot` prop for 4.3 to fill. `yieldUnit` is display-only — it is the source's own noun, imported data like `raw_text`, and nothing in a manual form should invent one.

### AI budget does not gate this

`AI_MONTHLY_BUDGET_USD` caps **the assistant only** (task 6.1). Recipe import (4.3/4.4), the batched product enrichment inside a save (4.2) and the recipe adaptation (4.6) keep working at the cap: every one of them is a thing the user started and is waiting on, and losing a reviewed recipe to a quota is the wrong trade. They are still rate-limited per user like every other AI endpoint, and every call still writes its `ai_jobs` row with `costUsd`.

### Migrations 0009 and 0010

`0009` creates `dish_source_type` and the four tables; `0010` contains exactly `ALTER TYPE "public"."ai_job_type" ADD VALUE 'adapt_recipe';`. Two files, and the value ships in task 4.1 though task 4.6 is the first to write it, because `migrate.yml` and the Vercel deploy of the same commit run **in parallel** — shipping the value several PRs early removes the window where the function could go live before the type knows the word. `adapt_recipe` is **appended**, never inserted, so drizzle-kit emits a plain `ADD VALUE` rather than an `ADD VALUE … BEFORE` or a type recreate; only the plain form is backward-compatible with code already running. The rule that follows: never write or select a new enum value in the migration batch that adds it.

### Seeding a demo library

```bash
pnpm db:seed --dishes
```

Inserts DESIGN_BRIEF §5's «NYC Cookies» (all three ingredient states, the 9–11 min timer) and «Шакшука» into the first household, binding ingredients to catalog products by `normalized_name` where one already exists and leaving the rest unbound — the honest state 4.1 ships. Idempotent by `normalized_title`, so a second run is a no-op. **It refuses to run unless `DATABASE_URL`'s hostname is loopback**, the same footgun `drizzle.config.ts` documents. Without the flag `pnpm db:seed` stays the no-op it has always been.

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

### Tenant isolation (settled decision, 2026-08-21)

**The model:** tenant isolation is enforced at the application boundary, not in the database schema. Every household-scoped table carries a plain `household_id` foreign key (single column, `ON DELETE CASCADE` from `households`) — there is no composite tenancy key, and none is planned.

**The enforcement pattern**, applied uniformly across `cart`, `category`, `kitchenProfile` and `product`:

- Every `SELECT`/`UPDATE`/`DELETE` on a household-scoped table carries `eq(<table>.householdId, ctx.household.id)` in its `WHERE` — even when the statement already filters by primary key. An `INSERT` has no `WHERE` to carry that in; the contract there is the values-side equivalent: `householdId` is always set from `ctx.household.id`, never taken from client input. `ctx.household.id` itself comes from `householdProcedure`'s own membership lookup (`src/server/api/trpc.ts`), never from client input, so none of this can be forged.
- A foreign id arriving from the client (a `productId` on `cart.add`, a `buyerId` on `cart.updateItem`, a `categoryId` on `product.update`) is verified to belong to the caller's household with its own scoped lookup before it reaches a lock or a write. The FK to the referenced table proves the id exists somewhere; it does not prove it exists in this household, so the app checks that itself. Each such check needs a test that feeds a wrong-household (or nonexistent) id and asserts the request fails _before_ any lock or write — e.g. `cart.test.ts`'s "refuses a product that is not in the caller's own catalog", which asserts `NOT_FOUND` and that nothing beyond the ownership check ran.
- Router tests compile the recorded `WHERE` clause of scoped selects/updates/deletes with `PgDialect` and assert it mentions `household_id` — the `expectScopedByHousehold` helper, duplicated per test file (see `src/server/api/routers/category.test.ts`, `product.test.ts`, `cart.test.ts`, `kitchen-profile.test.ts`). A refactor that drops the household half of a query's `WHERE` fails this assertion even though the stub's queued rows would otherwise still make the test pass on values alone. For an `INSERT`, the equivalent assertion is on the recorded statement's `values.householdId` directly (see `cart.add`'s "added" outcome).

**Why composite tenancy FKs were considered and declined.** CodeRabbit proposed, during PR #13 (task 2.1), adding `unique (household_id, id)` on every referenced table plus composite foreign keys such as `(household_id, product_id)` on the referencing side, so the database itself would refuse a cross-household link. The orchestrator declined it schema-wide rather than case by case:

1. An FK constraint only guards row _linking_ on a write. It cannot guard _reads_, which is where an actual tenant-isolation bug shows up — a forgotten `eq(table.householdId, ...)` on a `SELECT` leaks rows to the wrong household without tripping any constraint at all, composite or not. Per-request household scoping has to exist everywhere regardless of what the FKs look like, so it is the one enforced model; a composite key would duplicate a narrow slice of it (cross-household writes) rather than replace it.
2. That scoping is already systematic — see the enforcement pattern above — and is the layer that actually catches the bug class composite FKs target.
3. Composite keys would tax every future household-scoped table (phases 3–5 add `pantry_items`, `dishes`, `recipes`, `recipe_ingredients`, `week_menus`, `menu_items`): a redundant `unique (household_id, id)` index, migration ceremony, and subtle `ON DELETE` interactions with the household cascade (`RESTRICT` fires mid-cascade; `NO ACTION` defers to statement end) — a permanent cost for a bug class the app-level pattern and its tests already cover.
4. DB-level invariants remain the right tool where _concurrency_, not scoping, is the risk: one household per user, one active cart row per product, `normalizedName` uniqueness. The distinction that guides future tables: **business invariants that must survive a race live in the database; tenant isolation lives in the app boundary.**

**Rule for new tables:** a new household-scoped table gets a plain `household_id` FK and the same pattern above — scope every statement, verify any client-sent foreign id before a write, add `expectScopedByHousehold` coverage in its router test. Reach for a DB constraint only when two concurrent requests could otherwise both succeed into an inconsistent state; do not reach for one to guard tenancy.

This decision is specifically about composite tenancy FKs, the mechanism CodeRabbit proposed. Postgres row-level security (RLS) is a different DB-level mechanism that _can_ guard reads, unlike a FK — it was not part of what was proposed or declined here, and adopting it would be a separate, heavier call (session-scoped `SET LOCAL` wiring through the postgres.js pool, a policy per table, its own test strategy). Leaving RLS out of scope is a call about implementation complexity and operational cost, not about trust between households: a caller from another household is an untrusted tenant exactly like in any other multi-tenant system, and a missing scoping predicate can leak a cross-household read regardless of how well the two members inside one household get along. Cross-household isolation currently rests on the enforcement pattern above — application-level scoping — being correct, and on the tests that hold it to that; revisit RLS if that cost/benefit balance changes.

### Testing routers

`src/server/api/test-support.ts` holds the fixtures — it is imported by tests only, never by application code:

- `unusableDb` — a Proxy that throws on any property access, so a test can prove a procedure rejected _before_ it queried.
- `unusableOpenai` — the same idea for `ctx.openai()`. It is the default in both contexts below, so a test that unexpectedly reaches an AI call fails loudly instead of dialing a paid API.
- `createDbStub(results)` — a drizzle-shaped query-builder stub. Every clause returns the builder, and awaiting one shifts the next queued result off `results`; an `Error` in the queue is thrown instead, which is how a constraint violation is simulated. `stub.statements` records what the resolver ran, in order — `wheres`, `orderBys`, `groupBys`, join conditions (`joins`), the `fields` projection, an `onConflictDoUpdate` config and the raw SQL of a `db.execute()` (`query`), each of which can be compiled with `PgDialect` to assert on the real SQL and its parameters — plus `txDepth`, the transaction nesting a statement was issued at (`0` bare, `1` in a transaction, `2` in a savepoint). `txDepth` exists because some nesting is load-bearing rather than stylistic — see the cart's insert-inside-a-savepoint — and the stub has no database to reveal it any other way. The same goes for position: recording `execute` as an ordinary statement is what lets a test prove the advisory lock is the _first_ thing a transaction does.
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
