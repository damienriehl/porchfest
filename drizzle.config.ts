import { defineConfig } from "drizzle-kit";

// Migrations are committed with the core package and applied by its database
// connection when the application opens SQLite at boot.
export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/core/src/storage/schema.ts",
  out: "./packages/core/drizzle",
});
