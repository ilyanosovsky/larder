/**
 * The SSRF guard for URL import (blueprint §3.5, decisions §C.8).
 *
 * `dishImport.fromUrl` is the one procedure in this app that makes the server
 * fetch a URL a *user* chose. That is the classic server-side request forgery
 * surface: `http://169.254.169.254/`, `http://localhost:5432/`, or a public
 * hostname that answers with a 302 to either of those. The guard is
 * deliberately split in two, because the two halves answer different
 * questions at different times:
 *
 * - `classifyImportUrl` looks at the URL **as written** — scheme, credentials,
 *   port, hostname, literal IP. Pure string work, so it runs at input
 *   validation, before a job row exists (decision C.8: a blocked URL is a
 *   validation rejection, not a ledger entry).
 * - `isBlockedAddress` looks at what the hostname actually **resolves to**,
 *   and `fetch-page.ts` runs it on every address of every redirect hop. A
 *   name is not an address; `nip.io`-style wildcard DNS resolves any public
 *   name straight to `127.0.0.1`.
 *
 * Both fail **closed**: anything unparseable is blocked. A recipe page nobody
 * can import is a fallback to «вставь текст»; a request we made to something
 * inside the network is not recoverable.
 *
 * Pure — no DNS, no network, no `node:` imports — so every range below is
 * unit-tested directly.
 */

/**
 * Hosts whose recipes only exist behind a login wall.
 *
 * Not a security boundary — a courtesy one. A direct fetch of an Instagram
 * post returns a login page, and FireCrawl almost never gets through either
 * (VISION §6.4), so the honest move is to skip the fetch, try FireCrawl once,
 * and then say «скриншот работает лучше» rather than spending eight seconds
 * proving it.
 */
const SOCIAL_HOSTS: readonly string[] = [
  "instagram.com",
  "facebook.com",
  "fb.com",
  "tiktok.com",
  "threads.net",
  "threads.com",
];

/**
 * Names that must never be resolved at all.
 *
 * `*.internal` covers `metadata.google.internal`; it is listed in the tests by
 * name anyway, because that host is the single most valuable target on a
 * cloud network and a future edit to this list has to trip over it.
 */
const BLOCKED_HOST_SUFFIXES: readonly string[] = [
  "localhost",
  ".localhost",
  ".local",
  ".internal",
  ".home.arpa",
];

export type ImportUrlClassification =
  /** Refused before anything happens: S8.2's `blockedUrl` copy. */
  | { readonly kind: "blocked" }
  /** A login wall: skip the direct fetch, go straight to FireCrawl. */
  | { readonly kind: "social"; readonly url: string }
  | { readonly kind: "ok"; readonly url: string };

/**
 * The URL as written — the half of the guard that needs no network.
 *
 * Returns the **normalized** href rather than the caller's string, so
 * everything downstream (the ledger's `input_ref`, the fetch, the draft's
 * `sourceUrl`) agrees on one spelling.
 */
export function classifyImportUrl(
  raw: string,
  options: {
    /**
     * Longest **normalized** href the caller can store. Passed by the two
     * storage-facing callers only (`fromUrlInput` and `fromUrl`'s re-check,
     * both with `MAX_SOURCE_URL`) and deliberately NOT by `fetchPage`'s
     * per-hop guard: a redirect target is never stored, and a site that
     * bounces through a long tracking URL on its way to a short canonical
     * one is a recipe page, not an attack.
     */
    readonly maxHref?: number;
  } = {},
): ImportUrlClassification {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { kind: "blocked" };
  }

  // http/https only. `file:`, `ftp:`, `gopher:` and `javascript:` are all
  // reachable through `fetch` or its polyfills in one runtime or another, and
  // none of them can hold a recipe.
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { kind: "blocked" };
  }

  // `http://user:pass@internal-host/` is the oldest trick in the file: some
  // proxies and some parsers disagree about where the host starts.
  if (url.username !== "" || url.password !== "") {
    return { kind: "blocked" };
  }

  // Only the two default ports. A recipe site does not serve HTML on 6379,
  // and every interesting SSRF target is a service on a non-standard port.
  if (url.port !== "" && url.port !== "80" && url.port !== "443") {
    return { kind: "blocked" };
  }

  // The *normalized* href is what gets stored — the ledger's `input_ref`, the
  // draft's `sourceUrl` — and the draft schema caps it at `MAX_SOURCE_URL`.
  // The input schema bounds the string as typed, and `new URL()` percent-
  // encodes every non-ASCII byte (a Cyrillic path grows sixfold), so a link
  // that fits the field can normalize into one the draft refuses — after the
  // page was fetched and the model paid for. Refuse it at the boundary.
  if (options.maxHref !== undefined && url.href.length > options.maxHref) {
    return { kind: "blocked" };
  }

  const hostname = normalizeHostname(url.hostname);
  if (hostname.length === 0 || isBlockedHostname(hostname)) {
    return { kind: "blocked" };
  }

  // A literal IP skips DNS entirely, so `isBlockedAddress` would never see it
  // unless it is checked here. Public literals are refused too: no recipe
  // site is addressed by number, and allowing them would mean trusting this
  // range list to be complete, rather than trusting DNS to name real sites.
  if (parseIpAddress(hostname) !== null) {
    return { kind: "blocked" };
  }

  return isSocialHost(hostname)
    ? { kind: "social", url: url.href }
    : { kind: "ok", url: url.href };
}

/** Lowercased, with the DNS root dot and any IPv6 brackets removed. */
export function normalizeHostname(hostname: string): string {
  const lower = hostname.trim().toLowerCase().replace(/\.+$/, "");
  return lower.startsWith("[") && lower.endsWith("]")
    ? lower.slice(1, -1)
    : lower;
}

export function isBlockedHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);

  return BLOCKED_HOST_SUFFIXES.some((suffix) =>
    suffix.startsWith(".") ? host.endsWith(suffix) : host === suffix,
  );
}

/** instagram/facebook/tiktok and friends — a login wall, not a threat. */
export function isSocialHost(hostname: string): boolean {
  const host = normalizeHostname(hostname);

  return SOCIAL_HOSTS.some(
    (social) => host === social || host.endsWith(`.${social}`),
  );
}

/**
 * Is this **resolved address** one we refuse to talk to?
 *
 * Everything private, loopback, link-local, CGNAT or otherwise not-the-public-
 * internet, plus the three ranges decision C.8 added on top of the blueprint:
 * `192.0.0.0/24` (IETF protocol assignments, which includes the NAT64
 * well-known prefix's IPv4 side), `198.18.0.0/15` (benchmarking), `2002::/16`
 * (6to4 — an IPv6 address that carries an arbitrary IPv4 destination inside
 * it) and `64:ff9b::/96` (NAT64 — likewise).
 *
 * Unparseable input is blocked, not allowed: this function is the last thing
 * standing between a redirect and a request, and «I could not read this
 * address» is not a reason to make it.
 */
export function isBlockedAddress(address: string): boolean {
  const parsed = parseIpAddress(address);
  if (parsed === null) {
    return true;
  }

  return parsed.length === 4
    ? isBlockedIpv4(parsed)
    : isBlockedIpv6(new Uint8Array(parsed));
}

function isBlockedIpv4(bytes: readonly number[]): boolean {
  const [a = 0, b = 0] = bytes;

  return (
    a === 0 || // 0.0.0.0/8 — "this network"
    a === 10 || // 10/8 private
    a === 127 || // 127/8 loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 CGNAT
    (a === 169 && b === 254) || // 169.254/16 link-local, incl. the metadata IP
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12 private
    (a === 192 && b === 0) || // 192.0.0.0/24 IETF protocol assignments
    (a === 192 && b === 168) || // 192.168/16 private
    (a === 198 && (b === 18 || b === 19)) || // 198.18/15 benchmarking
    a >= 224 // 224/4 multicast and 240/4 reserved, incl. 255.255.255.255
  );
}

function isBlockedIpv6(bytes: Uint8Array): boolean {
  // `::/96` — the unspecified address, `::1`, and every IPv4-compatible
  // address. The mapped form (`::ffff:a.b.c.d`) is unwrapped and re-checked
  // as IPv4 below rather than blocked wholesale, because it is how a dual
  // stack reports an ordinary public v4 address.
  const first10Zero = bytes.slice(0, 10).every((byte) => byte === 0);
  if (first10Zero && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isBlockedIpv4([
      bytes[12] ?? 0,
      bytes[13] ?? 0,
      bytes[14] ?? 0,
      bytes[15] ?? 0,
    ]);
  }
  if (bytes.slice(0, 12).every((byte) => byte === 0)) {
    return true;
  }

  const [b0 = 0, b1 = 0, b2 = 0, b3 = 0] = bytes;

  return (
    (b0 & 0xfe) === 0xfc || // fc00::/7 unique local
    (b0 === 0xfe && (b1 & 0xc0) === 0x80) || // fe80::/10 link-local
    b0 === 0xff || // ff00::/8 multicast
    (b0 === 0x20 && b1 === 0x02) || // 2002::/16 6to4
    (b0 === 0x00 && b1 === 0x64 && b2 === 0xff && b3 === 0x9b) // 64:ff9b::/96
  );
}

/** 4 bytes for IPv4, 16 for IPv6, `null` when the text is not an address. */
export function parseIpAddress(value: string): number[] | null {
  const text = normalizeHostname(value);
  return parseIpv4(text) ?? parseIpv6(text);
}

/**
 * A strict dotted quad, and only that.
 *
 * Deliberately refuses the shorthand forms `inet_aton` accepts — `127.1`,
 * `0x7f.0.0.1`, `2130706433` — rather than expanding them. Those are the
 * classic guard bypasses, and a hostname that *looks* like one of them is not
 * a site we want to fetch either: `classifyImportUrl` sends anything this
 * function cannot read through the DNS path, where the resolved address is
 * checked again.
 */
function parseIpv4(value: string): number[] | null {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return null;
  }

  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const byte = Number(part);
    if (byte > 255) {
      return null;
    }
    bytes.push(byte);
  }

  return bytes;
}

function parseIpv6(value: string): number[] | null {
  if (!value.includes(":")) {
    return null;
  }

  // A zone id (`fe80::1%eth0`) never reaches a fetch, but it must not make the
  // address unreadable either — stripping it keeps the range check honest.
  const withoutZone = value.split("%")[0] ?? "";
  const halves = withoutZone.split("::");
  if (halves.length > 2) {
    return null;
  }

  const head = halves[0] ?? "";
  const tail = halves.length === 2 ? (halves[1] ?? "") : null;

  const headGroups = head === "" ? [] : head.split(":");
  const tailGroups = tail === null || tail === "" ? [] : tail.split(":");

  const bytes: number[] = [];
  const push = (groups: string[], target: number[]): boolean => {
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index] ?? "";

      // A trailing dotted quad (`::ffff:127.0.0.1`) is only legal last.
      if (group.includes(".")) {
        if (index !== groups.length - 1) {
          return false;
        }
        const quad = parseIpv4(group);
        if (quad === null) {
          return false;
        }
        target.push(...quad);
        continue;
      }

      if (!/^[0-9a-f]{1,4}$/.test(group)) {
        return false;
      }
      const word = Number.parseInt(group, 16);
      target.push((word >> 8) & 0xff, word & 0xff);
    }
    return true;
  };

  const headBytes: number[] = [];
  const tailBytes: number[] = [];
  if (!push(headGroups, headBytes) || !push(tailGroups, tailBytes)) {
    return null;
  }

  if (tail === null) {
    return headBytes.length === 16 ? headBytes : null;
  }

  const gap = 16 - headBytes.length - tailBytes.length;
  if (gap < 0) {
    return null;
  }

  bytes.push(...headBytes, ...new Array<number>(gap).fill(0), ...tailBytes);
  return bytes.length === 16 ? bytes : null;
}
