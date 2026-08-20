/**
 * Validates that `orderedIds` is a permutation of `existingIds` — the same
 * set, each id once, in the caller's new order. `category.reorder` runs
 * this before writing anything, so a stale or tampered id list is rejected
 * outright instead of silently dropping a category or crashing on a
 * dangling `sortOrder` update.
 *
 * Pure and framework-free on purpose: the router owns turning a bad
 * permutation into a `BAD_REQUEST`, this only decides whether it is one.
 * A foreign household's id can never legitimately appear here — the
 * caller always compares against its own household's id set — so that
 * case is just the ordinary "extra id" rejection, not a distinct branch.
 */
export interface PermutationCheck {
  ok: boolean;
  /** Present only when `ok` is false, for an actionable error message. */
  reason?: "missingIds" | "unknownIds" | "duplicateIds";
}

export function checkReorderPermutation(
  orderedIds: readonly string[],
  existingIds: readonly string[],
): PermutationCheck {
  const existing = new Set(existingIds);

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const unknown = new Set<string>();

  for (const id of orderedIds) {
    if (seen.has(id)) {
      duplicates.add(id);
    }
    seen.add(id);

    if (!existing.has(id)) {
      unknown.add(id);
    }
  }

  if (duplicates.size > 0) {
    return { ok: false, reason: "duplicateIds" };
  }
  if (unknown.size > 0) {
    return { ok: false, reason: "unknownIds" };
  }
  if (seen.size !== existing.size) {
    return { ok: false, reason: "missingIds" };
  }

  return { ok: true };
}
