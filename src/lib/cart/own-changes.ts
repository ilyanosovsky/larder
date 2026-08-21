/**
 * Which rows *this* client changed a moment ago, so the «мягкая подсветка»
 * keeps meaning what it says.
 *
 * The highlight (VISION §6.3, mockup 1b) exists to answer «партнёр что-то
 * поменял». `useChangedRows` cannot tell whose change it is looking at — it
 * only diffs `updatedAt` across refetches — and every optimistic toggle ends
 * with the server stamping `now()` on the row and the screen invalidating.
 * That refetch reports your own tick as a change, and the row lights up at
 * you for something you did yourself. Muting the ids this client wrote is
 * what keeps the cue honest.
 *
 * Deliberately time-bounded rather than consume-on-first-sight: `changedIds`
 * stays populated for the whole highlight window, so a mark that cleared on
 * first observation would simply let the highlight reappear on the next
 * render. The cost of the window is that a *partner's* change to the same row
 * inside it is muted too — a few seconds of silence on one row, against a
 * false "someone else touched this" on every single tap.
 */

/**
 * Records that this client just wrote `id`, and drops any mark that has
 * already expired.
 *
 * Mutates `marks` in place: it lives in a ref for the lifetime of the screen,
 * and the pruning is what keeps it from growing with every tap of a long
 * shopping trip. Writes only ever happen in event handlers, never in render.
 */
export function markOwnChange(
  marks: Map<string, number>,
  id: string,
  now: number,
  ttlMs: number,
): void {
  for (const [markedId, expiresAt] of marks) {
    if (expiresAt <= now) {
      marks.delete(markedId);
    }
  }
  marks.set(id, now + ttlMs);
}

/**
 * `changedIds` minus whatever this client changed itself and still holds a
 * live mark for. Pure — safe to call during render.
 *
 * Returns `changedIds` itself, same reference, when nothing is suppressed:
 * that is the overwhelmingly common case (no marks at all, or a diff about
 * someone else's row), and a fresh `Set` every render would be churn for
 * nothing.
 */
export function withoutOwnChanges(
  changedIds: ReadonlySet<string>,
  marks: ReadonlyMap<string, number>,
  now: number,
): ReadonlySet<string> {
  if (marks.size === 0 || changedIds.size === 0) {
    return changedIds;
  }

  let remaining: Set<string> | undefined;
  for (const id of changedIds) {
    const expiresAt = marks.get(id);
    if (expiresAt !== undefined && expiresAt > now) {
      remaining ??= new Set(changedIds);
      remaining.delete(id);
    }
  }

  return remaining ?? changedIds;
}
