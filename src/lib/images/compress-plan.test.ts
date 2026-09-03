import { describe, expect, it } from "vitest";

import {
  canUploadOriginal,
  MAX_IMAGE_SIDE,
  MAX_UPLOAD_BYTES,
  pickCompressionPlan,
  QUALITY_LADDER,
  TARGET_BYTES,
} from "@/lib/images/compress-plan";

describe("pickCompressionPlan", () => {
  it("leaves an already-small image alone", () => {
    const plan = pickCompressionPlan({
      width: 800,
      height: 600,
      bytes: 90_000,
    });

    expect(plan).toEqual({
      width: 800,
      height: 600,
      resize: false,
      qualities: [],
      skip: true,
    });
  });

  it("re-encodes a small-but-heavy image without resizing it", () => {
    // A 900 px PNG screenshot can easily be 2 MB; the pixels are fine, the
    // bytes are not.
    const plan = pickCompressionPlan({
      width: 900,
      height: 1200,
      bytes: 2_000_000,
    });

    expect(plan.resize).toBe(false);
    expect(plan.skip).toBe(false);
    expect(plan.width).toBe(900);
    expect(plan.qualities).toEqual([...QUALITY_LADDER]);
  });

  it("caps the longest side and preserves the aspect ratio", () => {
    const plan = pickCompressionPlan({
      width: 4032,
      height: 3024,
      bytes: 3_500_000,
    });

    expect(plan.resize).toBe(true);
    expect(Math.max(plan.width, plan.height)).toBe(MAX_IMAGE_SIDE);
    expect(plan.width / plan.height).toBeCloseTo(4032 / 3024, 2);
  });

  it("caps a portrait screenshot by its height", () => {
    const plan = pickCompressionPlan({
      width: 1170,
      height: 2532,
      bytes: 3_000_000,
    });

    expect(plan.height).toBe(MAX_IMAGE_SIDE);
    expect(plan.width).toBe(Math.round((1170 * MAX_IMAGE_SIDE) / 2532));
  });

  it("never produces a zero-sized canvas for an extreme aspect ratio", () => {
    // `drawImage` onto a 0-height canvas throws rather than doing nothing.
    const plan = pickCompressionPlan({
      width: 4000,
      height: 1,
      bytes: 500_000,
    });

    expect(plan.width).toBe(MAX_IMAGE_SIDE);
    expect(plan.height).toBeGreaterThanOrEqual(1);
  });

  it("resizes even when the file is already under the byte target", () => {
    // A 4000 px PNG of a flat colour can be 40 KB. The pixels still cost the
    // model tokens and the card nothing.
    const plan = pickCompressionPlan({
      width: 4000,
      height: 3000,
      bytes: 40_000,
    });

    expect(plan.resize).toBe(true);
    expect(plan.skip).toBe(false);
  });

  it("treats exactly the target size as small enough", () => {
    const plan = pickCompressionPlan({
      width: 1000,
      height: 1000,
      bytes: TARGET_BYTES,
    });

    expect(plan.skip).toBe(true);
  });
});

describe("the quality ladder", () => {
  it("descends, is finite, and never goes below 0.5", () => {
    // Past 0.5 the artefacts start eating the small digits the whole import
    // depends on — a larger readable file beats a smaller unreadable one.
    expect(QUALITY_LADDER.length).toBeLessThanOrEqual(4);
    expect(Math.min(...QUALITY_LADDER)).toBeGreaterThanOrEqual(0.5);
    expect(Math.max(...QUALITY_LADDER)).toBeLessThanOrEqual(1);

    const descending = [...QUALITY_LADDER].every(
      (quality, index, all) => index === 0 || quality < (all[index - 1] ?? 1),
    );
    expect(descending).toBe(true);
  });
});

describe("canUploadOriginal", () => {
  it("accepts a file the route would accept", () => {
    expect(canUploadOriginal(3_000_000)).toBe(true);
    expect(canUploadOriginal(MAX_UPLOAD_BYTES)).toBe(true);
  });

  it("refuses one past the route's own ceiling", () => {
    expect(canUploadOriginal(MAX_UPLOAD_BYTES + 1)).toBe(false);
  });

  it("refuses an empty file", () => {
    expect(canUploadOriginal(0)).toBe(false);
  });
});
