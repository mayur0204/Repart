import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Business logic and DB access stay on the server (PLAN §1.2).
    files: ["app/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}", "src/lib/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/generated/*", "@/generated/**"], message: "Use services in src/server, not the Prisma client directly." },
            { group: ["@/server/db", "@/server/db.ts"], message: "Only src/server/** may import the database client." },
            { group: ["lucide-react"], message: "Use the <Icon> wrapper so stroke weight stays consistent." },
          ],
        },
      ],
    },
  },
  {
    // The Icon wrapper is the one place lucide-react may be imported.
    files: ["src/components/ui/icon.tsx"],
    rules: { "no-restricted-imports": "off" },
  },
  globalIgnores([".next/**", "node_modules/**", "src/generated/**", "coverage/**", "playwright-report/**", "test-results/**", "next-env.d.ts"]),
]);
