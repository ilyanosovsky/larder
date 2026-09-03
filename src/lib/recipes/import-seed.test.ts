import { describe, expect, it } from "vitest";

import { recipeDraftSchema } from "@/lib/recipes/draft";

import { draftFromPartial } from "./import-seed";

const NOTHING = {
  title: null,
  photoUrl: null,
  photoKey: null,
  sourceUrl: null,
};

describe("draftFromPartial", () => {
  it("keeps the photo a failed photo import already uploaded", () => {
    const draft = draftFromPartial({
      ...NOTHING,
      title: "NYC Cookies",
      photoUrl: "https://app1.ufs.sh/f/abc",
      photoKey: "abc",
    });

    expect(draft).toMatchObject({
      title: "NYC Cookies",
      photoUrl: "https://app1.ufs.sh/f/abc",
      photoKey: "abc",
      sourceType: "photo",
      sourceUrl: null,
    });
  });

  it("keeps the URL a failed page import salvaged", () => {
    // The regression this exists for: the URL reached this screen, was
    // dropped, and the saved dish claimed it had been typed by hand — with
    // no «Источник» link and no field to type the link back into.
    const draft = draftFromPartial({
      ...NOTHING,
      title: "Блины на молоке",
      sourceUrl: "https://povar.ru/recipes/bliny_na_moloke-473.html",
    });

    expect(draft).toMatchObject({
      title: "Блины на молоке",
      sourceType: "url",
      sourceUrl: "https://povar.ru/recipes/bliny_na_moloke-473.html",
    });
  });

  it("calls a dish with nothing salvaged what it is", () => {
    // A failed *text* import carries no URL and no photo, so the honest
    // answer is the one the form would give anyway.
    expect(draftFromPartial(NOTHING)).toMatchObject({
      title: "",
      sourceType: "manual",
      sourceUrl: null,
      photoKey: null,
    });
  });

  it("prefers the photo when both survived", () => {
    expect(
      draftFromPartial({
        ...NOTHING,
        photoKey: "abc",
        photoUrl: "https://app1.ufs.sh/f/abc",
        sourceUrl: "https://povar.ru/x",
      }).sourceType,
    ).toBe("photo");
  });

  it("produces something the form can actually save", () => {
    // The seed goes straight into `DishForm`, whose save runs the draft
    // through this schema; a seed the schema refuses is a dead end at the
    // end of the road out of a dead end.
    for (const partial of [
      NOTHING,
      { ...NOTHING, title: "Борщ", sourceUrl: "https://povar.ru/x" },
      { ...NOTHING, title: "Борщ", photoKey: "abc", photoUrl: "https://x/f/a" },
    ]) {
      const draft = draftFromPartial(partial);
      // An empty title is what `emptyDraft()` starts with too — the form
      // requires one before it will save, which is a field to fill, not a
      // silent refusal.
      expect(
        recipeDraftSchema.safeParse({ ...draft, title: draft.title || "Блюдо" })
          .success,
      ).toBe(true);
    }
  });
});
