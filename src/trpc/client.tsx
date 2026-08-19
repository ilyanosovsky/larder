"use client";

import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import {
  createTRPCClient,
  httpBatchStreamLink,
  loggerLink,
  splitLink,
} from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import { useState, type ReactNode } from "react";
import superjson from "superjson";

import type { AppRouter } from "@/server/api/root";

import { makeQueryClient } from "./query-client";

/**
 * `useTRPC()` is how client components reach the API:
 * `useQuery(useTRPC().health.ping.queryOptions())`. This is the current tRPC
 * v11 integration (`@trpc/tanstack-react-query`), which builds TanStack Query
 * option objects instead of wrapping the hooks like the legacy
 * `@trpc/react-query` proxy did.
 */
export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();

let browserQueryClient: QueryClient | undefined;

function getQueryClient(): QueryClient {
  if (typeof window === "undefined") {
    // Server: a fresh client per render, so two requests never share a cache.
    return makeQueryClient();
  }
  // Browser: one client for the tab's lifetime. Creating it lazily (rather
  // than in useState) keeps it stable across a suspended first render.
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}

/**
 * Absolute during SSR, relative in the browser.
 *
 * `process.env` is read directly instead of through `env()`: this module also
 * runs in the browser bundle, and `env()` is server-only and throws when a
 * variable is missing — which would break a build that has no environment at
 * all. Only `NEXT_PUBLIC_*` is ever inlined into the client bundle; the
 * `BETTER_AUTH_URL` branch is unreachable there and resolves to undefined.
 */
function getBaseUrl(): string {
  if (typeof window !== "undefined") {
    return "";
  }

  return (
    process.env.BETTER_AUTH_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    `http://localhost:${process.env.PORT ?? 3000}`
  );
}

function getUrl(): string {
  return `${getBaseUrl()}/api/trpc`;
}

export function TRPCReactProvider({ children }: { children: ReactNode }) {
  const queryClient = getQueryClient();
  const [trpcClient] = useState(() => {
    const batchLink = httpBatchStreamLink({
      transformer: superjson,
      url: getUrl(),
    });

    return createTRPCClient<AppRouter>({
      links: [
        loggerLink({
          enabled: (op) =>
            process.env.NODE_ENV === "development" ||
            (op.direction === "down" && op.result instanceof Error),
        }),
        splitLink({
          condition: (op) => op.type === "subscription",
          // TODO(task 2.2): realtime household channel (VISION §6.3). Replace
          // this branch with
          //   httpSubscriptionLink({ transformer: superjson, url: getUrl() })
          // when the first `subscription` procedure lands. The split is
          // already here so that change stays a one-liner; until then the
          // router exposes no subscriptions, so this branch is unreachable
          // and falls back to the same batching link.
          true: batchLink,
          false: batchLink,
        }),
      ],
    });
  });

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
