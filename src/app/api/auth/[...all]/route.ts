import { toNextJsHandler } from "better-auth/next-js";

import { auth } from "@/lib/auth";

// `toNextJsHandler` also accepts a bare request handler, which is what keeps
// `auth()` lazy: the singleton is built on the first request, not when this
// module is imported (a `next build` with no environment variables must not
// touch env — see src/lib/auth.ts).
export const { GET, POST } = toNextJsHandler((request: Request) =>
  auth().handler(request),
);
