/**
 * How to shrink a photo before it is uploaded (blueprint §3.1) — the
 * decisions, with no DOM in sight.
 *
 * A phone screenshot is 1–4 MB and 1170×2532; the model reads it at
 * `detail: "high"`, which downsamples anything past ~1536 px anyway, and the
 * same file becomes `dishes.photo_url` on a card that renders it at a few
 * hundred CSS pixels. Uploading the original would spend the household's
 * storage tier and the user's mobile data on pixels nothing ever looks at.
 *
 * The rules live here, apart from `compress.ts`'s canvas work, because *this*
 * is the part with edge cases (an already-small image, a panorama, a file
 * that is small but enormous in pixels) and the part a test can pin without a
 * browser.
 */

/**
 * The longest side we keep. Comfortably above what `detail: "high"` uses, so
 * the resize never costs the model a digit it would otherwise have read.
 */
export const MAX_IMAGE_SIDE = 1600;

/** What we aim for. Roughly a tenth of a phone screenshot, still legible. */
export const TARGET_BYTES = 300 * 1024;

/**
 * Past this we do not even try: `createImageBitmap` decodes the whole thing
 * into memory first, and a 30 MP panorama on a mid-range phone is where the
 * tab dies. It is also the UploadThing route's own ceiling.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

/**
 * The quality ladder, descending and finite.
 *
 * Four attempts, never below 0.5: past that JPEG artefacts start eating the
 * small digits the whole import depends on, and the honest move is to upload
 * a slightly larger file rather than a smaller unreadable one. Bounded rather
 * than a binary search because each attempt is a real encode of a multi-
 * megapixel bitmap on a phone, and four is already ~1 s of main-thread work.
 */
export const QUALITY_LADDER = [0.82, 0.7, 0.6, 0.5] as const;

export interface CompressionPlan {
  /** Target width in device pixels — equal to the input when no resize is needed. */
  readonly width: number;
  readonly height: number;
  /** Whether the bitmap has to be scaled down at all. */
  readonly resize: boolean;
  /** Encode attempts, in order; stop at the first result under `TARGET_BYTES`. */
  readonly qualities: readonly number[];
  /**
   * `true` when the file is already small enough in both bytes and pixels —
   * the caller uploads it untouched, which also side-steps the one path where
   * a re-encode could lose EXIF orientation.
   */
  readonly skip: boolean;
}

export interface ImageFacts {
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

/**
 * What to do with one image.
 *
 * Aspect ratio is preserved exactly, and the scaled side is rounded up to at
 * least 1 px: a 4000×1 panorama must not scale to a zero-height canvas, which
 * `drawImage` treats as an error rather than as a no-op.
 */
export function pickCompressionPlan({
  width,
  height,
  bytes,
}: ImageFacts): CompressionPlan {
  const longest = Math.max(width, height);
  const resize = longest > MAX_IMAGE_SIDE && longest > 0;

  const scale = resize ? MAX_IMAGE_SIDE / longest : 1;
  const targetWidth = resize ? Math.max(1, Math.round(width * scale)) : width;
  const targetHeight = resize
    ? Math.max(1, Math.round(height * scale))
    : height;

  // Already small in both senses: nothing an encode could improve, and every
  // re-encode is a chance to lose something.
  const skip = !resize && bytes <= TARGET_BYTES;

  return {
    width: targetWidth,
    height: targetHeight,
    resize,
    qualities: skip ? [] : [...QUALITY_LADDER],
    skip,
  };
}

/**
 * Whether a file may be uploaded as-is when compression could not run at all
 * — HEIC on desktop Chrome, a canvas the browser refused to read back (R6).
 *
 * The honest fallback is the original file when the route will accept it, and
 * the photo error when it will not. Guessing at a smaller re-encode we could
 * not produce is not an option.
 */
export function canUploadOriginal(bytes: number): boolean {
  return bytes > 0 && bytes <= MAX_UPLOAD_BYTES;
}
