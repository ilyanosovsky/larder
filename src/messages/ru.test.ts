import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import { ingredientsForMessage } from "@/lib/recipes/portions";
import { timerDisplay, timerMessage } from "@/lib/recipes/timer";

import messages from "./ru.json";

/**
 * The dictionary is the one place Russian grammar lives (AGENTS.md: UI
 * strings only through next-intl), and an ICU message is code — a missing
 * plural branch is a bug the type system cannot see and a pure module cannot
 * catch, because the module hands next-intl numbers and next-intl picks the
 * word.
 *
 * **These tests render through the same functions the screens call**, not
 * through a local copy of their branches: `ingredientsForMessage` and
 * `timerMessage` return the key *and* its values, and `dish-screen.tsx` does
 * nothing but `t(message.key, message.values)`. That is what makes the
 * pairing real — vitest runs in `node` with no DOM harness, so a branch left
 * inside the component would be unreachable from here and a flipped one would
 * ship green.
 *
 * Missing keys need catching too: next-intl has no type augmentation in this
 * repo and returns the key path (with a console error) rather than throwing,
 * so a deleted entry would put the literal «dish.conflict» on screen and pass
 * every other gate.
 */
function translator(
  namespace: "dish" | "dishes" | "dishForm" | "dishPortions" | "cooking",
) {
  return createTranslator({ locale: "ru", messages, namespace });
}

describe("portion ranges", () => {
  const t = translator("dish");
  const card = translator("dishes");

  it("declines the upper bound instead of always saying «порций»", () => {
    expect(t("portionsRange", { from: 3, to: 4 })).toBe("3–4 порции");
    expect(t("portionsRange", { from: 20, to: 21 })).toBe("20–21 порция");
    expect(t("portionsRange", { from: 7, to: 8 })).toBe("7–8 порций");
  });

  it("declines it on the S6 card too", () => {
    expect(card("cardPortionsRange", { from: 3, to: 4 })).toBe("3–4 порции");
    expect(card("cardPortionsRange", { from: 7, to: 8 })).toBe("7–8 порций");
  });

  it("passes the source's own yield noun through untouched", () => {
    // An imported noun has no plural forms we know, so it is interpolated
    // verbatim — the reason these are separate messages.
    expect(t("portionsRangeUnit", { from: 7, to: 8, unit: "печений" })).toBe(
      "7–8 печений",
    );
  });
});

describe("the ingredients header", () => {
  const t = translator("dish");

  /**
   * Exactly what `dish-screen.tsx` does — the branch is in the module.
   * `count` defaults to the recipe's own `portionsBase`, matching every call
   * below that does not name a different one: an unmoved slider is the
   * common case these first tests pin.
   */
  function header(
    recipe: {
      portionsBase: number;
      portionsMin: number | null;
      yieldUnit: string | null;
    },
    count: number = recipe.portionsBase,
  ): string {
    const message = ingredientsForMessage(recipe, count);
    return t(message.key, message.values);
  }

  it("keeps the yield noun for a ranged yield, unmoved", () => {
    // The regression: «7–8 печений» in the portions row and «на 8 порций»
    // over the list it describes.
    expect(
      header({ portionsBase: 8, portionsMin: 7, yieldUnit: "печений" }),
    ).toBe("на 8 печений");
  });

  it("falls back to declined «порции» when there is no noun", () => {
    expect(header({ portionsBase: 8, portionsMin: 7, yieldUnit: null })).toBe(
      "на 8 порций",
    );
    expect(
      header({ portionsBase: 2, portionsMin: null, yieldUnit: null }),
    ).toBe("на 2 порции");
  });

  describe("task 4.5's slider driving a count other than portionsBase", () => {
    const nycCookies = {
      portionsBase: 8,
      portionsMin: 7,
      yieldUnit: "печений",
    };

    it("keeps the stored noun only at the exact count it was recorded for", () => {
      expect(header(nycCookies, 8)).toBe("на 8 печений");
    });

    it("degrades to declined «порции» for every other count — no «печений» at 1 or 3", () => {
      expect(header(nycCookies, 1)).toBe("на 1 порцию");
      expect(header(nycCookies, 3)).toBe("на 3 порции");
      expect(header(nycCookies, 6)).toBe("на 6 порций");
    });

    it("a recipe with no yieldUnit was already declined at every count", () => {
      const shakshuka = { portionsBase: 2, portionsMin: null, yieldUnit: null };

      expect(header(shakshuka, 1)).toBe("на 1 порцию");
      expect(header(shakshuka, 2)).toBe("на 2 порции");
      expect(header(shakshuka, 6)).toBe("на 6 порций");
    });
  });
});

describe("step timers", () => {
  const t = translator("dish");

  /** Exactly what `dish-screen.tsx` does — the branch is in the module. */
  function label(timerSec: number | null, timerMaxSec: number | null): string {
    const display = timerDisplay(timerSec, timerMaxSec);
    if (display === null) {
      return "";
    }
    const message = timerMessage(display);
    return t(message.key, message.values);
  }

  it("renders the design's own «9–11 мин»", () => {
    expect(label(540, 660)).toBe("9–11 мин");
  });

  it("never renders «0 мин» for a sub-minute countdown", () => {
    expect(label(30, null)).toBe("30 сек");
    expect(label(1, null)).toBe("1 сек");
    expect(label(20, 40)).toBe("20–40 сек");
    expect(label(60, null)).toBe("1 мин");
  });
});

describe("the keys the dish screens call by name", () => {
  /**
   * A cheap existence sweep. Every entry here is spelled out as a literal in
   * `dish-screen.tsx` or `dish-archive-section.tsx` (including the four
   * `SOURCE_MESSAGE` entries, written as a literal map precisely so they stay
   * greppable), and `t()` returns «namespace.key» instead of throwing when one
   * is missing — so without this a deleted line in ru.json ships silently and
   * the banner reads «dish.conflict» to the user.
   */
  const DISH_KEYS = [
    "loading",
    "loadFailed",
    "notFound",
    "retry",
    "back",
    "sourcePhoto",
    "sourceUrl",
    "sourceText",
    "sourceManual",
    "sourceLink",
    "portionsLabel",
    "adaptedTitle",
    "ingredientsTitle",
    "ingredientsEmpty",
    "inPantry",
    "needsReview",
    "optional",
    "stepsTitle",
    "stepsEmpty",
    "toMenu",
    "toCart",
    "cook",
    "cookNoSteps",
    "edit",
    "moreAria",
    "archive",
    "archiveTitle",
    "archiveHint",
    "archiveConfirm",
    "archiveConfirmPending",
    "archiveError",
    "archivedBanner",
    "archivedAnnounce",
    "undo",
    "undoPending",
    "undoDone",
    "undoError",
    "conflict",
    "offline",
  ] as const;

  const SETTINGS_KEYS = [
    "dishArchiveTitle",
    "dishArchiveLoading",
    "dishArchiveLoadFailed",
    "dishArchiveRetry",
    "dishArchiveEmpty",
    "dishArchiveRestore",
    "dishArchiveError",
    "dishArchiveConflict",
    "dishArchiveOffline",
  ] as const;

  /** Every entry here is a literal in `PortionsSlider` / `EquipmentBanner`'s
   *  props, composed inside `dish-screen.tsx` — task 4.5. */
  const DISH_PORTIONS_KEYS = [
    "decreaseAria",
    "increaseAria",
    "equipmentNeed",
    "adaptButton",
    "adaptHint",
    "profileMissing",
    "profileMissingLink",
  ] as const;

  it.each(DISH_KEYS)("dish.%s resolves to real copy", (key) => {
    const rendered = translator("dish")(key);

    expect(rendered).not.toBe(`dish.${key}`);
    expect(rendered.trim().length).toBeGreaterThan(0);
  });

  const DISH_FORM_KEYS = Object.keys(
    messages.dishForm,
  ) as (keyof typeof messages.dishForm)[];

  it.each(DISH_FORM_KEYS)("dishForm.%s resolves to real copy", (key) => {
    // Swept off the dictionary itself rather than a hand-kept list: the S8.3
    // form renders more than sixty strings, and a list that has to be updated
    // by hand is a list that silently stops covering the newest key.
    const rendered = translator("dishForm")(key, {
      count: 1,
      name: "Мука",
      tag: "выпечка",
      unit: "печений",
      position: 1,
    });

    expect(rendered).not.toBe(`dishForm.${key}`);
    expect(rendered.trim().length).toBeGreaterThan(0);
  });

  it("declines the saved-products count across Russian plural categories", () => {
    // The sweep above renders every key with `count: 1`, so it can only ever
    // exercise the `one` arm — and ICU falls back to `other` silently, so a
    // deleted `many` branch would ship «Создано 5 новых продукта» green.
    // Exact strings, because `toContain("продуктов")` would not notice a
    // swapped few/many pair either.
    const t = translator("dishForm");

    expect(t("savedProducts", { count: 1 })).toBe("Создан 1 новый продукт");
    expect(t("savedProducts", { count: 2 })).toBe("Создано 2 новых продукта");
    expect(t("savedProducts", { count: 5 })).toBe("Создано 5 новых продуктов");

    expect(t("savedProductsCheck", { count: 1 })).toBe(
      "Создан 1 новый продукт — проверь его в каталоге",
    );
    expect(t("savedProductsCheck", { count: 2 })).toBe(
      "Создано 2 новых продукта — проверь их в каталоге",
    );
    expect(t("savedProductsCheck", { count: 5 })).toBe(
      "Создано 5 новых продуктов — проверь их в каталоге",
    );
  });

  it("renders every plural dishForm message through all three categories", () => {
    // General, so a plural key added later is covered the way the existence
    // sweep already covers a new key: each arm must be distinct copy, not the
    // `other` fallback wearing another number.
    const t = translator("dishForm");
    const plurals = Object.entries(messages.dishForm).filter(([, value]) =>
      value.includes(", plural,"),
    );

    expect(plurals.length).toBeGreaterThan(0);
    for (const [key] of plurals) {
      const rendered = [1, 2, 5].map((count) =>
        t(key as keyof typeof messages.dishForm, { count }),
      );
      for (const line of rendered) {
        expect(line.trim().length).toBeGreaterThan(0);
      }
      // «1 продукт» / «2 продукта» / «5 продуктов» — three different words.
      expect(
        new Set(rendered.map((line) => line.replace(/\d+/g, "#"))).size,
      ).toBe(3);
    }
  });

  it.each(SETTINGS_KEYS)("settings.%s resolves to real copy", (key) => {
    const rendered = createTranslator({
      locale: "ru",
      messages,
      namespace: "settings",
    })(key);

    expect(rendered).not.toBe(`settings.${key}`);
    expect(rendered.trim().length).toBeGreaterThan(0);
  });

  it.each(DISH_PORTIONS_KEYS)(
    "dishPortions.%s resolves to real copy",
    (key) => {
      const rendered = translator("dishPortions")(key);

      expect(rendered).not.toBe(`dishPortions.${key}`);
      expect(rendered.trim().length).toBeGreaterThan(0);
    },
  );
});

describe("cooking (task 4.7)", () => {
  const t = translator("cooking");

  /** Every entry here is a literal in `cooking-overlay.tsx` / `cook-timer.tsx` — see `dish.%s` above for why this sweep exists at all. `timerRunningAria` takes a `{clock}` param, so it gets its own parameterized test below instead. */
  const COOKING_KEYS = [
    "prev",
    "next",
    "noSteps",
    "timerFinished",
    "timerFinishedSr",
    "timerReset",
    "timerBusy",
    "timerJumpAria",
    "wakeLockHint",
    "ingredientsToggle",
    "exitTitle",
    "exitHint",
    "exitCancel",
    "exitConfirm",
  ] as const;

  it.each(COOKING_KEYS)("cooking.%s resolves to real copy", (key) => {
    const rendered = t(key);

    expect(rendered).not.toBe(`cooking.${key}`);
    expect(rendered.trim().length).toBeGreaterThan(0);
  });

  it("titles the dialog with the dish's own name", () => {
    expect(t("dialogTitle", { title: "NYC Cookies" })).toBe(
      "Готовим «NYC Cookies»",
    );
  });

  it("renders «шаг N из M» from the two integers `cooking-overlay.tsx` tracks", () => {
    expect(t("progress", { current: 3, total: 6 })).toBe("шаг 3 из 6");
    expect(t("progress", { current: 1, total: 1 })).toBe("шаг 1 из 1");
  });

  it("composes the start button from the reused dish.timer* label, not a second copy of it", () => {
    // `cook-timer.tsx` builds `label` from `timerMessage`/`dish.timer*` —
    // see that file's own doc comment — and hands the already-translated
    // string in here as a plain parameter.
    expect(t("timerStart", { label: "9–11 мин" })).toBe("9–11 мин · запустить");
  });

  it("composes the running clock's accessible name with the live digits, not a static «Осталось»", () => {
    // `role="timer"` permits an author-provided name (a generic `<span>`
    // does not — orchestrator review round 1, K8), and that name must
    // actually carry the remaining time, since the digits are the sole
    // content the clock renders.
    expect(t("timerRunningAria", { clock: "09:00" })).toBe("Осталось 09:00");
  });
});

describe("the equipment banner's «скоро» hint", () => {
  /**
   * `EquipmentBanner` never composes this itself (it is presentational, like
   * `QtyStepper`) — `dish-screen.tsx` builds it from two namespaces:
   * `dish.soonHint`, the same "«{action}» — скоро" template every other
   * not-yet-wired button on S7 uses, filled with `dishPortions.adaptButton`.
   */
  it("reuses dish.soonHint rather than a second copy of the pattern", () => {
    const dish = translator("dish");
    const portions = translator("dishPortions");

    expect(dish("soonHint", { action: portions("adaptButton") })).toBe(
      "«Адаптировать (ИИ)» — скоро",
    );
  });
});

describe("the equipment banner's missing-appliances sentence", () => {
  /**
   * `dishPortions.equipmentMissing` takes a `{list}` parameter, so it does
   * not belong in `DISH_PORTIONS_KEYS`'s param-free existence sweep above —
   * same reasoning as `dish.portionsRange`/`portionsRangeUnit` getting their
   * own `describe` block instead. `EquipmentBanner` builds `list` itself
   * (the missing labels, comma-joined) and hands it to a formatter
   * `dish-screen.tsx` composes from this exact key — see
   * `equipment-banner.tsx`'s doc comment on the `missingText` prop.
   */
  it("stays invariant regardless of how many appliances are missing", () => {
    const portions = translator("dishPortions");

    expect(portions("equipmentMissing", { list: "Миксер" })).toBe(
      "Не хватает: Миксер",
    );
    expect(portions("equipmentMissing", { list: "Миксер, Аэрогриль" })).toBe(
      "Не хватает: Миксер, Аэрогриль",
    );
  });
});
