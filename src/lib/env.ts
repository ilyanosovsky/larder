import "server-only";

import { z } from "zod";

/**
 * Server-only environment variables. Never import this schema (or its
 * parsed values) into client components.
 */
const serverSchema = z.object({
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),
  BETTER_AUTH_URL: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  RESEND_API_KEY: z.string().min(1),
  EMAIL_FROM: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  // Hard monthly cap for AI spend, USD. Defaults to 20 when unset.
  AI_MONTHLY_BUDGET_USD: z.coerce.number().default(20),
  FIRECRAWL_API_KEY: z.string().min(1),
  UPLOADTHING_TOKEN: z.string().min(1),
});

/**
 * Variables exposed to the browser. Must be prefixed with NEXT_PUBLIC_.
 */
const clientSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.string().min(1),
});

const envSchema = serverSchema.merge(clientSchema);

export type Env = z.infer<typeof envSchema>;

function formatZodError(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const name = issue.path.join(".") || "(root)";
    return `  - ${name}: ${issue.message}`;
  });
  return `Invalid/missing environment variables:\n${lines.join("\n")}`;
}

function parseEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    throw new Error(formatZodError(result.error));
  }
  return result.data;
}

let cached: Env | undefined;

/**
 * Parses and returns the validated environment.
 *
 * Parsing is intentionally lazy — it happens on first call, not on module
 * import — so importing this module never throws. `pnpm build` runs in CI
 * with no environment variables set at all, and must still succeed; only
 * code paths that actually call `env()` at runtime need the variables to
 * be present.
 */
export function env(): Env {
  if (!cached) {
    cached = parseEnv();
  }
  return cached;
}
