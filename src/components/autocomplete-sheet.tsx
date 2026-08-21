"use client";

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, type RefObject } from "react";

import { isRateLimitedError } from "@/lib/trpc-errors";
import type { Unit } from "@/lib/units";
import type { ProductSearchHitOutput } from "@/server/api/routers/product";
import { normalizeProductName } from "@/server/catalog/normalize";
import { useTRPC } from "@/trpc/client";

import styles from "./autocomplete-sheet.module.css";
import { BottomSheet } from "./bottom-sheet";
import { ProductEditForm, type EditableProduct } from "./product-edit-form";
import { QtyStepper } from "./qty-stepper";

/**
 * Long enough that a fast typist makes one request instead of six, short
 * enough that the list still feels like it is keeping up.
 */
const DEBOUNCE_MS = 200;

/**
 * What the sheet hands back once the shopper has settled on a product **and**
 * how much of it — everything `cart.add` needs, and nothing about the cart
 * itself. Filing it is the caller's business (S3 does it in `cart-screen.tsx`);
 * this sheet never touches the `cart` router, so the same flow can later feed
 * a recipe's ingredient list or the pantry.
 */
export interface ProductSelection {
  product: EditableProduct;
  qty: number;
  unit: Unit;
}

type Phase =
  | { kind: "search" }
  /** The AI is picking an icon and a department — DESIGN_BRIEF's AiProgress. */
  | { kind: "creating" }
  /** DESIGN_BRIEF S4's «степпер количества + единица», mockup #1g. */
  | {
      kind: "quantity";
      product: EditableProduct;
      /** Came from a `product.create` just now, rather than from the catalog. */
      created: boolean;
      aiFailed: boolean;
    }
  | {
      kind: "editing";
      product: EditableProduct;
      created: boolean;
      aiFailed: boolean;
    };

/**
 * S4 «Добавление продукта» (DESIGN_BRIEF §4).
 *
 * Type «пом», get «🍅 Помидоры» — instantly, free, whether or not the
 * household has ever bought tomatoes, because the built-in reference catalog
 * fills in behind their own. Suggestions from both halves look identical on
 * purpose: the distinction is the server's problem, not the shopper's.
 *
 * Only a name with no match at all reaches «Создать „…“», and only that path
 * spends an AI call. It shows a calm line of text while it waits — no sparks,
 * no gradients (DESIGN_BRIEF §7) — and hands back a product with an
 * «Изменить» affordance, because the picked icon is a suggestion and the
 * shopper is the authority.
 *
 * Every path then lands on the same quantity step, and **the sheet does not
 * close itself**: `onAdded` reports the selection and the caller decides what
 * happens next, because only the caller knows what `cart.add` answered. A
 * merge and a unit conflict are different screens (mockup #1h), and a line
 * already bought in the open trip is a question rather than an outcome.
 */
export function AutocompleteSheet({
  open,
  onClose,
  onAdded,
  restoreFocusTo,
}: {
  open: boolean;
  onClose: () => void;
  /**
   * Fired once per «В корзину» tap, and **exactly** once: the sheet awaits
   * the promise behind a synchronous ref lock, so neither a slow request nor
   * two taps in one tick can submit twice (see `busyRef`). Rejections are
   * caught and shown as the generic sheet error, but a caller is expected to
   * handle its own failures.
   */
  onAdded: (selection: ProductSelection) => void | Promise<void>;
  /** The control that opened the sheet — see `useSheetOpener()`. */
  restoreFocusTo?: RefObject<HTMLElement | null>;
}) {
  const t = useTranslations("autocomplete");
  const tCommon = useTranslations("common");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const inputId = useId();

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "search" });
  const [error, setError] = useState<string | null>(null);
  const [qty, setQty] = useState(1);
  const [unit, setUnit] = useState<Unit>("шт");
  const [submitting, setSubmitting] = useState(false);

  const create = useMutation(trpc.product.create.mutationOptions());

  // Every open starts from a blank sheet: a stale query and a stale quantity
  // panel from the previous product would both be wrong. The input itself
  // takes focus through `autoFocus` — the sheet unmounts when it closes, so
  // that fires on every open, including one that reopens onto a fresh search
  // state this effect has only just requested.
  useEffect(() => {
    if (open) {
      setQuery("");
      setDebouncedQuery("");
      setPhase({ kind: "search" });
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const trimmedQuery = debouncedQuery.trim();
  const searching = phase.kind === "search" && trimmedQuery.length > 0;

  const suggestions = useQuery(
    trpc.product.search.queryOptions(
      { query: trimmedQuery },
      {
        enabled: open && searching,
        // Keeps the previous list on screen while the next one loads, so the
        // sheet does not blink empty between keystrokes.
        placeholderData: keepPreviousData,
      },
    ),
  );

  const hits = suggestions.data ?? [];

  /**
   * The results on screen are a *successful* search for what is currently
   * typed — not a stale list, not a half-loaded one, and not an empty list
   * that is really a failed request.
   */
  const settled =
    trimmedQuery === query.trim() &&
    !suggestions.isFetching &&
    suggestions.isSuccess;

  // «Создать „…“» is offered only once the search has settled and nothing in
  // it already **is** what was typed. Every clause is load-bearing, because
  // this row is the one that spends money:
  //
  // - beside an exact match, it makes the duplicate this feature exists to
  //   prevent;
  // - while the list is still loading, it sits under the thumb of someone
  //   whose product the reference catalog was about to supply for free;
  // - after a *failed* search, "no hits" means "we don't know", not "it does
  //   not exist" — offering to create then funnels the user into a paid call
  //   for a product they may already own. That case shows the error below
  //   instead.
  const normalizedQuery = normalizeProductName(query);
  const offerCreate =
    normalizedQuery.length > 0 &&
    settled &&
    !hits.some((hit) => normalizeProductName(hit.name) === normalizedQuery);

  /**
   * The search could not answer, and the sheet has to say so.
   *
   * `isPaused` is not a nicety: with the default `networkMode: "online"`,
   * TanStack Query **pauses** a retry when it thinks the browser is offline
   * rather than failing it, so the query sits at `status: "pending"`
   * indefinitely and never reaches `isError`. Treating only `isError` as
   * failure leaves someone on a dropped connection staring at «Ищем…»
   * forever, with no explanation and no way forward — the same dead end this
   * whole guard exists to remove, just reached from the other side.
   */
  const searchFailed =
    (suggestions.isError || suggestions.isPaused) && normalizedQuery.length > 0;

  /**
   * A freshly created product is not in `product.search`'s cached answers yet,
   * and those answers stay fresh for `staleTime`. Without this, searching the
   * same word again inside that window would offer «Создать „…“» a second
   * time for a product that now exists — the duplicate this sheet is built to
   * prevent, arrived at from the other direction.
   *
   * `refetchType: "none"` because the sheet is on its way to the quantity
   * step, where the search is disabled: marking the answers stale is the
   * whole point, and refetching a list nobody is looking at would just spend
   * a request.
   */
  function staleCatalogQueries() {
    void queryClient.invalidateQueries({
      ...trpc.product.pathFilter(),
      refetchType: "none",
    });
  }

  function enterQuantity(
    product: EditableProduct,
    { created, aiFailed }: { created: boolean; aiFailed: boolean },
  ) {
    setError(null);
    setQty(1);
    setUnit(product.defaultUnit);
    setPhase({ kind: "quantity", product, created, aiFailed });
  }

  /**
   * The sheet does one thing at a time, and this is what enforces it.
   *
   * A **ref**, deliberately — not `create.isPending`, not `submitting`, not
   * `disabled` on the buttons. All three are render state: React applies a
   * `setState` (and a mutation's own status transition) *after* the handler
   * returns, so two taps landing in the same event-loop turn read the same
   * pre-tap value and both get through. `disabled` has the same problem from
   * the other side — it only reaches the DOM on the next render.
   *
   * The cost of losing that race is not a wasted request. On «Создать „…“»
   * it is two AI calls and two `ai_jobs` rows; on «В корзину» it is worse,
   * because `cart.add` **merges** into an existing line — two adds of «2 шт»
   * leave 4 in the cart, and nothing on screen says the second tap did
   * anything. A ref is written and read synchronously, so the second tap sees
   * the first one's lock.
   *
   * The state below stays for rendering only.
   */
  const busyRef = useRef(false);

  async function pick(hit: ProductSearchHitOutput) {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    try {
      setError(null);

      // A product the household already has needs no write at all — the
      // quantity step attaches to the row it already owns. The id is what
      // says so, rather than `source`: `productId === null` is the search
      // contract's own definition of "a reference entry, not created yet".
      if (hit.productId !== null) {
        enterQuantity(
          {
            id: hit.productId,
            name: hit.name,
            icon: hit.icon,
            categoryId: hit.categoryId,
            defaultUnit: hit.unit,
          },
          { created: false, aiFailed: false },
        );
        return;
      }

      // Only the name goes over the wire: the server re-resolves the icon and
      // the department from the reference catalog itself.
      const result = await create.mutateAsync({
        source: "reference",
        name: hit.name,
      });
      staleCatalogQueries();
      enterQuantity(result.product, {
        created: true,
        aiFailed: result.aiFailed,
      });
    } catch {
      setError(t("error"));
    } finally {
      busyRef.current = false;
    }
  }

  async function createNew() {
    const name = query.trim();
    if (name.length === 0 || busyRef.current) {
      return;
    }
    busyRef.current = true;

    setError(null);
    setPhase({ kind: "creating" });

    try {
      const result = await create.mutateAsync({ source: "new", name });
      staleCatalogQueries();
      enterQuantity(result.product, {
        created: true,
        aiFailed: result.aiFailed,
      });
    } catch (caught) {
      setError(isRateLimitedError(caught) ? t("rateLimited") : t("error"));
      setPhase({ kind: "search" });
    } finally {
      busyRef.current = false;
    }
  }

  async function submit(product: EditableProduct) {
    if (busyRef.current) {
      return;
    }
    busyRef.current = true;
    setSubmitting(true);
    try {
      await onAdded({ product, qty, unit });
    } catch {
      setError(t("error"));
    } finally {
      busyRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={t("title")}
      closeLabel={tCommon("close")}
      restoreFocusTo={restoreFocusTo}
    >
      {phase.kind === "search" ? (
        <>
          <label className={styles.label} htmlFor={inputId}>
            {t("searchLabel")}
          </label>
          <input
            id={inputId}
            className={styles.input}
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("searchPlaceholder")}
            maxLength={100}
            autoComplete="off"
            autoFocus
          />

          {error === null ? null : (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}

          <ul className={styles.results}>
            {hits.map((hit) => (
              <li key={`${hit.source}:${hit.productId ?? hit.name}`}>
                <button
                  type="button"
                  className={styles.result}
                  onClick={() => void pick(hit)}
                  disabled={create.isPending}
                >
                  <span className={styles.resultIcon} aria-hidden="true">
                    {hit.icon}
                  </span>
                  <span className={styles.resultName}>{hit.name}</span>
                  <span className={styles.resultMeta}>{hit.categoryName}</span>
                </button>
              </li>
            ))}

            {offerCreate ? (
              <li>
                <button
                  type="button"
                  className={styles.createRow}
                  onClick={() => void createNew()}
                  disabled={create.isPending}
                >
                  {t("create", { query: query.trim() })}
                </button>
              </li>
            ) : null}
          </ul>

          {searchFailed ? (
            // Says why the list is empty. Without it an empty sheet after a
            // failed request looks exactly like "nothing matches", and the
            // only thing left to do would be to create a product that may
            // well already exist.
            <p className={styles.warning} role="alert">
              {suggestions.isPaused ? t("searchOffline") : t("searchFailed")}
            </p>
          ) : null}

          {!settled &&
          !searchFailed &&
          normalizedQuery.length > 0 &&
          hits.length === 0 ? (
            <p className={styles.pending} role="status">
              {t("searching")}
            </p>
          ) : null}
        </>
      ) : null}

      {phase.kind === "creating" ? (
        <div className={styles.aiProgress} role="status">
          <span className={styles.aiPulse} aria-hidden="true" />
          <span>{t("aiProgress")}</span>
        </div>
      ) : null}

      {phase.kind === "quantity" ? (
        <div className={styles.created}>
          <p className={styles.createdTitle}>
            {phase.created ? t("createdTitle") : t("quantityTitle")}
          </p>

          <div className={styles.createdRow}>
            <span className={styles.resultIcon} aria-hidden="true">
              {phase.product.icon}
            </span>
            <span className={styles.resultName}>{phase.product.name}</span>
            <button
              type="button"
              className={styles.inlineButton}
              onClick={() =>
                setPhase({
                  kind: "editing",
                  product: phase.product,
                  created: phase.created,
                  aiFailed: phase.aiFailed,
                })
              }
            >
              {t("edit")}
            </button>
          </div>

          {phase.aiFailed ? (
            // Amber, not red (DESIGN_BRIEF §6): nothing failed for the
            // shopper — the product exists, it just needs a look.
            <p className={styles.warning} role="status">
              {t("aiFailed")}
            </p>
          ) : null}

          {error === null ? null : (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}

          <QtyStepper
            qty={qty}
            unit={unit}
            onQtyChange={setQty}
            onUnitChange={setUnit}
            decreaseAria={t("qtyDecreaseAria")}
            increaseAria={t("qtyIncreaseAria")}
            unitLabel={t("unitLabel")}
          />

          <button
            type="button"
            className={styles.primaryButton}
            onClick={() => void submit(phase.product)}
            disabled={submitting}
          >
            {submitting ? t("toCartPending") : t("toCart")}
          </button>
        </div>
      ) : null}

      {phase.kind === "editing" ? (
        <ProductEditForm
          product={phase.product}
          onSaved={(saved) => {
            staleCatalogQueries();
            // The quantity already dialled in survives — only the product
            // changed. The unit follows the product's new default, which is
            // usually the very thing the shopper came here to correct.
            setUnit(saved.defaultUnit);
            setPhase({
              kind: "quantity",
              product: saved,
              created: phase.created,
              // Whatever the AI got wrong has just been looked at by a human.
              aiFailed: false,
            });
          }}
          onCancel={() =>
            setPhase({
              kind: "quantity",
              product: phase.product,
              created: phase.created,
              aiFailed: phase.aiFailed,
            })
          }
        />
      ) : null}
    </BottomSheet>
  );
}
