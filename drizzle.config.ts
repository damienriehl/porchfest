import { defineConfig } from "drizzle-kit";

// Migrations are committed with the core package and applied programmatically at
// boot.
export default defineConfig({
  dialect: "sqlite",
  schema: "./packages/core/src/storage/schema.ts",
  out: "./packages/core/drizzle",
});
