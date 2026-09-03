import { afterEach, describe, expect, it, vi } from "vitest";

import {
  condenseMarkdown,
  FIRECRAWL_ENDPOINT,
  firecrawlScrape,
  MAX_MARKDOWN_CHARS,
  MIN_MARKDOWN_CHARS,
  parseFirecrawlResponse,
} from "./firecrawl";

/** Long enough to clear the "this was a cookie banner" floor. */
const MARKDOWN = `# Гуляш\n\n${"Говядина — 1 кг. ".repeat(30)}`;

function ok(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that records the request it was handed and answers with `body`. */
function recordingFetch(body: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];

  const fetcher = ((url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(body());
  }) as unknown as typeof globalThis.fetch;

  return { fetch: fetcher, calls };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseFirecrawlResponse — the shape guard (R7)", () => {
  it("returns the markdown from a well-formed answer", () => {
    const result = parseFirecrawlResponse({
      success: true,
      data: { markdown: MARKDOWN },
    });

    expect(result).toEqual({ ok: true, markdown: MARKDOWN.trim() });
  });

  it("ignores fields FireCrawl adds later", () => {
    // Additive API changes must not break an import; only a *missing*
    // `data.markdown` is the failure this schema exists to catch.
    expect(
      parseFirecrawlResponse({
        success: true,
        warning: null,
        data: { markdown: MARKDOWN, html: "<h1/>", metadata: { title: "x" } },
      }).ok,
    ).toBe(true);
  });

  it.each([
    ["success: false", { success: false, data: { markdown: MARKDOWN } }],
    ["no data.markdown", { success: true, data: { html: "<h1/>" } }],
    ["markdown of the wrong type", { success: true, data: { markdown: 42 } }],
    ["no data at all", { success: true }],
    ["an error envelope", { error: "Payment required" }],
    ["garbage", "not json at all"],
    ["null", null],
  ])("maps %s to a blocked page, never a stack trace", (_label, json) => {
    expect(parseFirecrawlResponse(json)).toEqual({
      ok: false,
      reason: "blocked",
    });
  });

  it("pins the floor that keeps a thin page off the model's bill", () => {
    // Either side of the `<`, against the exported constant. Without this the
    // threshold could drop from 200 to 10 — forwarding cookie banners to a
    // billed call that comes back «это не рецепт» — with nothing failing.
    // A run of «я» has no markup, so `condenseMarkdown` leaves the length
    // exactly where the test put it.
    expect(
      parseFirecrawlResponse({
        success: true,
        data: { markdown: "я".repeat(MIN_MARKDOWN_CHARS - 1) },
      }),
    ).toEqual({ ok: false, reason: "empty" });

    expect(
      parseFirecrawlResponse({
        success: true,
        data: { markdown: "я".repeat(MIN_MARKDOWN_CHARS) },
      }).ok,
    ).toBe(true);
  });

  it("separates «nothing on the page» from «refused»", () => {
    // A scrape that succeeded and returned a cookie banner is
    // `noRecipeOnPage`, not `pageBlocked`: the page was reachable.
    expect(
      parseFirecrawlResponse({ success: true, data: { markdown: "Cookies" } }),
    ).toEqual({ ok: false, reason: "empty" });
  });

  it("condenses the scrape before truncating it", () => {
    // The bug this exists for: russianfood.com's scrape is 58 000 characters
    // of table-layout markdown whose first twelve thousand are the logo, the
    // menu and a login box. Truncating *that* handed the model a navigation
    // bar and got back «на этой странице нет рецепта» for a page with a
    // perfectly good recipe on it.
    const chrome =
      "| [Рецепты](https://x/r) | [Войти](https://x/l) |\n| --- | --- |\n".repeat(
        400,
      );
    const recipe = `# Гуляш\n\n| Говядина – 1 кг |\n| Лук репчатый – 600 г |\n${"Тушим два часа. ".repeat(20)}`;

    const result = parseFirecrawlResponse({
      success: true,
      data: { markdown: chrome + recipe },
    });

    expect(result.ok).toBe(true);
    expect(result.ok && result.markdown).toContain("Говядина – 1 кг");
    expect(result.ok && result.markdown).toContain("Лук репчатый – 600 г");
  });

  it("truncates a very long page before the model is billed for it", () => {
    const result = parseFirecrawlResponse({
      success: true,
      data: { markdown: "я".repeat(50_000) },
    });

    expect(result.ok && result.markdown.length).toBe(MAX_MARKDOWN_CHARS);
  });
});

describe("firecrawlScrape", () => {
  it("posts the documented body with the bearer read at call time", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test-key");
    const { fetch, calls } = recordingFetch(() =>
      ok({ success: true, data: { markdown: MARKDOWN } }),
    );

    const result = await firecrawlScrape("https://www.russianfood.com/r", {
      fetch,
    });

    expect(result.ok).toBe(true);
    const { url, init } = calls[0] ?? {};
    expect(url).toBe(FIRECRAWL_ENDPOINT);
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>).authorization).toBe(
      "Bearer fc-test-key",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      url: "https://www.russianfood.com/r",
      formats: ["markdown"],
      onlyMainContent: true,
    });
  });

  it("threads the deadline's signal through", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test-key");
    const signal = AbortSignal.timeout(5_000);
    const { fetch, calls } = recordingFetch(() =>
      ok({ success: true, data: { markdown: MARKDOWN } }),
    );

    await firecrawlScrape("https://x.example/r", { fetch, signal });

    expect(calls[0]?.init?.signal).toBe(signal);
  });

  it("maps a thrown request to a blocked page", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test-key");

    await expect(
      firecrawlScrape("https://x.example/r", {
        fetch: (() =>
          Promise.reject(
            new Error("aborted"),
          )) as unknown as typeof globalThis.fetch,
      }),
    ).resolves.toEqual({ ok: false, reason: "blocked" });
  });

  it("maps a non-JSON body to a blocked page", async () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test-key");

    await expect(
      firecrawlScrape("https://x.example/r", {
        fetch: (() =>
          Promise.resolve(
            new Response("<html>502</html>", { status: 502 }),
          )) as unknown as typeof globalThis.fetch,
      }),
    ).resolves.toEqual({ ok: false, reason: "blocked" });
  });

  it("reads a 402's JSON body rather than assuming a status is enough", async () => {
    // FireCrawl answers "out of credits" with a JSON envelope, and the
    // outcome is the same either way: no markdown, so S8.2's fork.
    vi.stubEnv("FIRECRAWL_API_KEY", "fc-test-key");

    await expect(
      firecrawlScrape("https://x.example/r", {
        fetch: (() =>
          Promise.resolve(
            ok({ success: false, error: "Insufficient credits" }, 402),
          )) as unknown as typeof globalThis.fetch,
      }),
    ).resolves.toEqual({ ok: false, reason: "blocked" });
  });
});

describe("no FIRECRAWL_API_KEY", () => {
  it("answers without touching the network", async () => {
    // Not reachable in production — `env()` declares the variable required
    // and every request builds its context through it — but this is what lets
    // the function run in a test and in a zero-environment build at all.
    vi.stubEnv("FIRECRAWL_API_KEY", "");
    const fetch = vi.fn();

    await expect(
      firecrawlScrape("https://x.example/r", {
        fetch: fetch as unknown as typeof globalThis.fetch,
      }),
    ).resolves.toEqual({ ok: false, reason: "blocked" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("condenseMarkdown", () => {
  it("keeps every cell of a table-laid-out ingredient list", () => {
    // russianfood.com writes its ingredients as table rows; losing one to a
    // layout rule would silently drop an ingredient from the recipe.
    expect(
      condenseMarkdown("| Говядина – 1 кг | Лук – 600 г |\n| --- | --- |"),
    ).toBe("Говядина – 1 кг · Лук – 600 г");
  });

  it("keeps a link's words and drops its href", () => {
    expect(condenseMarkdown("[Рецепты](https://example.invalid/r)")).toBe(
      "Рецепты",
    );
  });

  it("drops an image entirely rather than leaving its alt text loose", () => {
    expect(
      condenseMarkdown("![Фото шага 1](https://example.invalid/1.jpg)\nТушим."),
    ).toBe("Тушим.");
  });

  it("drops rows that carry no words at all", () => {
    expect(condenseMarkdown("|     |     |\n| --- | --- |\n***\nМука")).toBe(
      "Мука",
    );
  });

  it("leaves ordinary prose alone", () => {
    const markdown =
      "# Гуляш\n\nТушим два часа.\n\n- Говядина – 1 кг\n- Лук – 600 г";

    expect(condenseMarkdown(markdown)).toBe(markdown);
  });

  it("collapses blank runs to one, so paragraphs stay paragraphs", () => {
    expect(condenseMarkdown("Первый\n\n\n\nВторой")).toBe("Первый\n\nВторой");
  });
});
