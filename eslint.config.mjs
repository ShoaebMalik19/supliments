import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: import.meta.dirname });

const privilegedAllowed = [
  "src/modules/auth/**",
  "src/modules/tenancy/**",
  "src/modules/admin/**",
  "src/modules/jobs/**",
  "src/modules/audit/**",
  "src/modules/catalog/admin.ts",
  "src/db/**",
  "tests/**",
  "scripts/**",
];

const config = [
  { ignores: [".claude/**", ".next/**", "node_modules/**", "next-env.d.ts", "db/migrations/**"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/db/privileged", "**/db/privileged"],
              message: "Privileged DB bypasses RLS. Use withTenant(); see CLAUDE.md tenancy rule.",
            },
            {
              group: ["@supabase/*"],
              message: "Vendor SDKs are only imported from src/adapters/<vendor> (adapter rule).",
            },
          ],
        },
      ],
    },
  },
  {
    files: privilegedAllowed,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@supabase/*"], message: "Adapter rule: use src/adapters/supabase." },
          ],
        },
      ],
    },
  },
  { files: ["src/adapters/**", "src/middleware.ts"], rules: { "no-restricted-imports": "off" } },
];
export default config;
