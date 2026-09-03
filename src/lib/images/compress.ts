import {
  canUploadOriginal,
  pickCompressionPlan,
  TARGET_BYTES,
} from "@/lib/images/compress-plan";

/**
 * The browser half of photo compression — canvas work only, with every
 * decision delegated to `compress-plan.ts`.
 *
 * Deliberately thin and deliberately untested by vitest: there is no jsdom in
 * this repo (and `createImageBitmap`/`toBlob` are not in jsdom anyway), so the
 * rules that *can* be tested were moved out rather than tested through a
 * simulated canvas that would prove nothing about Safari.
 *
 * **JPEG in, JPEG out — not WebP.** Safari's WebP encoder support has been a
 * moving target, and the input here is a HEIC or PNG screenshot either way;
 * one output format means one thing to debug when a photo comes out wrong.
 *
 * **`imageOrientation: "from-image"` is requested but not relied on.** It is
 * what keeps a rotated iPhone capture upright, and it is widely supported —
 * but the main path (VISION scenario Б) is a screenshot, which carries no
 * EXIF rotation at all, so a browser that ignores the hint costs nothing on
 * the road that matters.
 */

export type CompressOutcome =
  | { readonly ok: true; readonly file: File }
  /** Nothing could be produced *and* the original is too big to send as-is. */
  | { readonly ok: false; readonly reason: "tooLarge" | "notAnImage" };

/**
 * Shrinks a picked file toward ~300 KB, falling back to the original.
 *
 * The fallback is the point of the whole function: `createImageBitmap`
 * decodes HEIC through the system decoder on Safari and simply fails on
 * desktop Chrome (R6), and a canvas can be refused entirely. When any of that
 * happens the original file is uploaded if the route would take it, and only
 * a file that is *both* undecodable and oversized becomes an error the user
 * sees.
 */
export async function compressImage(file: File): Promise<CompressOutcome> {
  if (!file.type.startsWith("image/")) {
    return { ok: false, reason: "notAnImage" };
  }

  const compressed = await tryCompress(file);
  if (compressed) {
    return { ok: true, file: compressed };
  }

  return canUploadOriginal(file.size)
    ? { ok: true, file }
    : { ok: false, reason: "tooLarge" };
}

async function tryCompress(file: File): Promise<File | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return null;
  }

  try {
    const plan = pickCompressionPlan({
      width: bitmap.width,
      height: bitmap.height,
      bytes: file.size,
    });

    if (plan.skip) {
      return null;
    }

    const canvas = document.createElement("canvas");
    canvas.width = plan.width;
    canvas.height = plan.height;

    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }
    context.drawImage(bitmap, 0, 0, plan.width, plan.height);

    let best: Blob | null = null;
    for (const quality of plan.qualities) {
      const blob = await toBlob(canvas, quality);
      if (!blob) {
        break;
      }
      // Kept even when it is still over target: the last rung of the ladder
      // is the smallest we are willing to produce, and a 400 KB readable JPEG
      // beats both the 3 MB original and a 200 KB unreadable one.
      best = blob;
      if (blob.size <= TARGET_BYTES) {
        break;
      }
    }

    if (!best || best.size >= file.size) {
      // A "compression" that made the file bigger — a small PNG re-encoded as
      // JPEG, say — is not a compression.
      return null;
    }

    return new File([best], jpegName(file.name), {
      type: "image/jpeg",
      lastModified: Date.now(),
    });
  } catch {
    return null;
  } finally {
    // Frees the decoded bitmap immediately rather than at the next GC — this
    // runs on a phone holding a multi-megapixel image in memory.
    bitmap.close();
  }
}

function toBlob(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
  });
}

/** Keeps the user's own filename, with an extension that matches the bytes. */
function jpegName(name: string): string {
  const base = name.replace(/\.[^./\\]+$/, "").trim();
  return `${base.length > 0 ? base : "recipe"}.jpg`;
}
