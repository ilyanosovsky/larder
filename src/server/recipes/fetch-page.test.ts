import { describe, expect, it, vi } from "vitest";

import {
  decodeHtml,
  fetchPage,
  MAX_HTML_BYTES,
  type HostLookup,
} from "./fetch-page";

/** A resolver that answers every name with one public address. */
const publicLookup: HostLookup = () =>
  Promise.resolve([{ address: "93.184.216.34" }]);

function htmlResponse(
  body: string,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { "content-type": "text/html; charset=utf-8", ...init.headers },
  });
}

/**
 * A fetch that answers each call from the queue, in order — and records both
 * the URL and the `RequestInit` it was handed, because `redirect: "manual"`
 * and the deadline's signal are as much part of the contract as the response.
 */
function queuedFetch(responses: (Response | Error)[]) {
  const calls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];

  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    inits.push(init);
    const next = responses.shift();
    if (next === undefined) {
      throw new Error(`unexpected fetch of ${String(input)}`);
    }
    if (next instanceof Error) {
      return Promise.reject(next);
    }
    return Promise.resolve(next);
  }) as unknown as typeof globalThis.fetch;

  return { fetch: fetcher, calls, inits };
}

/** A fetch that must never run. */
const unusedFetch = (() => {
  throw new Error("fetch must not be called");
}) as unknown as typeof globalThis.fetch;

describe("fetchPage — the happy path", () => {
  it("returns the page and the URL it settled on", async () => {
    const { fetch, calls } = queuedFetch([
      htmlResponse("<html><body>рецепт</body></html>"),
    ]);

    const result = await fetchPage("https://povar.ru/recipes/1.html", {
      fetch,
      lookup: publicLookup,
    });

    expect(result).toEqual({
      kind: "html",
      html: "<html><body>рецепт</body></html>",
      finalUrl: "https://povar.ru/recipes/1.html",
    });
    expect(calls).toEqual(["https://povar.ru/recipes/1.html"]);
  });

  it("asks with `redirect: manual` and no credentials", async () => {
    // Manual redirects are the only way every hop gets re-validated, and a
    // recipe page is public or it is nothing.
    const { fetch, inits } = queuedFetch([htmlResponse("<html></html>")]);

    await fetchPage("https://povar.ru/r", { fetch, lookup: publicLookup });

    expect(inits[0]).toMatchObject({
      redirect: "manual",
      credentials: "omit",
    });
  });

  it("threads the deadline's signal into the request", async () => {
    const { fetch, inits } = queuedFetch([htmlResponse("<html></html>")]);
    const signal = AbortSignal.timeout(5_000);

    await fetchPage("https://povar.ru/r", {
      fetch,
      lookup: publicLookup,
      signal,
    });

    expect(inits[0]?.signal).toBe(signal);
  });
});

describe("fetchPage — the SSRF guard", () => {
  it("refuses a URL the classifier rejects, before DNS or a socket", async () => {
    const lookup = vi.fn(publicLookup);

    const result = await fetchPage("http://169.254.169.254/latest/", {
      fetch: unusedFetch,
      lookup,
    });

    expect(result).toEqual({ kind: "blocked" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses a public name that resolves to a private address", async () => {
    // The case a hostname blocklist cannot see: `127.0.0.1.nip.io` is an
    // entirely ordinary public name.
    const result = await fetchPage("https://127-0-0-1.nip.io/r", {
      fetch: unusedFetch,
      lookup: () => Promise.resolve([{ address: "127.0.0.1" }]),
    });

    expect(result).toEqual({ kind: "blocked" });
  });

  it("refuses when only ONE of several addresses is private", async () => {
    // A name resolving to one public and one private address is the whole
    // attack; checking `addresses[0]` alone waves it through half the time.
    const result = await fetchPage("https://mixed.example/r", {
      fetch: unusedFetch,
      lookup: () =>
        Promise.resolve([{ address: "93.184.216.34" }, { address: "10.0.0.7" }]),
    });

    expect(result).toEqual({ kind: "blocked" });
  });

  it("re-validates every redirect hop, not just the first URL", async () => {
    // The classic bypass: a public host that 302s to the metadata service.
    const { fetch, calls } = queuedFetch([
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      }),
    ]);

    const result = await fetchPage("https://recipes.example/r", {
      fetch,
      lookup: publicLookup,
    });

    expect(result).toEqual({ kind: "blocked" });
    // The redirect was read; the target was never requested.
    expect(calls).toEqual(["https://recipes.example/r"]);
  });

  it("re-resolves DNS on a redirect to a different public name", async () => {
    const lookup = vi.fn((hostname: string) =>
      Promise.resolve([
        { address: hostname === "inner.example" ? "10.0.0.9" : "93.184.216.34" },
      ]),
    );
    const { fetch } = queuedFetch([
      new Response(null, {
        status: 301,
        headers: { location: "https://inner.example/r" },
      }),
    ]);

    const result = await fetchPage("https://outer.example/r", {
      fetch,
      lookup,
    });

    expect(result).toEqual({ kind: "blocked" });
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("follows an ordinary redirect and reports the final URL", async () => {
    const { fetch, calls } = queuedFetch([
      new Response(null, {
        status: 301,
        headers: { location: "/recipes/canonical.html" },
      }),
      htmlResponse("<html>ok</html>"),
    ]);

    const result = await fetchPage("https://povar.ru/r", {
      fetch,
      lookup: publicLookup,
    });

    expect(result).toMatchObject({
      kind: "html",
      finalUrl: "https://povar.ru/recipes/canonical.html",
    });
    expect(calls).toHaveLength(2);
  });

  it("gives up after three hops rather than riding a redirect loop", async () => {
    const loop = () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://povar.ru/loop" },
      });
    const { fetch, calls } = queuedFetch([loop(), loop(), loop(), loop()]);

    const result = await fetchPage("https://povar.ru/loop", {
      fetch,
      lookup: publicLookup,
    });

    expect(result).toEqual({ kind: "unreachable" });
    expect(calls).toHaveLength(4);
  });

  it("treats a redirect with no Location as a dead end", async () => {
    const { fetch } = queuedFetch([new Response(null, { status: 302 })]);

    await expect(
      fetchPage("https://povar.ru/r", { fetch, lookup: publicLookup }),
    ).resolves.toEqual({ kind: "unreachable" });
  });
});

describe("fetchPage — what came back", () => {
  it("reports a DNS failure as unreachable", async () => {
    const result = await fetchPage("https://nowhere.example/r", {
      fetch: unusedFetch,
      lookup: () => Promise.reject(new Error("ENOTFOUND")),
    });

    expect(result).toEqual({ kind: "unreachable" });
  });

  it("reports an empty resolver answer as unreachable", async () => {
    const result = await fetchPage("https://nowhere.example/r", {
      fetch: unusedFetch,
      lookup: () => Promise.resolve([]),
    });

    expect(result).toEqual({ kind: "unreachable" });
  });

  it("reports a thrown request (timeout, TLS, reset) as unreachable", async () => {
    const { fetch } = queuedFetch([new Error("The operation was aborted")]);

    await expect(
      fetchPage("https://povar.ru/r", { fetch, lookup: publicLookup }),
    ).resolves.toEqual({ kind: "unreachable" });
  });

  it("keeps a server refusal apart from a dead host", async () => {
    // 403/429/503 map to «страница не отдала рецепт» and a dead host to «не
    // удалось прочитать страницу» — different S8.2 copy, so different kinds.
    const { fetch } = queuedFetch([htmlResponse("nope", { status: 403 })]);

    await expect(
      fetchPage("https://povar.ru/r", { fetch, lookup: publicLookup }),
    ).resolves.toEqual({ kind: "status", status: 403 });
  });

  it("refuses a non-HTML content type", async () => {
    const { fetch } = queuedFetch([
      new Response("%PDF-1.4", {
        headers: { "content-type": "application/pdf" },
      }),
    ]);

    await expect(
      fetchPage("https://povar.ru/r.pdf", { fetch, lookup: publicLookup }),
    ).resolves.toEqual({ kind: "notHtml" });
  });

  it("refuses a declared content-length past the cap without reading a byte", async () => {
    const body = vi.fn();
    const response = new Response("<html></html>", {
      headers: {
        "content-type": "text/html",
        "content-length": String(MAX_HTML_BYTES + 1),
      },
    });
    Object.defineProperty(response, "body", { get: body });

    const { fetch } = queuedFetch([response]);
    await expect(
      fetchPage("https://povar.ru/r", { fetch, lookup: publicLookup }),
    ).resolves.toEqual({ kind: "tooLarge" });
    expect(body).not.toHaveBeenCalled();
  });

  it("aborts a 5 MB body at the cap even when the header lied", async () => {
    // `content-length` is optional and can lie, so the running counter is the
    // actual limit — and the reader is cancelled rather than drained.
    const chunk = new Uint8Array(250_000);
    let emitted = 0;
    const cancel = vi.fn();

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= 20) {
          controller.close();
          return;
        }
        emitted += 1;
        controller.enqueue(chunk);
      },
      cancel,
    });

    const { fetch } = queuedFetch([
      new Response(stream, { headers: { "content-type": "text/html" } }),
    ]);

    await expect(
      fetchPage("https://povar.ru/huge", { fetch, lookup: publicLookup }),
    ).resolves.toEqual({ kind: "tooLarge" });

    // Stopped early: 5 MB would be twenty chunks, the cap is at nine.
    expect(emitted).toBeLessThan(12);
    expect(cancel).toHaveBeenCalled();
  });
});

describe("decodeHtml", () => {
  /** «Блины» in windows-1251 — the encoding russianfood.com still serves. */
  const cp1251 = new Uint8Array([0xc1, 0xeb, 0xe8, 0xed, 0xfb]);

  it("uses the charset from the content-type header", () => {
    expect(decodeHtml(cp1251, "text/html; charset=windows-1251")).toBe("Блины");
  });

  it("falls back to the document's own <meta charset>", () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<meta charset="windows-1251">'),
      ...cp1251,
    ]);

    expect(decodeHtml(bytes, "text/html")).toContain("Блины");
  });

  it("decodes UTF-8 when nothing says otherwise", () => {
    expect(decodeHtml(new TextEncoder().encode("Блины"), null)).toBe("Блины");
  });

  it("falls back to UTF-8 for an encoding the runtime does not know", () => {
    // Better a readable page than a thrown RangeError with no failure branch.
    expect(
      decodeHtml(new TextEncoder().encode("Блины"), "text/html; charset=x-mac-cyrillic-typo"),
    ).toBe("Блины");
  });

  it("reads the real windows-1251 page end to end", async () => {
    // The whole reason this exists: `Response.text()` would decode
    // russianfood.com as UTF-8 and hand the model replacement characters.
    const bytes = new TextEncoder().encode("<html><body>Гуляш</body></html>");
    const russian = new Uint8Array([
      ...bytes.slice(0, 12),
      0xc3,
      0xf3,
      0xeb,
      0xff,
      0xf8,
      ...new TextEncoder().encode("</body></html>"),
    ]);

    const { fetch } = queuedFetch([
      new Response(russian, {
        headers: { "content-type": "text/html; charset=windows-1251" },
      }),
    ]);

    const result = await fetchPage("https://www.russianfood.com/r", {
      fetch,
      lookup: publicLookup,
    });

    expect(result.kind === "html" && result.html).toContain("Гуляш");
  });
});
