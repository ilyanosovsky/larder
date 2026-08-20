"use client";

import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useEffect, useId, useState } from "react";

import { isRateLimitedError } from "@/lib/trpc-errors";
import type {
  ProductOutput,
  ProductSearchHitOutput,
} from "@/server/api/routers/product";
import { normalizeProductName } from "@/server/catalog/normalize";
import { useTRPC } from "@/trpc/client";

import styles from "./autocomplete-sheet.module.css";
import { BottomSheet } from "./bottom-sheet";
import { ProductEditForm } from "./product-edit-form";

/**
 * Long enough that a fast typist makes one request instead of six, short
 * enough that the list still feels like it is keeping up.
 */
const DEBOUNCE_MS = 200;

type Phase =
  | { kind: "search" }
  /** The AI is picking an icon and a department — DESIGN_BRIEF's AiProgress. */
  | { kind: "creating" }
  | { kind: "created"; product: ProductOutput; aiFailed: boolean }
  | { kind: "editing"; product: ProductOutput; aiFailed: boolean };

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
 * The quantity stepper DESIGN_BRIEF S4 describes belongs to the cart and
 * lands with it in task 2.3; this sheet stops at the catalog.
 */
export function AutocompleteSheet({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  /** Fired for every product that ended up in the catalog, once each. */
  onAdded: (product: { name: string; icon: string }) => void;
}) {
  const t = useTranslations("autocomplete");
  const tCommon = useTranslations("common");
  const trpc = useTRPC();
  const inputId = useId();

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "search" });
  const [error, setError] = useState<string | null>(null);

  const create = useMutation(trpc.product.create.mutationOptions());

  // Every open starts from a blank sheet: a stale query and a stale "created"
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

  async function pick(hit: ProductSearchHitOutput) {
    setError(null);

    // A product the household already has needs no write at all — the cart
    // (task 2.3) will attach to this row.
    if (hit.source === "catalog") {
      onAdded({ name: hit.name, icon: hit.icon });
      onClose();
      return;
    }

    try {
      // Only the name goes over the wire: the server re-resolves the icon and
      // the department from the reference catalog itself.
      const result = await create.mutateAsync({
        source: "reference",
        name: hit.name,
      });
      onAdded({ name: result.product.name, icon: result.product.icon });
      onClose();
    } catch {
      setError(t("error"));
    }
  }

  async function createNew() {
    const name = query.trim();
    if (name.length === 0) {
      return;
    }

    setError(null);
    setPhase({ kind: "creating" });

    try {
      const result = await create.mutateAsync({ source: "new", name });
      onAdded({ name: result.product.name, icon: result.product.icon });
      setPhase({
        kind: "created",
        product: result.product,
        aiFailed: result.aiFailed,
      });
    } catch (caught) {
      setError(isRateLimitedError(caught) ? t("rateLimited") : t("error"));
      setPhase({ kind: "search" });
    }
  }

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={t("title")}
      closeLabel={tCommon("close")}
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

      {phase.kind === "created" ? (
        <div className={styles.created}>
          <p className={styles.createdTitle}>{t("createdTitle")}</p>

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

          <button
            type="button"
            className={styles.primaryButton}
            onClick={onClose}
          >
            {t("done")}
          </button>
        </div>
      ) : null}

      {phase.kind === "editing" ? (
        <ProductEditForm
          product={phase.product}
          onSaved={(saved) =>
            setPhase({ kind: "created", product: saved, aiFailed: false })
          }
          onCancel={() =>
            setPhase({
              kind: "created",
              product: phase.product,
              aiFailed: phase.aiFailed,
            })
          }
        />
      ) : null}
    </BottomSheet>
  );
}
