import { defineConfig } from 'drizzle-kit';

// `pnpm --filter @tasklite/server db:generate` writes a migration for schema
// changes. Build @tasklite/shared first: the schema imports its enums.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  casing: 'snake_case',
});
