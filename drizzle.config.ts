import { defineConfig } from 'drizzle-kit';

// Migrations will be generated into ./drizzle and applied programmatically at
// boot. U2 intentionally ships no domain schema; later units add declarations to
// the core storage module referenced here.
export default defineConfig({
  dialect: 'sqlite',
  schema: './packages/core/src/storage/schema.ts',
  out: './drizzle',
});
