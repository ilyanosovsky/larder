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

`shopping_trips` exists ahead of the endpoint that writes it (task 3.2) purely so `trip_id` has a foreign key target — the index is unexpressible without one. There is deliberately no "open trip" row: a trip is only ever created at the moment it is closed, and "the current trip" is simply the set of rows with `trip_id IS NULL`. An open-trip row would be a second source of truth for the same fact, and a household could then have zero or two of them.

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

| Procedure         | Boundary             | Notes                                                                          |
| ----------------- | -------------------- | ------------------------------------------------------------------------------ |
| `cart.list`       | `householdProcedure` | Active lines only, joined with product, department and both member names       |
| `cart.add`        | `householdProcedure` | `{ productId, qty, unit, note?, restore? }` → the five-way outcome union above |
| `cart.updateItem` | `householdProcedure` | Partial patch of qty/unit/note/buyerId/orderedVia; LWW                         |
| `cart.setStatus`  | `householdProcedure` | `{ id, status, orderedVia? }`; LWW                                             |
| `cart.remove`     | `householdProcedure` | Hard delete of the active line — **idempotent**                                |

`list` returns rows ordered by department `sortOrder` then product name, which is exactly the contract `groupProductsByCategory` (`src/lib/group-products.ts`) assumes — it cuts an already-ordered list into sections by walking it, so a different order would silently produce two sections for one department. `addedBy` and `buyerId` join `users` twice under aliases: «кто добавил» and «кто купил» are both on the row and are usually different people. `updatedAt` is on the wire for task 2.2, which highlights lines that changed between refetches.

`setStatus` gives each status the fields that only make sense in it, so a row can never describe two states at once: `bought` stamps the caller as buyer, `needed` clears both the buyer and the delivery service, `ordered` records `orderedVia` when the screen offers one.

**Every statement repeats `household_id` alongside the primary key**, and every mutation additionally requires `trip_id IS NULL` — an id from the client never reaches a write on its own (VISION §6.7), and a line carried off by a closed trip is purchase history rather than something the cart screen may edit. A client-sent `productId` is checked against the caller's own catalog before it reaches a write, and a `buyerId` against the household's members, for the same reason `product.update` checks a `categoryId`: the foreign key only proves the row exists, not that it belongs here.

`remove` is deliberately idempotent — no NOT_FOUND when nothing matched. The cart is shared, so both partners removing the same line is ordinary rather than an error, and the offline queue task 2.4 adds will replay mutations after a reconnect.

The UI on top of it is [Cart screen](#cart-screen-s3-task-23) below.

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

| File               | Exports                                     | What it decides                                            |
| ------------------ | ------------------------------------------- | ---------------------------------------------------------- |
| `sort-rows.ts`     | `sortBoughtLast`                            | Stable partition, bought last, `ordered` staying live      |
| `status-toggle.ts` | `toggledCartStatus`, `applyStatusToggle`    | What the checkbox means, and the optimistic cache patch    |
| `add-outcome.ts`   | `describeCartAddOutcome`, `CartAddToastKey` | `cart.add`'s five outcomes → toast / highlight / confirm   |
| `qty-step.ts`      | `clampQty`, `stepQty`, `canStepQty`, bounds | The S4 stepper's arithmetic, pinned to the router's bounds |

**The optimistic checkbox** is the first optimistic mutation in the repo and the pattern the rest should copy. `onMutate` awaits `queryClient.cancelQueries(cartFilter)` — without it a refetch already in flight resolves _after_ the patch and the checkbox visibly un-ticks itself — then snapshots, applies `applyStatusToggle`, and returns the snapshot as rollback context; `onError` restores it and toasts; `onSettled` invalidates. Two fields are deliberately **not** patched: `updatedAt` (the highlight diff keys off it, so writing it would flash a "your partner changed this" cue at you for your own tap) and `buyerId` (the server stamps the caller on `bought` and clears it on `needed`; guessing would render a «кто берёт» a failed request has to take back).

**Double-tap guards are refs, never render state.** Worth stating plainly, because the wrong version _looks_ correct: `mutation.isPending`, a `useState` flag and a `disabled` attribute are all applied by React **after** the handler returns, so two taps landing in the same event-loop turn read the same pre-tap value and both get through. Only a ref is written and read synchronously.

What losing that race costs differs per call site, which is why each one is locked:

- **The checkbox** — `pendingRef`, a `Set` keyed by row id. Per row, because ticking three things one after another is ordinary shopping and must never block. Two `setStatus` calls for one row race, and last-write-wins settles on whichever arrived second rather than on what the shopper last tapped.
- **«В корзину»** — `addBusyRef` in the screen, plus the sheet's own `busyRef`. `cart.add` **merges**, so two adds of «2 шт» leave 4 in the cart: stateful damage, with nothing on screen admitting the second tap did anything. Both entry points (S4 and the restore confirmation) route through `submitAdd`, so one lock covers both.
- **«Создать „…“»** — the sheet's `busyRef` again. Two AI calls and two `ai_jobs` rows; this one costs money.

`isPending` and `disabled` stay, but for **rendering only** — the pending label and the greyed-out button. They are feedback, not the guard. A `useState` mirror of `pendingRef` exists for exactly that reason.

**Add flow.** «+ Добавить» opens S4; S4 reports `{ product, qty, unit }` and the screen calls `cart.add`. `describeCartAddOutcome` maps the answer:

| Outcome        | Toast                                   | Highlight | Then                                             |
| -------------- | --------------------------------------- | --------- | ------------------------------------------------ |
| `added`        | «{icon} {name} — в корзине»             | the row   | close S4                                         |
| `merged`       | «…уже в корзине — количество обновлено» | the row   | close S4 (mockup #1h)                            |
| `unitMismatch` | «…в других единицах — измени вручную»   | the row   | close S4; no auto-edit — that is 2.5             |
| `boughtExists` | none                                    | the row   | confirmation sheet → re-add with `restore: true` |
| `restored`     | «{name} — снова в корзине»              | the row   | close S4                                         |

Every outcome highlights its row rather than leaving it to the refetch. For the three that wrote something the refetch would eventually notice anyway and this just beats the round trip; for `unitMismatch` and `boughtExists` it is the only way, because nothing was written, `updatedAt` did not move and `diffListSnapshot` has nothing to see. `boughtExists` carries no toast on purpose: a question and an announcement competing for the same corner is how the question gets missed. The confirmation is a **separate** `BottomSheet` that opens as S4 closes rather than a second modal stacked on it — focus, Esc and the body scroll lock all stay owned by exactly one sheet.

**The header** (`app-header.tsx`) shows the participants' avatars — partners first, the caller's own last so the one that is also a 44px link into Settings is never partly covered — and DESIGN_BRIEF's «тихая иконка-часики» while `useIsFetching(trpc.cart.pathFilter())` or `useIsMutating({ mutationKey: trpc.cart.pathKey() })` is non-zero. Both are router-level key helpers and TanStack matches keys by prefix, so one filter each covers `cart.list`'s refetches and every `cart.*` mutation, including the ones 2.4/2.5 add. Idle shows nothing at all; the third state the brief describes (offline) is a banner and arrives with the offline queue. Members come from the `household.current` the `(app)` layout already loads for its gate, passed down as props — no second query.

**Deferred, and why the screen looks incomplete without it:** the «Корзина | Кладовая» segment control (3.1, replaces the toolbar's title/count pair), «Завершить закупку» (3.2, joins «+ Добавить» in the action bar), the offline banner and per-row 🕐 marks (2.4), and the «Заказано» badge, «кто берёт» avatar, note editing and «Заказ получен» (2.5). An existing note **is** rendered inline («· на выходных») because `cart.list` already carries it; nothing on this screen can set one. An `ordered` row renders with an unticked box, and ticking it sets `bought` — which is the safe direction under last-write-wins whichever way the line got there.

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
- `createDbStub(results)` — a drizzle-shaped query-builder stub. Every clause returns the builder, and awaiting one shifts the next queued result off `results`; an `Error` in the queue is thrown instead, which is how a constraint violation is simulated. `stub.statements` records what the resolver ran, in order — including `wheres`, `orderBys` and the `fields` projection, each of which can be compiled with `PgDialect` to assert on the real SQL and its parameters, plus `txDepth`, the transaction nesting a statement was issued at (`0` bare, `1` in a transaction, `2` in a savepoint). `txDepth` exists because some nesting is load-bearing rather than stylistic — see the cart's insert-inside-a-savepoint — and the stub has no database to reveal it any other way.
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
