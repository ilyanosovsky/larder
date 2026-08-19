import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * A household — the top-level tenant every other entity belongs to (VISION
 * §5). MVP: a user belongs to a single household.
 */
export const households = pgTable("households", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
