import { Suspense } from "react";

import { ImportScreen } from "./import-screen";

/**
 * S8.1 «Новое блюдо» + S8.2 «Разбираю рецепт…» (DESIGN_BRIEF S8).
 *
 * **Nothing is prefetched**, and there is nothing to hydrate: until a file is
 * chosen this screen is pure UI. The import itself is a mutation whose result
 * goes straight into the TanStack cache on the client, and the *draft* is
 * read back on `/dishes/import/[jobId]`, which does prefetch.
 *
 * `useSearchParams` (for `?src=photo`) opts the client component into a
 * Suspense boundary; without an explicit one Next would bail the whole route
 * out of static rendering with a build-time error.
 */
export default function ImportPage() {
  return (
    <Suspense>
      <ImportScreen />
    </Suspense>
  );
}
