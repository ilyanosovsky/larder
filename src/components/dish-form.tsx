"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { cx } from "@/lib/cx";
import { pickNextFocusTarget } from "@/lib/pantry/next-focus-target";
import {
  normalizeDraftForSave,
  recipeDraftSchema,
  type DraftIngredient,
  type DraftStep,
  type RecipeDraft,
} from "@/lib/recipes/draft";
import { parseMinutesInput, tagAddOutcome } from "@/lib/recipes/form-fields";
import { parsePortions } from "@/lib/recipes/portions";
import { moveItem, stepDropIndex } from "@/lib/recipes/reorder";
import { MAX_TAG_LENGTH, MAX_TAGS, normalizeTags } from "@/lib/recipes/tags";
import { useIsOnline } from "@/lib/sync/use-is-online";
import { isConflictError } from "@/lib/trpc-errors";
import {
  EQUIPMENT_PRESETS,
  type EquipmentSlug,
} from "@/server/kitchen/equipment";
import { useTRPC } from "@/trpc/client";

import { AutocompleteSheet } from "./autocomplete-sheet";
import styles from "./dish-form.module.css";
import { IngredientEditRow, type BoundProduct } from "./ingredient-edit-row";
import { StepEditRow } from "./step-edit-row";
import { useSheetOpener } from "./use-sheet-opener";

/** 100 hours — `recipeDraftSchema`'s own ceiling for the total time. */
const MAX_TOTAL_TIME_MIN = 6000;

/**
 * Which save this form is: a brand-new dish (manual, or the review step of an
 * import in task 4.3) or an edit of one that exists.
 *
 * A discriminated union rather than a `mode` string plus optional fields, so
 * "edit without a version" and "create with a dish id" are simply not
 * expressible. **No field of the form branches on it** — the difference is the
 * mutation, the version guard and one caption, which is what lets S8.3 be one
 * component instead of three that drift.
 */
export type DishFormTarget =
  | {
      readonly mode: "create";
      /** An import stores what it parsed, verbatim, for task 4.6 to revert to. */
      readonly originalDraft?: RecipeDraft | null;
      /** The import job this save came from, so it can be marked consumed. */
      readonly jobId?: string | null;
    }
  | {
      readonly mode: "edit";
      readonly dishId: string;
      readonly version: number;
    };

interface KeyedRow<TValue> {
  /** React's list key. Never crosses the wire — an index key breaks reorder. */
  readonly key: string;
  readonly value: TValue;
}

/**
 * S8.3 «Проверь результат» (DESIGN_BRIEF S8.3) — **one** form for creating a
 * dish by hand, for reviewing an import and for editing a saved dish.
 *
 * The state rules are the interesting part, and each one is a bug this
 * codebase already shipped once:
 *
 * 1. **The form is seeded exactly once**, in `useState` initializers. The
 *    server object arrives through superjson, so its `Date`s are new objects
 *    on every fetch and TanStack's structural sharing never keeps its
 *    identity — an effect that copied `initial` into state would fire on the
 *    first background refetch and wipe a half-typed recipe. Nothing re-seeds
 *    except an explicit tap on the «Блюдо изменили» banner (`adopt`), and the
 *    component is never given a `key` derived from a live version either.
 * 2. **`savingRef` is a synchronous mutex.** `dish.create` mints a fresh id
 *    every call and has no unique index to catch a duplicate, so two taps in
 *    one tick would produce two dishes. `isPending` lands a render too late.
 * 3. **Pending controls are `aria-disabled`, never `disabled`** — `disabled`
 *    drops focus off the button that was just activated.
 * 4. **Deleting a row moves focus to its neighbour**, chosen with
 *    `pickNextFocusTarget` while the row is still mounted; without it focus
 *    lands on `<body>` and the next Tab starts from the top of the page.
 * 5. **Every message renders inside the form** (and inside the sheet's own
 *    `aria-modal` subtree when a sheet is open): a page-level toast is hidden
 *    behind the scrim and pruned from the accessibility tree.
 * 6. **The save is never queued offline** (`networkMode: "always"`). The
 *    IndexedDB queue persists `cart.*` only, and a paused mutation's
 *    `onSettled` never fires — the mutex would stay held and the button would
 *    read «Сохраняем…» for the whole outage, for a write that dies with the
 *    tab. `dish.create` is not idempotent, so replaying it hours later would
 *    be wrong anyway.
 */
export function DishForm({
  initial,
  target,
  latest,
  productLabels,
  photoUploadSlot,
}: {
  initial: RecipeDraft;
  target: DishFormTarget;
  /**
   * The newest server aggregate, when the screen is watching one. Used only
   * to raise the «Блюдо изменили — обновить?» banner: the form never adopts
   * it on its own. `productLabels` travels with it so an adopted row shows
   * the product it is bound to rather than a bare fallback.
   */
  latest?: {
    draft: RecipeDraft;
    version: number;
    productLabels?: Readonly<Record<string, BoundProduct>>;
  } | null;
  /** Names and icons for the products the rows are already bound to. */
  productLabels?: Readonly<Record<string, BoundProduct>>;
  /**
   * The photo picker, as a render prop rather than a node (task 4.3).
   *
   * The uploader lives outside this component — it owns compression,
   * `useUploadThing` and its own errors — but the photo it produces belongs
   * to the form's state, so the two have to talk. A plain `ReactNode` could
   * only be *displayed*; a function that receives `onPicked` can hand the
   * result back without the caller having to mirror the form's state.
   */
  photoUploadSlot?: (api: {
    current: { url: string | null; key: string | null };
    onPicked: (photo: { url: string; key: string }) => void;
  }) => ReactNode;
}) {
  const t = useTranslations("dishForm");
  const equipmentLabels = useTranslations("kitchenProfile.equipment");
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const fieldId = useId();
  const online = useIsOnline();
  const sheetOpener = useSheetOpener();

  const [title, setTitle] = useState(() => initial.title);
  const [portionsText, setPortionsText] = useState(() =>
    portionsToText(initial),
  );
  const [totalTimeText, setTotalTimeText] = useState(() =>
    initial.totalTimeMin === null ? "" : String(initial.totalTimeMin),
  );
  const [equipment, setEquipment] = useState<EquipmentSlug[]>(() => [
    ...initial.equipment,
  ]);
  const [tags, setTags] = useState<string[]>(() => [...initial.tags]);
  const [tagDraft, setTagDraft] = useState("");
  const [photo, setPhoto] = useState(() => ({
    url: initial.photoUrl,
    key: initial.photoKey,
  }));
  const [ingredients, setIngredients] = useState<KeyedRow<DraftIngredient>[]>(
    () => keyRows(initial.ingredients),
  );
  const [steps, setSteps] = useState<KeyedRow<DraftStep>[]>(() =>
    keyRows(initial.steps),
  );
  const [expectedVersion, setExpectedVersion] = useState(() =>
    target.mode === "edit" ? target.version : 0,
  );
  const [labels, setLabels] = useState<Record<string, BoundProduct>>(() => ({
    ...productLabels,
  }));

  const [error, setError] = useState<string | null>(null);
  /**
   * The form's one announcement slot (F4/F8). A live region that mounts
   * *together with* its text is not reliably announced — the rule
   * `cart-screen.tsx`, `pantry-screen.tsx` and `dish-screen.tsx` all document
   * — so the region below is permanent and empty until something writes to
   * it, with the inner `<span>` keyed on a counter so two identical messages
   * in a row are still a real DOM mutation.
   */
  const [announcement, setAnnouncement] = useState<{
    text: string;
    seq: number;
  } | null>(null);
  const announceSeq = useRef(0);
  /** Read synchronously by `announce`, which effects call outside a render. */
  const rebindingRef = useRef<string | null>(null);
  const pendingAnnounceRef = useRef<string | null>(null);
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  const [rebinding, setRebinding] = useState<string | null>(null);
  const [saved, setSaved] = useState<{
    dishId: string;
    created: number;
    aiFailed: boolean;
  } | null>(null);

  /**
   * Upload keys this session replaced or cleared, discarded once a save
   * lands. Held in a ref rather than in state: nothing renders them, and a
   * re-render must not be able to lose one.
   *
   * Discarded *after* the save, never before — until the write commits, the
   * old photo is still the one the dish has, and deleting it on the tap of
   * «Заменить фото» would leave a saved dish pointing at a blob that no
   * longer exists if the save then failed.
   */
  const displacedKeysRef = useRef<string[]>([]);

  /** Render state lands a re-render too late for a double tap. */
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const savedLinkRef = useRef<HTMLAnchorElement>(null);
  /** Set while a row is being deleted, consumed by the focus rescue below. */
  const focusAfterRemoveRef = useRef<string | null>(null);
  /** Where focus lands when the row deleted was the last one of its list. */
  const addIngredientRef = useRef<HTMLButtonElement>(null);
  const addStepRef = useRef<HTMLButtonElement>(null);
  const focusFallbackRef = useRef<HTMLButtonElement | null>(null);

  const serverMovedOn =
    target.mode === "edit" && (latest?.version ?? 0) > expectedVersion;

  const create = useMutation(
    trpc.dish.create.mutationOptions({ networkMode: "always" }),
  );
  const update = useMutation(
    trpc.dish.update.mutationOptions({ networkMode: "always" }),
  );
  const discardPhoto = useMutation(
    trpc.dishImport.discardPhoto.mutationOptions({ networkMode: "always" }),
  );

  /**
   * Swaps the photo, remembering the key it displaced.
   *
   * The displaced key is computed here rather than inside a `setPhoto`
   * updater: React invokes updaters twice in development's strict mode, and a
   * side effect in one would queue the same key for deletion twice.
   */
  function replacePhoto(next: { url: string | null; key: string | null }) {
    if (photo.key !== null && photo.key !== next.key) {
      displacedKeysRef.current.push(photo.key);
    }
    setPhoto(next);
  }

  // The one place the form is re-seeded after mount, and only ever from a tap
  // on the banner: what the partner saved replaces what is on screen, on
  // purpose and visibly.
  function adopt() {
    if (!latest) {
      return;
    }
    setTitle(latest.draft.title);
    setPortionsText(portionsToText(latest.draft));
    setTotalTimeText(
      latest.draft.totalTimeMin === null
        ? ""
        : String(latest.draft.totalTimeMin),
    );
    setEquipment([...latest.draft.equipment]);
    setTags([...latest.draft.tags]);
    replacePhoto({ url: latest.draft.photoUrl, key: latest.draft.photoKey });
    setIngredients(keyRows(latest.draft.ingredients));
    setSteps(keyRows(latest.draft.steps));
    // Merged, not replaced: an id this form bound during the session is still
    // worth a name, and a stale entry is only an unused map key. Without this
    // a row the partner bound would adopt with the «продукт» fallback and a
    // 🛒 — indistinguishable from a product we could not name.
    setLabels((current) => ({ ...current, ...latest.productLabels }));
    setExpectedVersion(latest.version);
    setChangedElsewhere(false);
    setError(null);
  }

  /**
   * `BottomSheet` renders `aria-modal="true"` inline, without a portal, so
   * while the rebind sheet is open everything outside it — this region
   * included — is pruned from the accessibility tree. A message written there
   * is never spoken, and because the region's `<span>` is keyed on `seq`, the
   * sheet closing is not itself a DOM mutation, so it would never be replayed.
   * Ambient messages raised behind the sheet are therefore held and re-issued
   * on close, with a fresh `seq`.
   */
  function announce(text: string) {
    if (rebindingRef.current !== null) {
      pendingAnnounceRef.current = text;
      return;
    }
    announceSeq.current += 1;
    setAnnouncement({ text, seq: announceSeq.current });
  }

  // **Declared first on purpose.** Effects run in order, so tracking the
  // sheet's state here means the two ambient effects below already see the
  // current value through `rebindingRef` in the same commit.
  useEffect(() => {
    rebindingRef.current = rebinding;
    if (rebinding !== null) {
      return;
    }
    const held = pendingAnnounceRef.current;
    if (held !== null) {
      pendingAnnounceRef.current = null;
      announce(held);
    }
  }, [rebinding]);

  // Nothing else tells a screen-reader user the server moved on: the banner is
  // raised by a background `dish.get` refetch (focus/reconnect), with no action
  // of theirs to explain it. The `changedElsewhere` trigger is deliberately
  // absent from the dependencies — that path already speaks through the
  // `role="alert"` error below, and announcing both would say it twice.
  //
  // Scoped to the editing branch: on the saved panel there is no banner to
  // explain and nothing left to refresh.
  useEffect(() => {
    if (serverMovedOn && saved === null) {
      announce(t("changedElsewhere"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverMovedOn, saved]);

  // Losing the connection is likewise something that happens *to* the form —
  // but only while there is still a save to lose. Announcing «блюдо не
  // сохранится» over the panel confirming it was saved is worse than silence.
  useEffect(() => {
    if (!online && saved === null) {
      announce(t("offline"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, saved]);

  // Focus never lands on `<body>`: the successor's own delete button is where
  // a keyboard user was heading anyway. Guarded on `activeElement` so it
  // rescues focus and never steals it from wherever the user moved next.
  useEffect(() => {
    const target = focusAfterRemoveRef.current;
    const fallback = focusFallbackRef.current;
    if (target === null && fallback === null) {
      return;
    }
    focusAfterRemoveRef.current = null;
    focusFallbackRef.current = null;
    if (document.activeElement !== document.body) {
      return;
    }
    const successor = target === null ? null : document.getElementById(target);
    // The successor's own delete button, or — when the row deleted was the
    // last one — the «+ …» button that adds another. Never `<body>`, where a
    // keyboard user's next Tab would start again from the top of the page.
    (successor ?? fallback)?.focus();
  }, [ingredients, steps]);

  useEffect(() => {
    if (saved !== null) {
      savedLinkRef.current?.focus();
    }
  }, [saved]);

  function ingredientRemoveId(key: string) {
    return `${fieldId}-ing-remove-${key}`;
  }

  function stepRemoveId(key: string) {
    return `${fieldId}-step-remove-${key}`;
  }

  function removeIngredient(key: string) {
    const next = pickNextFocusTarget(
      ingredients.map((row) => ({ id: row.key })),
      key,
    );
    focusAfterRemoveRef.current =
      next === null ? null : ingredientRemoveId(next);
    focusFallbackRef.current = addIngredientRef.current;
    setIngredients((rows) => rows.filter((row) => row.key !== key));
  }

  function removeStep(key: string) {
    const next = pickNextFocusTarget(
      steps.map((row) => ({ id: row.key })),
      key,
    );
    focusAfterRemoveRef.current = next === null ? null : stepRemoveId(next);
    focusFallbackRef.current = addStepRef.current;
    setSteps((rows) => rows.filter((row) => row.key !== key));
  }

  function addIngredient() {
    setIngredients((rows) => [...rows, newRow(blankIngredient())]);
  }

  function addStep() {
    setSteps((rows) => [...rows, newRow(blankStep())]);
  }

  function patchIngredient(key: string, value: DraftIngredient) {
    setIngredients((rows) =>
      rows.map((row) => (row.key === key ? { ...row, value } : row)),
    );
  }

  function patchStep(key: string, value: DraftStep) {
    setSteps((rows) =>
      rows.map((row) => (row.key === key ? { ...row, value } : row)),
    );
  }

  function moveStep(from: number, to: number) {
    setSteps((rows) => moveItem(rows, from, to));
  }

  // ── Step drag ────────────────────────────────────────────────────────────
  const rowElements = useRef(new Map<string, HTMLLIElement>());
  const dragRef = useRef<{ pointerId: number; key: string } | null>(null);
  const [draggingKey, setDraggingKey] = useState<string | null>(null);

  function startDrag(key: string, event: ReactPointerEvent<HTMLElement>) {
    // A second finger must not overwrite the active drag's baseline, and a
    // right-click's suppressed `pointerup` would strand the row mid-drag.
    if (dragRef.current !== null || !event.isPrimary || event.button !== 0) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, key };
    setDraggingKey(key);
  }

  function onDragMove(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
  }

  function endDrag(event: ReactPointerEvent<HTMLElement>, commit: boolean) {
    const drag = dragRef.current;
    // Checked before clearing, so a stray pointer's up/cancel cannot wipe a
    // drag that belongs to a different, still-active finger.
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    // Cleared **before** the commit: a re-render that still saw drag state
    // would resurrect a gesture that has already ended.
    dragRef.current = null;
    setDraggingKey(null);

    if (!commit) {
      return;
    }

    const from = steps.findIndex((row) => row.key === drag.key);
    if (from === -1) {
      return;
    }

    const rects = steps.map((row) => {
      const element = rowElements.current.get(row.key);
      const rect = element?.getBoundingClientRect();
      return { top: rect?.top ?? 0, height: rect?.height ?? 0 };
    });

    // `stepDropIndex` takes `from` because the gap the pointer sits in is
    // measured on the list as drawn, while `moveItem` inserts into the list
    // with the dragged row already lifted out.
    moveStep(from, stepDropIndex(event.clientY, rects, from));
  }

  // ── Save ─────────────────────────────────────────────────────────────────
  function collect(): RecipeDraft | null {
    const portions = parsePortions(portionsText);
    if (portions === null) {
      setError(t("portionsInvalid"));
      return null;
    }

    return normalizeDraftForSave({
      title,
      photoUrl: photo.url,
      photoKey: photo.key,
      tags,
      sourceType: initial.sourceType,
      sourceUrl: initial.sourceUrl,
      portionsBase: portions.base,
      portionsMin: portions.min,
      yieldUnit: initial.yieldUnit,
      totalTimeMin: parseMinutesInput(totalTimeText, MAX_TOTAL_TIME_MIN),
      equipment,
      ingredients: ingredients.map((row) => row.value),
      steps: steps.map((row) => row.value),
    });
  }

  async function save() {
    if (savingRef.current) {
      return;
    }
    savingRef.current = true;
    setSaving(true);
    setError(null);

    try {
      const draft = collect();
      if (draft === null) {
        return;
      }
      if (draft.title.length === 0) {
        setError(t("titleRequired"));
        return;
      }
      if (draft.ingredients.length === 0) {
        setError(t("ingredientsRequired"));
        return;
      }

      const parsed = recipeDraftSchema.safeParse(draft);
      if (!parsed.success) {
        setError(t("invalid"));
        return;
      }

      const result =
        target.mode === "create"
          ? await create.mutateAsync({
              draft: parsed.data,
              originalDraft: target.originalDraft ?? null,
              jobId: target.jobId ?? null,
            })
          : await update.mutateAsync({
              id: target.dishId,
              expectedVersion,
              draft: parsed.data,
            });

      // **Not awaited, and not inside the mutex.** `invalidateQueries` awaits
      // the refetch it triggers, and a refetch that pauses (the device drops
      // offline mid-flight, `networkMode: "online"`) never settles until the
      // browser is back and focused — which would hold `savingRef`, leave the
      // button on «Сохраняем…» and swallow every further tap for the whole
      // outage, for a write the server has already committed. `dish-screen`'s
      // `invalidateDish()` follows the same rule.
      //
      // The whole `dish` path, not just `list` + `get`: an archived dish is
      // still editable, and `listArchived` renders the title this save may
      // have just rewritten and hands «Вернуть» the `version` it just spent.
      void queryClient.invalidateQueries(trpc.dish.pathFilter());
      // A save can mint catalog rows, so the sheet's cached searches are
      // stale — the same reason `product.create` invalidates them.
      void queryClient.invalidateQueries({
        ...trpc.product.pathFilter(),
        refetchType: "none",
      });

      // The version this form just authored. Without it the refetch above
      // raises `latest.version` past `expectedVersion` and the form tells the
      // user someone else changed the dish — over its own «Блюдо сохранено».
      setExpectedVersion(result.dish.version);

      const created = result.createdProducts.length;
      // The blobs this session displaced are now provably unreferenced by the
      // aggregate that was just written. Not awaited (and its failures are
      // ignored): an orphaned upload is hygiene, and a save that succeeded
      // must not report an error because a third-party delete did not.
      // `discardPhoto` refuses a key any dish still points at, so a photo the
      // partner is using cannot be deleted from here either.
      for (const fileKey of displacedKeysRef.current.splice(0)) {
        discardPhoto.mutate({ fileKey });
      }

      setSaved({ dishId: result.dish.id, created, aiFailed: result.aiFailed });
      announce(
        created === 0
          ? t("savedTitle")
          : `${t("savedTitle")}. ${
              result.aiFailed
                ? t("savedProductsCheck", { count: created })
                : t("savedProducts", { count: created })
            }`,
      );
    } catch (caught) {
      if (isConflictError(caught)) {
        // Re-sending the same `expectedVersion` would fail identically
        // forever; the banner is the way out, and it needs fresh server data.
        setChangedElsewhere(true);
        setError(t("conflict"));
        if (target.mode === "edit") {
          // Not awaited either, and for the same reason: the banner is already
          // on screen, and the fresh aggregate only decides what «Обновить»
          // adopts when the user taps it.
          void queryClient.invalidateQueries(
            trpc.dish.get.queryFilter({ id: target.dishId }),
          );
        }
        return;
      }
      setError(online ? t("saveFailed") : t("offline"));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  function addTag(raw: string) {
    // Only a full list keeps the typed word and gets a message: a duplicate is
    // already a chip right above the field, and a blank is not an attempt.
    // The visible notice is *derived* below rather than stored, so removing a
    // chip clears it on its own; the announcement stays one-shot, because a
    // live region that re-speaks on every keystroke is unusable.
    if (tagAddOutcome(tags, raw) === "full") {
      announce(t("tagsFull"));
      return;
    }

    setTags(normalizeTags([...tags, raw]));
    setTagDraft("");
  }

  /**
   * Permanent, and outside the saved/editing branch on purpose: a region that
   * appears together with its text is not reliably announced, so it has to
   * already exist when the save lands.
   */
  const liveRegion = (
    <p className={styles.srOnly} role="status">
      <span key={announcement?.seq ?? "empty"}>{announcement?.text ?? ""}</span>
    </p>
  );

  if (saved !== null) {
    return (
      <div className={styles.savedPanel}>
        {liveRegion}
        <p className={styles.savedTitle}>{t("savedTitle")}</p>
        {saved.created > 0 ? (
          <p className={styles.savedNote}>
            {saved.aiFailed
              ? t("savedProductsCheck", { count: saved.created })
              : t("savedProducts", { count: saved.created })}
          </p>
        ) : null}
        <Link
          ref={savedLinkRef}
          className={styles.primaryButton}
          href={`/dishes/${saved.dishId}`}
        >
          {t("openDish")}
        </Link>
      </div>
    );
  }

  const rebindingRow = ingredients.find((row) => row.key === rebinding);

  return (
    <div className={styles.form}>
      {liveRegion}

      {initial.sourceType === "manual" ? null : (
        <p className={styles.aiCaption}>{t("aiCaption")}</p>
      )}

      {serverMovedOn || changedElsewhere ? (
        <div className={styles.banner}>
          {/* Not `aria-hidden`: the live region speaks this once, but the
              banner stays on screen long after — and the next announcement
              (offline, the tag cap) overwrites that slot. Left in the
              accessibility tree it is the button's own static explanation,
              and since it is not inside a live region it is never re-spoken
              on change, so there is no double read. */}
          <span id={`${fieldId}-conflict`}>{t("changedElsewhere")}</span>
          <button
            type="button"
            className={styles.inlineButton}
            onClick={adopt}
            aria-describedby={`${fieldId}-conflict`}
            aria-disabled={latest ? undefined : true}
          >
            {t("refresh")}
          </button>
        </div>
      ) : null}

      <label className={styles.label} htmlFor={`${fieldId}-title`}>
        {t("titleLabel")}
      </label>
      <input
        id={`${fieldId}-title`}
        className={styles.input}
        type="text"
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder={t("titlePlaceholder")}
        maxLength={120}
        autoComplete="off"
      />

      <div className={styles.photoSlot}>
        {photo.url === null ? null : (
          <div className={styles.photoRow}>
            {/* Not `next/image`: dish photos come from UploadThing and from
                arbitrary imported pages, so every host would need a
                `remotePatterns` entry we have never seen. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className={styles.photo}
              src={photo.url}
              alt={t("photoAlt")}
              decoding="async"
              referrerPolicy="no-referrer"
            />
            <button
              type="button"
              className={styles.inlineButton}
              onClick={() => replacePhoto({ url: null, key: null })}
            >
              {t("removePhoto")}
            </button>
          </div>
        )}
        {photoUploadSlot?.({
          current: photo,
          onPicked: (next) => replacePhoto({ url: next.url, key: next.key }),
        })}
      </div>

      <div className={styles.twoUp}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${fieldId}-portions`}>
            {t("portionsLabel")}
          </label>
          <input
            id={`${fieldId}-portions`}
            className={styles.input}
            type="text"
            inputMode="numeric"
            value={portionsText}
            onChange={(event) => setPortionsText(event.target.value)}
            placeholder={t("portionsPlaceholder")}
            autoComplete="off"
          />
          {initial.yieldUnit === null ? null : (
            // Imported data, not copy: the source's own yield noun, shown so
            // the number reads right. The form does not edit it.
            <p className={styles.fieldHint}>
              {t("yieldUnit", { unit: initial.yieldUnit })}
            </p>
          )}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${fieldId}-time`}>
            {t("totalTimeLabel")}
          </label>
          <input
            id={`${fieldId}-time`}
            className={styles.input}
            type="text"
            inputMode="numeric"
            value={totalTimeText}
            onChange={(event) => setTotalTimeText(event.target.value)}
            placeholder={t("totalTimePlaceholder")}
            autoComplete="off"
          />
        </div>
      </div>

      <fieldset className={styles.fieldset}>
        <legend className={styles.label}>{t("equipmentLabel")}</legend>
        <div className={styles.equipmentGrid}>
          {EQUIPMENT_PRESETS.map((slug) => (
            <label key={slug} className={styles.checkbox}>
              <input
                type="checkbox"
                checked={equipment.includes(slug)}
                onChange={(event) =>
                  setEquipment((current) =>
                    event.target.checked
                      ? [...current, slug]
                      : current.filter((entry) => entry !== slug),
                  )
                }
              />
              {equipmentLabels(slug)}
            </label>
          ))}
        </div>
      </fieldset>

      <label className={styles.label} htmlFor={`${fieldId}-tag`}>
        {t("tagsLabel")}
      </label>
      {tags.length === 0 ? null : (
        <ul className={styles.tagList}>
          {tags.map((tag) => (
            <li key={tag}>
              <button
                type="button"
                className={styles.tagChip}
                onClick={() => setTags(tags.filter((entry) => entry !== tag))}
                aria-label={t("removeTagAria", { tag })}
              >
                {tag} ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.tagRow}>
        <input
          id={`${fieldId}-tag`}
          className={styles.input}
          type="text"
          value={tagDraft}
          onChange={(event) => setTagDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === ",") {
              event.preventDefault();
              addTag(tagDraft);
            }
          }}
          placeholder={t("tagsPlaceholder")}
          maxLength={MAX_TAG_LENGTH}
          autoComplete="off"
        />
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={() => addTag(tagDraft)}
        >
          {t("addTag")}
        </button>
      </div>
      {tags.length >= MAX_TAGS && tagDraft.trim().length > 0 ? (
        // Derived, not stored: a stored notice outlives the condition — it
        // stayed on screen after a chip was removed, and after «Обновить»
        // replaced the whole tag list. Beside the field that produced it, not
        // in the error box after the steps section; `aria-hidden` because
        // `announce()` already said it.
        <p className={styles.warning} aria-hidden="true">
          {t("tagsFull")}
        </p>
      ) : null}

      <h2 className={styles.sectionTitle}>{t("ingredientsTitle")}</h2>
      <ul className={styles.rowList}>
        {ingredients.map((row) => (
          <IngredientEditRow
            key={row.key}
            value={row.value}
            bound={
              row.value.productId === null
                ? null
                : (labels[row.value.productId] ?? null)
            }
            removeButtonId={ingredientRemoveId(row.key)}
            onChange={(value) => patchIngredient(row.key, value)}
            onRebind={(opener) => {
              sheetOpener.captureOpener(opener);
              setRebinding(row.key);
            }}
            onRemove={() => removeIngredient(row.key)}
          />
        ))}
      </ul>
      <button
        ref={addIngredientRef}
        type="button"
        className={styles.secondaryButton}
        onClick={addIngredient}
      >
        {t("addIngredient")}
      </button>

      <h2 className={styles.sectionTitle}>{t("stepsTitle")}</h2>
      <ul
        className={styles.rowList}
        onPointerMove={onDragMove}
        onPointerUp={(event) => endDrag(event, true)}
        onPointerCancel={(event) => endDrag(event, false)}
        onLostPointerCapture={(event) => endDrag(event, false)}
      >
        {steps.map((row, index) => (
          <StepEditRow
            key={row.key}
            index={index}
            total={steps.length}
            value={row.value}
            dragging={draggingKey === row.key}
            rowRef={(element) => {
              if (element === null) {
                rowElements.current.delete(row.key);
              } else {
                rowElements.current.set(row.key, element);
              }
            }}
            removeButtonId={stepRemoveId(row.key)}
            onChange={(value) => patchStep(row.key, value)}
            onRemove={() => removeStep(row.key)}
            onMove={(to) => moveStep(index, to)}
            onDragStart={(event) => startDrag(row.key, event)}
          />
        ))}
      </ul>
      <button
        ref={addStepRef}
        type="button"
        className={styles.secondaryButton}
        onClick={addStep}
      >
        {t("addStep")}
      </button>

      {error === null ? null : (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      {online ? null : (
        <p className={styles.warning} aria-hidden="true">
          {t("offline")}
        </p>
      )}

      <button
        type="button"
        className={cx(styles.primaryButton, styles.saveButton)}
        onClick={() => void save()}
        // Never `disabled`: it would drop focus off the button just tapped.
        aria-disabled={saving || undefined}
      >
        {saving ? t("savePending") : t("save")}
      </button>

      <AutocompleteSheet
        open={rebinding !== null}
        variant="product"
        title={t("rebindTitle")}
        onClose={() => setRebinding(null)}
        restoreFocusTo={sheetOpener.restoreFocusTo}
        onAdded={({ product }) => {
          if (rebindingRow) {
            setLabels((current) => ({
              ...current,
              [product.id]: { name: product.name, icon: product.icon },
            }));
            patchIngredient(rebindingRow.key, {
              ...rebindingRow.value,
              name: product.name,
              productId: product.id,
            });
          }
          setRebinding(null);
        }}
        onPickUnbound={(name) => {
          if (rebindingRow) {
            patchIngredient(rebindingRow.key, {
              ...rebindingRow.value,
              name,
              productId: null,
            });
          }
          setRebinding(null);
        }}
      />
    </div>
  );
}

function keyRows<TValue>(values: readonly TValue[]): KeyedRow<TValue>[] {
  return values.map((value) => newRow(value));
}

function newRow<TValue>(value: TValue): KeyedRow<TValue> {
  return { key: rowKey(), value };
}

let fallbackKey = 0;

/**
 * A stable list key. `crypto.randomUUID()` needs a secure context, which a
 * PWA always has — but a plain-http preview on a LAN address does not, and a
 * form that throws while mounting is a worse failure than a weaker key.
 */
function rowKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  fallbackKey += 1;
  return `row-${fallbackKey}`;
}

function blankIngredient(): DraftIngredient {
  return {
    rawText: "",
    name: "",
    qty: null,
    unit: null,
    note: null,
    isOptional: false,
    needsReview: false,
    productId: null,
  };
}

function blankStep(): DraftStep {
  return { text: "", timerSec: null, timerMaxSec: null };
}

/** «8» or «7–8» — the one field `parsePortions` reads back. */
function portionsToText(
  draft: Pick<RecipeDraft, "portionsBase" | "portionsMin">,
): string {
  return draft.portionsMin === null
    ? String(draft.portionsBase)
    : `${draft.portionsMin}–${draft.portionsBase}`;
}
