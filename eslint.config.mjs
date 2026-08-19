import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { FlatCompat } from "@eslint/eslintrc";
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// eslint-config-next ships only a legacy (eslintrc) config; FlatCompat is
// the officially documented bridge for using it under ESLint 9 flat config
// (the same approach create-next-app generates).
const compat = new FlatCompat({
  baseDirectory: __dirname,
});

export default tseslint.config(
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "design/**",
      "coverage/**",
      "next-env.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  eslintConfigPrettier,
);
