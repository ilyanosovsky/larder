import type { MetadataRoute } from "next";

// Icons: a single SVG placeholder (src/app/icon.svg) covers all sizes for
// now — it scales cleanly and its content sits inside the maskable safe
// zone. Real PNG + apple-touch-icon assets are deferred to task 7.3.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Larder",
    short_name: "Larder",
    start_url: "/",
    display: "standalone",
    background_color: "#f3f0e9", // --bg
    theme_color: "#3c5a4a", // --accent
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
