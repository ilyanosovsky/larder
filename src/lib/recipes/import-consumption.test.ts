import { describe, expect, it } from "vitest";

import {
  consumableJobId,
  consumedDishIdOf,
} from "@/lib/recipes/import-consumption";
import type { ImportResultOutput } from "@/server/api/routers/dish-import";

const JOB_ID = "3f1a6d0e-0000-4000-8000-000000000501";
const DISH_ID = "3f1a6d0e-0000-4000-8000-000000000601";

const partial = {
  title: null,
  photoUrl: null,
  photoKey: "aBcD1234_-key",
  sourceUrl: null,
};

function failed(consumedDishId: string | null = null): ImportResultOutput {
  return {
    outcome: "failed",
    jobId: JOB_ID,
    reason: "notARecipe",
    partial,
    consumedDishId,
  };
}

function parsedResult(
  consumedDishId: string | null = null,
): ImportResultOutput {
  return {
    outcome: "parsed",
    jobId: JOB_ID,
    via: "vision",
    warnings: [],
    consumedDishId,
    draft: {
      title: "NYC Cookies",
      photoUrl: null,
      photoKey: null,
      tags: [],
      sourceType: "photo",
      sourceUrl: null,
      portionsBase: 8,
      portionsMin: null,
      yieldUnit: null,
      totalTimeMin: null,
      equipment: [],
      ingredients: [],
      steps: [],
    },
  };
}

const running: ImportResultOutput = {
  outcome: "running",
  jobId: JOB_ID,
  partial,
};

describe("consumableJobId", () => {
  it("consumes a failed import that has not been saved yet", () => {
    // The one path that actually reaches `/dishes/new?from=`: «создать
    // вручную» out of S8.2.
    expect(consumableJobId(failed(), JOB_ID)).toBe(JOB_ID);
  });

  it("refuses a failed import that already became a dish", () => {
    // Saving stamps the job and invalidates the cache, so a Back onto this
    // screen re-prefills from it. A second save would mint a duplicate dish
    // carrying the first one's photo_key and repoint `consumedDishId` at the
    // copy, leaving `/dishes/import/<jobId>` redirecting to the duplicate.
    expect(consumableJobId(failed(DISH_ID), JOB_ID)).toBeNull();
  });

  it("refuses a parsed import — that draft has its own review route", () => {
    // `/dishes/new` opens a *blank* form for a parsed job, so stamping it
    // would consume the recipe without ever saving it.
    expect(consumableJobId(parsedResult(), JOB_ID)).toBeNull();
  });

  it("refuses a job that is still running", () => {
    expect(consumableJobId(running, JOB_ID)).toBeNull();
  });

  it("refuses when the job has not loaded, or there is no job at all", () => {
    expect(consumableJobId(undefined, JOB_ID)).toBeNull();
    expect(consumableJobId(failed(), null)).toBeNull();
  });
});

describe("consumedDishIdOf", () => {
  it("reports the dish a failed or parsed job became", () => {
    expect(consumedDishIdOf(failed(DISH_ID))).toBe(DISH_ID);
    expect(consumedDishIdOf(parsedResult(DISH_ID))).toBe(DISH_ID);
  });

  it("is null for an unconsumed job", () => {
    expect(consumedDishIdOf(failed())).toBeNull();
    expect(consumedDishIdOf(parsedResult())).toBeNull();
  });

  it("never calls a running job consumed", () => {
    // It has not finished deciding what it is.
    expect(consumedDishIdOf(running)).toBeNull();
  });

  it("is null before the job has loaded", () => {
    expect(consumedDishIdOf(undefined)).toBeNull();
  });
});
