/**
 * The letter an avatar falls back to when there is no picture — the first
 * grapheme of a name, upper-cased.
 *
 * `Intl.Segmenter` rather than `.charAt(0)` or a code-point spread: a name
 * that starts with an astral emoji is two UTF-16 code units for one visual
 * character, and `.charAt(0)` would hand back half of it — a lone surrogate
 * that renders as a broken glyph. Grapheme segmentation is also what keeps a
 * combining accent attached to the letter it modifies.
 *
 * Shared between the header's own avatars (`app-header.tsx`) and the cart
 * row's «кто берёт» avatar (task 2.5), so the two never quietly disagree
 * about which letter represents the same person.
 */

// Module-scoped: a grapheme segmenter holds no per-call state, and this
// function runs once per row with a buyer (and once per header avatar) on
// every render, so building a fresh ICU segmenter each time would be pure
// waste.
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function avatarInitial(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") {
    // No name to take a letter from — the header's own placeholder for "no
    // picture, nothing to show either".
    return "?";
  }

  const first = GRAPHEMES.segment(trimmed)[Symbol.iterator]().next().value;
  return (first?.segment ?? trimmed).toUpperCase();
}
