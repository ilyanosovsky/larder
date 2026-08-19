import { getRequestConfig } from "next-intl/server";

// Larder ships a single locale (ru) with no locale URL prefix — see
// CLAUDE.md "Language rules". The locale is static, not derived from the
// request, so no middleware/routing config is needed.
export default getRequestConfig(async () => {
  const locale = "ru";

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
