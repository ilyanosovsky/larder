import { describe, expect, it } from "vitest";

import {
  buildRevisionDeck,
  decideRevisionCard,
  initialRevisionState,
  revisionProgress,
  summarizeRevision,
  type RevisionState,
} from "@/lib/pantry/revision-deck";

interface Card {
  id: string;
  productName: string;
  productIcon: string;
  categoryName: string;
}

const BUTTER: Card = {
  id: "butter",
  productName: "Масло",
  productIcon: "🧈",
  categoryName: "Молочка",
};
const MILK: Card = {
  id: "milk",
  productName: "Молоко",
  productIcon: "🥛",
  categoryName: "Молочка",
};
const EGGS: Card = {
  id: "eggs",
  productName: "Яйца",
  productIcon: "🥚",
  categoryName: "Молочка",
};

describe("buildRevisionDeck", () => {
  it("copies the list in the same order", () => {
    const deck = buildRevisionDeck([BUTTER, MILK, EGGS]);
    expect(deck).toEqual([BUTTER, MILK, EGGS]);
  });

  it("never returns the same array reference it was given", () => {
    const items = [BUTTER, MILK];
    const deck = buildRevisionDeck(items);
    expect(deck).not.toBe(items);
  });

  it("never returns the same row object references it was given", () => {
    const items = [BUTTER, MILK];
    const deck = buildRevisionDeck(items);
    expect(deck[0]).not.toBe(BUTTER);
    expect(deck[1]).not.toBe(MILK);
  });

  it("is unaffected by a later field mutation on a source row", () => {
    // Nothing in this app mutates a cached pantry row in place, but the deck
    // must not leak that mutation through even if something someday did —
    // it holds its own copy of every row, not the same object reference.
    const source = { ...BUTTER };
    const deck = buildRevisionDeck([source, MILK]);

    source.productName = "Маргарин";

    expect(deck[0]).toEqual(BUTTER);
  });

  it("is unaffected by later mutations to the source array", () => {
    const items = [BUTTER, MILK];
    const deck = buildRevisionDeck(items);
    items.push(EGGS);
    expect(deck).toEqual([BUTTER, MILK]);
  });

  it("builds an empty deck from an empty list", () => {
    expect(buildRevisionDeck([])).toEqual([]);
  });
});

describe("decideRevisionCard", () => {
  it("advances the index without recording a «have» decision", () => {
    const next = decideRevisionCard(initialRevisionState, "butter", "have");
    expect(next).toEqual({ index: 1, ranOutIds: [] });
  });

  it("advances the index and records a «ranOut» decision", () => {
    const next = decideRevisionCard(initialRevisionState, "milk", "ranOut");
    expect(next).toEqual({ index: 1, ranOutIds: ["milk"] });
  });

  it("appends to ranOutIds across successive decisions, in order", () => {
    let state: RevisionState = initialRevisionState;
    state = decideRevisionCard(state, "butter", "ranOut");
    state = decideRevisionCard(state, "milk", "have");
    state = decideRevisionCard(state, "eggs", "ranOut");

    expect(state).toEqual({ index: 3, ranOutIds: ["butter", "eggs"] });
  });

  it("does not mutate the state it was given", () => {
    const state: RevisionState = { index: 0, ranOutIds: ["butter"] };
    decideRevisionCard(state, "milk", "ranOut");
    expect(state).toEqual({ index: 0, ranOutIds: ["butter"] });
  });
});

describe("revisionProgress", () => {
  it("reports the 1-based position mid-run", () => {
    const state: RevisionState = { index: 11, ranOutIds: [] };
    expect(revisionProgress(state, 34)).toEqual({
      current: 12,
      total: 34,
      finished: false,
    });
  });

  it("reports the very first card as 1 из total", () => {
    expect(revisionProgress(initialRevisionState, 5)).toEqual({
      current: 1,
      total: 5,
      finished: false,
    });
  });

  it("clamps current to total and marks finished once the deck is exhausted", () => {
    const state: RevisionState = { index: 5, ranOutIds: [] };
    expect(revisionProgress(state, 5)).toEqual({
      current: 5,
      total: 5,
      finished: true,
    });
  });

  it("treats an empty deck as immediately finished", () => {
    expect(revisionProgress(initialRevisionState, 0)).toEqual({
      current: 0,
      total: 0,
      finished: true,
    });
  });
});

describe("summarizeRevision", () => {
  it("reports «empty» when nothing ran out this run", () => {
    const state: RevisionState = { index: 5, ranOutIds: [] };
    expect(summarizeRevision(state)).toEqual({ kind: "empty" });
  });

  it("reports the count when something ran out this run", () => {
    const state: RevisionState = {
      index: 5,
      ranOutIds: ["butter", "eggs", "milk"],
    };
    expect(summarizeRevision(state)).toEqual({ kind: "counted", count: 3 });
  });
});
