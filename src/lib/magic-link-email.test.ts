import { describe, expect, it } from "vitest";

import ru from "@/messages/ru.json";

import {
  MAGIC_LINK_EXPIRES_IN_SECONDS,
  renderMagicLinkEmail,
} from "./magic-link-email";

const URL_WITH_QUERY =
  "http://localhost:3000/api/auth/magic-link/verify?token=abc123&callbackURL=%2F";

describe("renderMagicLinkEmail", () => {
  it("uses the Russian subject from the dictionary", () => {
    const { subject } = renderMagicLinkEmail(URL_WITH_QUERY);

    expect(subject).toBe(ru.auth.email.subject);
    expect(subject).toBe("Вход в Larder");
  });

  it("puts the link in both the HTML and the plain-text body", () => {
    const { html, text } = renderMagicLinkEmail(URL_WITH_QUERY);

    // `&` is escaped inside HTML attributes, so assert on the escaped form.
    expect(html).toContain(
      'href="http://localhost:3000/api/auth/magic-link/verify?token=abc123&amp;callbackURL=%2F"',
    );
    expect(text).toContain(URL_WITH_QUERY);
  });

  it("renders the dictionary copy, not hardcoded strings", () => {
    const { html, text } = renderMagicLinkEmail(URL_WITH_QUERY);

    expect(html).toContain(ru.auth.email.button);
    expect(html).toContain(ru.auth.email.intro);
    expect(html).toContain(ru.auth.email.fallback);
    expect(text).toContain(ru.auth.email.ignore);
  });

  it("states the expiry that matches the plugin's expiresIn", () => {
    const minutes = MAGIC_LINK_EXPIRES_IN_SECONDS / 60;
    const { html, text } = renderMagicLinkEmail(URL_WITH_QUERY);

    expect(minutes).toBe(15);
    // Russian "many" plural category for 15.
    expect(html).toContain("действует 15 минут");
    expect(text).toContain("действует 15 минут");
  });

  it("escapes HTML-significant characters in the URL", () => {
    const { html } = renderMagicLinkEmail(
      'http://localhost:3000/verify?token="><script>alert(1)</script>',
    );

    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("produces a self-contained HTML document", () => {
    const { html } = renderMagicLinkEmail(URL_WITH_QUERY);

    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="ru">');
  });
});
