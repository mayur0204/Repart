import "dotenv/config";
import { defineConfig, env } from "prisma/config";

// Prisma CLI (migrate, introspect) uses the DIRECT connection.
// The app runtime uses the pooled DATABASE_URL via the pg driver adapter (src/server/db.ts).
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DIRECT_URL"),
  },
});
