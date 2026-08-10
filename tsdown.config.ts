import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    contracts: "src/contracts/index.ts",
    aws: "src/aws/index.ts",
    errors: "src/errors/index.ts",
    schema: "src/schema/index.ts",
    utils: "src/utils/index.ts",
    email: "src/email/index.ts",
    posthog: "src/posthog/index.ts",
    "posthog/react": "src/posthog/react.tsx",
    stripe: "src/stripe/index.ts",
    "auth/workos": "src/auth/workos.ts",
    "auth/clerk": "src/auth/clerk.ts",
    cf: "src/cf/index.ts",
    "cf/workflow": "src/cf/workflow.ts",
    testing: "src/testing/index.ts",
  },
  clean: true,
  dts: true,
  format: "esm",
  deps: {
    neverBundle: true,
    dts: { neverBundle: true },
  },
  platform: "neutral",
  sourcemap: true,
  target: "es2022",
  tsconfig: "tsconfig.build.json",
});
