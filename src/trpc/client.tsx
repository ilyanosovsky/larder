"use client";

import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import type { QueryClient } from "@tanstack/react-query";
import {
  createTRPCClient,
  httpBatchStreamLink,
  loggerLink,
  splitLink,
  type TRPCClient,
} from "@trpc/client";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import { useState, type ReactNode } from "react";
import superjson from "superjson";

import { primeOnlineManager } from "@/lib/sync/use-is-online";
import type { AppRouter } from "@/server/api/root";

import {
  createInertPersistOptions,
  installOfflineQueue,
  type OfflinePersistOptions,
} from "./offline-queue";
import { makeQueryClient } from "./query-client";

/**
 * `useTRPC()` is how client components reach the API:
 * `useQuery(useTRPC().health.ping.queryOptions())`. This is the current tRPC
 * v11 integration (`@trpc/tanstack-react-query`), which builds TanStack Query
 * option objects instead of wrapping the hooks like the legacy
 * `@trpc/react-query` proxy did.
 */
export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();

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

function makeTRPCClient(): TRPCClient<AppRouter> {
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
}

/** Everything the providers below need, built once per environment. */
interface ClientRuntime {
  queryClient: QueryClient;
  trpcClient: TRPCClient<AppRouter>;
  persistOptions: OfflinePersistOptions;
  onRestored: () => Promise<void>;
}

let browserRuntime: ClientRuntime | undefined;

function getRuntime(): ClientRuntime {
  if (typeof window === "undefined") {
    // Server: a fresh client per render, so two requests never share a cache,
    // and a persister that stores nothing — see `createInertPersistOptions`.
    return {
      queryClient: makeQueryClient(),
      trpcClient: makeTRPCClient(),
      persistOptions: createInertPersistOptions(),
      onRestored: () => Promise.resolve(),
    };
  }

  // Browser: one of everything for the tab's lifetime. Built lazily (rather
  // than in useState) so it stays stable across a suspended first render, and
  // so the offline queue's listeners are installed exactly once.
  if (browserRuntime === undefined) {
    // Before anything can dispatch a mutation: a tab loaded while offline
    // must join the queue rather than fail outright.
    primeOnlineManager();

    const queryClient = makeQueryClient();
    const trpcClient = makeTRPCClient();
    const queue = installOfflineQueue(queryClient, trpcClient);

    browserRuntime = {
      queryClient,
      trpcClient,
      persistOptions: queue.persistOptions,
      onRestored: queue.flush,
    };
  }

  return browserRuntime;
}

export function TRPCReactProvider({ children }: { children: ReactNode }) {
  const [runtime] = useState(getRuntime);

  return (
    // `PersistQueryClientProvider` in place of `QueryClientProvider`: it is
    // the same provider plus a restore-from-storage effect and an
    // `isRestoring` context. Rendered on the server too (with an inert
    // persister) so both sides agree on that context — see
    // `createInertPersistOptions`. `onSuccess` is the one moment a queue read
    // back from IndexedDB exists in memory but has not been delivered yet.
    <PersistQueryClientProvider
      client={runtime.queryClient}
      persistOptions={runtime.persistOptions}
      onSuccess={runtime.onRestored}
    >
      <TRPCProvider
        trpcClient={runtime.trpcClient}
        queryClient={runtime.queryClient}
      >
        {children}
      </TRPCProvider>
    </PersistQueryClientProvider>
  );
}
