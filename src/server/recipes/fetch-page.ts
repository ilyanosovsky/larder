import {
  classifyImportUrl,
  isBlockedAddress,
  normalizeHostname,
} from "@/server/recipes/url-guard";

/**
 * The one place this app fetches a URL a user chose (blueprint §3.2, §3.5).
 *
 * Everything here is a limit, and every limit exists because the alternative
 * is a real failure mode:
 *
 * - **DNS before the socket, on every hop.** `classifyImportUrl` refuses
 *   names and literals; this refuses *addresses*, which is the only check
 *   that survives wildcard DNS (`127.0.0.1.nip.io` is a perfectly ordinary
 *   public hostname).
 * - **`redirect: "manual"`, at most three hops, each re-validated.** A guard
 *   that checks only the first URL is defeated by a 302 to
 *   `169.254.169.254`; a guard with no hop limit is defeated by a redirect
 *   loop that eats the whole deadline.
 * - **Two megabytes, counted while streaming.** `content-length` is optional
 *   and can lie, so the header check is an early out and the running counter
 *   is the actual limit. A recipe page that does not fit in 2 MB of HTML is
 *   not one this parser was going to read.
 * - **`fetch` and `lookup` are injected.** Every rule above is unit-tested
 *   with no network and no DNS resolver (AGENTS.md); a test that forgets to
 *   inject them fails loudly rather than dialing out.
 *
 * The residual risk is TOCTOU: a hostname can resolve public here and private
 * inside `fetch`. Accepted and documented (R4) — closing it needs an undici
 * dispatcher pinned to the resolved address, which is real complexity for an
 * attack that needs an attacker-controlled DNS server *and* a target on
 * Vercel's function network, which has no metadata endpoint.
 */

/** Two megabytes of HTML. Past this the page is not a recipe card. */
export const MAX_HTML_BYTES = 2_000_000;

/** Three hops. Real sites use one or two (http→https, or a canonical slug). */
export const MAX_REDIRECTS = 3;

/**
 * We ask for the page the way a phone browser would.
 *
 * Not a disguise: the request is made because a person pasted this link into
 * their own recipe app and is waiting for it. Sites that serve recipes to
 * browsers and refuse everything else would otherwise fail into FireCrawl —
 * which costs money and fetches the identical page. One request, no crawling,
 * no cookies, and a hard size cap.
 */
const REQUEST_HEADERS: Readonly<Record<string, string>> = {
  "user-agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
  "accept-language": "ru-RU,ru;q=0.9,en;q=0.6",
};

export type FetchPageResult =
  | { readonly kind: "html"; readonly html: string; readonly finalUrl: string }
  /** The SSRF guard refused the URL, or one of its redirect hops. */
  | { readonly kind: "blocked" }
  /** DNS, TCP, TLS, timeout, abort — nothing answered. */
  | { readonly kind: "unreachable" }
  /**
   * The server answered and refused (or failed). Kept apart from
   * `unreachable` because blueprint §3.6 maps the two to different S8.2
   * copy: 403/429/503 is `pageBlocked` («страница не отдала рецепт»), while a
   * dead host is `pageUnreachable`.
   */
  | { readonly kind: "status"; readonly status: number }
  | { readonly kind: "notHtml" }
  | { readonly kind: "tooLarge" };

/** Just enough of `dns.promises.lookup(host, { all: true })` to be faked. */
export type HostLookup = (
  hostname: string,
) => Promise<readonly { readonly address: string }[]>;

/** The transport, as the tRPC context carries it. */
export interface PageFetcher {
  readonly fetch: typeof globalThis.fetch;
  readonly lookup: HostLookup;
}

export interface FetchPageDeps extends PageFetcher {
  readonly signal?: AbortSignal;
}

export async function fetchPage(
  url: string,
  deps: FetchPageDeps,
): Promise<FetchPageResult> {
  let current = url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    // Re-classified per hop, not once: the scheme, the port and the hostname
    // can all change across a redirect, and every one of them is a way in.
    const classified = classifyImportUrl(current);
    if (classified.kind === "blocked") {
      return { kind: "blocked" };
    }

    const hostname = normalizeHostname(new URL(current).hostname);
    let addresses: readonly { readonly address: string }[];
    try {
      addresses = await deps.lookup(hostname);
    } catch {
      return { kind: "unreachable" };
    }

    if (addresses.length === 0) {
      return { kind: "unreachable" };
    }
    // *Every* address, not the first: a name that resolves to one public and
    // one private address is the whole point of the attack.
    if (addresses.some((entry) => isBlockedAddress(entry.address))) {
      return { kind: "blocked" };
    }

    let response: Response;
    try {
      response = await deps.fetch(current, {
        method: "GET",
        redirect: "manual",
        headers: REQUEST_HEADERS,
        signal: deps.signal,
        // No cookies, no credentials: this is a public page or it is nothing.
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch {
      return { kind: "unreachable" };
    }

    if (isRedirect(response.status)) {
      const location = response.headers.get("location");
      if (location === null || location.trim() === "") {
        return { kind: "unreachable" };
      }
      try {
        current = new URL(location, current).href;
      } catch {
        return { kind: "blocked" };
      }
      // Drain nothing: a redirect body is noise, and the loop re-validates
      // the new URL from the top.
      continue;
    }

    if (!response.ok) {
      return { kind: "status", status: response.status };
    }

    const contentType = response.headers.get("content-type");
    if (contentType !== null && !isHtmlContentType(contentType)) {
      return { kind: "notHtml" };
    }

    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_HTML_BYTES) {
      return { kind: "tooLarge" };
    }

    const body = await readCappedBody(response);
    if (!body.ok) {
      return { kind: body.reason };
    }

    return {
      kind: "html",
      html: decodeHtml(body.bytes, contentType),
      // `response.url` is empty on a `Response` built by hand in a test, so
      // the URL we actually asked for is the fallback rather than the other
      // way round.
      finalUrl: response.url === "" ? current : response.url,
    };
  }

  // More hops than any honest canonicalization needs.
  return { kind: "unreachable" };
}

function isRedirect(status: number): boolean {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function isHtmlContentType(contentType: string): boolean {
  const type = contentType.toLowerCase();
  return (
    type.includes("text/html") ||
    type.includes("application/xhtml") ||
    type.includes("text/plain")
  );
}

/**
 * Reads the body, stopping the moment it passes the cap.
 *
 * Returns a reason rather than throwing, so the caller's switch stays
 * exhaustive. The reader is cancelled explicitly on the way out: an abandoned
 * stream on a serverless function keeps the socket — and the invocation —
 * alive past the answer we already decided not to use.
 */
async function readCappedBody(
  response: Response,
): Promise<
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "tooLarge" | "unreachable" }
> {
  const body = response.body;
  if (body === null) {
    return { ok: true, bytes: new Uint8Array(0) };
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value === undefined) {
        continue;
      }
      total += value.byteLength;
      if (total > MAX_HTML_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "tooLarge" };
      }
      chunks.push(value);
    }
  } catch {
    // A stream that died mid-read is a page nobody read: half a document is
    // not a recipe, and reporting it as one would send a truncated `<head>`
    // to the parsers and then to FireCrawl as though the page had simply had
    // no structured data on it.
    return { ok: false, reason: "unreachable" };
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: merged };
}

/**
 * Bytes → text, in the page's own encoding.
 *
 * Not a nicety: russianfood.com — one of VISION §6.4's three verified sites —
 * still serves `windows-1251`, and `Response.text()` would decode it as UTF-8
 * and hand the model a page of replacement characters. The label comes from
 * the `content-type` header first and from a `<meta charset>` in the head
 * second, exactly as a browser does it, and an encoding the runtime does not
 * know falls back to UTF-8 rather than throwing.
 */
export function decodeHtml(
  bytes: Uint8Array,
  contentType: string | null,
): string {
  const label = charsetFromContentType(contentType) ?? sniffMetaCharset(bytes);

  return decodeWith(bytes, label) ?? decodeWith(bytes, "utf-8") ?? "";
}

function decodeWith(bytes: Uint8Array, label: string | null): string | null {
  if (label === null) {
    return null;
  }
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return null;
  }
}

function charsetFromContentType(contentType: string | null): string | null {
  if (contentType === null) {
    return null;
  }
  const match = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
  return match?.[1]?.toLowerCase() ?? null;
}

/**
 * The `<meta charset>` sniff, over the first kilobyte only.
 *
 * Latin-1 for the sniff because every encoding a recipe site uses agrees with
 * ASCII on the bytes that spell `charset`, and decoding the whole document
 * twice to find out how to decode it is the wrong order of operations.
 */
function sniffMetaCharset(bytes: Uint8Array): string | null {
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 1024));

  const direct = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head);
  return direct?.[1]?.toLowerCase() ?? null;
}
