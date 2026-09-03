import { generateReactHelpers } from "@uploadthing/react";

import type { LarderFileRouter } from "@/server/uploadthing";

/**
 * The browser's typed handle on the upload route (task 4.3).
 *
 * `import type` on the server module is deliberate and load-bearing:
 * `src/server/uploadthing.ts` starts with `import "server-only"`, and a value
 * import would break the client build. A type-only import is erased, so all
 * that crosses the boundary is the route's shape — which is exactly what
 * `useUploadThing("dishPhoto")` needs to know what `serverData` contains.
 *
 * The endpoint defaults to `/api/uploadthing`, matching the route handler.
 */
export const { useUploadThing } = generateReactHelpers<LarderFileRouter>();
