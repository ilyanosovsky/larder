import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import { ingredientsYieldUnit } from "@/lib/recipes/portions";
import { timerDisplay } from "@/lib/recipes/timer";

import messages from "./ru.json";

/**
 * The dictionary is the one place Russian grammar lives (AGENTS.md: UI
 * strings only through next-intl), and an ICU message is code — a missing
 * plural branch is a bug the type system cannot see and a pure module cannot
 * catch, because the module hands next-intl numbers and next-intl picks the
 * word. These tests render the messages the dish screens compose from their
 * tested inputs, so the pairing of "what the helper decided" and "what the
 * user reads" is pinned end to end.
 */
function translator(namespace: "dish" | "dishes") {
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

  function header(recipe: {
    portionsBase: number;
    portionsMin: number | null;
    yieldUnit: string | null;
  }): string {
    const unit = ingredientsYieldUnit(recipe);
    return unit === null
      ? t("ingredientsFor", { count: recipe.portionsBase })
      : t("ingredientsForUnit", { count: recipe.portionsBase, unit });
  }

  it("keeps the yield noun for a ranged yield", () => {
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
});

describe("step timers", () => {
  const t = translator("dish");

  function label(timerSec: number | null, timerMaxSec: number | null): string {
    const display = timerDisplay(timerSec, timerMaxSec);
    if (display === null) {
      return "";
    }
    if (display.kind === "single") {
      return display.unit === "sec"
        ? t("timerSeconds", { seconds: display.value })
        : t("timer", { minutes: display.value });
    }
    return display.unit === "sec"
      ? t("timerSecondsRange", { from: display.from, to: display.to })
      : t("timerRange", { from: display.from, to: display.to });
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
