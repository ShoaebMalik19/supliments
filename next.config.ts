import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["postgres", "sharp"],
  outputFileTracingIncludes: {
    "/**": ["./assets/fonts/**", "./db/seed/label-templates/**"],
  },
};

export default config;
