import { NextIntlClientProvider } from "next-intl";
import { getTranslations } from "next-intl/server";
import { Inter, JetBrains_Mono, Literata, Newsreader } from "next/font/google";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { TRPCReactProvider } from "@/trpc/client";

import "./globals.css";

// TYPE fonts referenced by src/styles/tokens.css (--font-serif/-sans/-mono).
// Newsreader has no Cyrillic glyphs on Google Fonts, so --font-serif falls
// back to Literata for Cyrillic text (see tokens.css header comment).
const newsreader = Newsreader({
  subsets: ["latin"],
  variable: "--font-newsreader",
  weight: "variable",
});

const literata = Literata({
  subsets: ["latin", "cyrillic"],
  variable: "--font-literata",
  weight: "variable",
});

const inter = Inter({
  subsets: ["latin", "cyrillic"],
  variable: "--font-inter",
  weight: "variable",
});

const jetBrainsMono = JetBrains_Mono({
  subsets: ["latin", "cyrillic"],
  variable: "--font-jetbrains-mono",
  weight: "variable",
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("common");

  return {
    title: t("metaTitle"),
    description: t("metaDescription"),
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#3c5a4a", // --accent
};

export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <html
      lang="ru"
      data-theme="light"
      className={`${newsreader.variable} ${literata.variable} ${inter.variable} ${jetBrainsMono.variable}`}
    >
      <body>
        {/* The app shell (tabs + sidebar) lives in the `(app)` route group,
            so the sign-in screen in `(auth)` renders without navigation. */}
        <NextIntlClientProvider>
          {/* QueryClient + tRPC client for every client component. Inside the
              intl provider so the existing dictionary lookup is untouched. */}
          <TRPCReactProvider>{children}</TRPCReactProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
