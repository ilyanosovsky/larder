import { createTranslator } from "next-intl";

import messages from "@/messages/ru.json";

/**
 * How long a magic link stays valid. Passed to the Better Auth `magicLink`
 * plugin and rendered into the email, so the two can never disagree.
 */
export const MAGIC_LINK_EXPIRES_IN_SECONDS = 15 * 60;

export interface MagicLinkEmail {
  subject: string;
  html: string;
  text: string;
}

/** Paper Ledger light-theme values (src/styles/tokens.css). Email clients
 *  strip <style> and CSS variables, so the palette is inlined literally. */
const COLOR = {
  bg: "#f3f0e9", // --bg
  paper: "#faf8f2", // --paper
  rule: "#e3ddcf", // --rule
  ink: "#2b2820", // --ink
  mute: "#7c7561", // --mute
  accent: "#3c5a4a", // --accent
} as const;

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

/**
 * Renders the Russian magic-link email. Pure — no network, no env, no request
 * context — so it is unit-testable on its own; the actual send lives in
 * `src/lib/auth.ts`.
 *
 * Copy comes from the `auth.email` namespace of the ru dictionary (UI strings
 * never live in code, see AGENTS.md). `createTranslator` is the synchronous,
 * context-free counterpart of `useTranslations`, which is what lets this stay
 * a plain function.
 */
export function renderMagicLinkEmail(url: string): MagicLinkEmail {
  const t = createTranslator({
    locale: "ru",
    messages,
    namespace: "auth.email",
  });

  const minutes = Math.round(MAGIC_LINK_EXPIRES_IN_SECONDS / 60);
  const subject = t("subject");
  const heading = t("heading");
  const intro = t("intro");
  const button = t("button");
  const expiry = t("expiry", { minutes });
  const fallback = t("fallback");
  const ignore = t("ignore");
  const safeUrl = escapeHtml(url);

  const html = `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="color-scheme" content="light" />
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:24px;background:${COLOR.bg};color:${COLOR.ink};font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.55;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="440" style="width:100%;max-width:440px;border-collapse:collapse;border:1px solid ${COLOR.rule};background:${COLOR.paper};">
            <tr>
              <td style="padding:32px 28px;">
                <p style="margin:0 0 4px;font-size:24px;font-weight:600;letter-spacing:-0.01em;color:${COLOR.ink};">Larder</p>
                <p style="margin:0 0 24px;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;color:${COLOR.mute};">${escapeHtml(heading)}</p>
                <p style="margin:0 0 24px;color:${COLOR.ink};">${escapeHtml(intro)}</p>
                <p style="margin:0 0 24px;">
                  <a href="${safeUrl}" style="display:inline-block;padding:14px 28px;border:1px solid ${COLOR.accent};background:${COLOR.accent};color:${COLOR.paper};font-family:Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;text-decoration:none;">${escapeHtml(button)}</a>
                </p>
                <p style="margin:0 0 24px;font-size:13px;color:${COLOR.mute};">${escapeHtml(expiry)}</p>
                <p style="margin:0 0 8px;font-size:13px;color:${COLOR.mute};">${escapeHtml(fallback)}</p>
                <p style="margin:0 0 24px;font-family:'Courier New',monospace;font-size:12px;word-break:break-all;">
                  <a href="${safeUrl}" style="color:${COLOR.accent};">${safeUrl}</a>
                </p>
                <hr style="margin:0 0 16px;border:0;border-top:1px solid ${COLOR.rule};" />
                <p style="margin:0;font-size:12px;color:${COLOR.mute};">${escapeHtml(ignore)}</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const text = [heading, "", intro, "", url, "", expiry, "", ignore].join("\n");

  return { subject, html, text };
}
