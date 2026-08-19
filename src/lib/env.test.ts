import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const VALID_ENV = {
  DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/larder",
  BETTER_AUTH_SECRET: "a".repeat(32),
  BETTER_AUTH_URL: "http://localhost:3000",
  GOOGLE_CLIENT_ID: "test-google-client-id",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
  RESEND_API_KEY: "test-resend-key",
  EMAIL_FROM: "Larder <noreply@localhost>",
  OPENAI_API_KEY: "test-openai-key",
  FIRECRAWL_API_KEY: "test-firecrawl-key",
  UPLOADTHING_TOKEN: "test-uploadthing-token",
  NEXT_PUBLIC_APP_URL: "http://localhost:3000",
} as const;

describe("env", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not throw on module import even without any env vars set", async () => {
    await expect(import("./env")).resolves.toBeDefined();
  });

  it("parses successfully when all required variables are present", async () => {
    for (const [key, value] of Object.entries(VALID_ENV)) {
      vi.stubEnv(key, value);
    }

    const { env } = await import("./env");
    const parsed = env();

    expect(parsed.DATABASE_URL).toBe(VALID_ENV.DATABASE_URL);
    expect(parsed.NEXT_PUBLIC_APP_URL).toBe(VALID_ENV.NEXT_PUBLIC_APP_URL);
  });

  it("throws an aggregated error naming the missing variable", async () => {
    for (const [key, value] of Object.entries(VALID_ENV)) {
      vi.stubEnv(key, value);
    }
    vi.stubEnv("DATABASE_URL", "");

    const { env } = await import("./env");

    expect(() => env()).toThrow(/DATABASE_URL/);
  });

  it("aggregates every missing variable into a single error", async () => {
    for (const [key, value] of Object.entries(VALID_ENV)) {
      vi.stubEnv(key, value);
    }
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("OPENAI_API_KEY", "");

    const { env } = await import("./env");

    expect(() => env()).toThrow(/DATABASE_URL[\s\S]*OPENAI_API_KEY/);
  });

  it("rejects a BETTER_AUTH_SECRET shorter than 32 characters", async () => {
    for (const [key, value] of Object.entries(VALID_ENV)) {
      vi.stubEnv(key, value);
    }
    vi.stubEnv("BETTER_AUTH_SECRET", "a".repeat(31));

    const { env } = await import("./env");

    expect(() => env()).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("defaults AI_MONTHLY_BUDGET_USD to 20 when unset", async () => {
    for (const [key, value] of Object.entries(VALID_ENV)) {
      vi.stubEnv(key, value);
    }
    // Guard against a value inherited from the shell overriding the default.
    vi.stubEnv("AI_MONTHLY_BUDGET_USD", undefined);

    const { env } = await import("./env");

    expect(env().AI_MONTHLY_BUDGET_USD).toBe(20);
  });

  it("coerces AI_MONTHLY_BUDGET_USD when set", async () => {
    for (const [key, value] of Object.entries(VALID_ENV)) {
      vi.stubEnv(key, value);
    }
    vi.stubEnv("AI_MONTHLY_BUDGET_USD", "50");

    const { env } = await import("./env");

    expect(env().AI_MONTHLY_BUDGET_USD).toBe(50);
  });
});
