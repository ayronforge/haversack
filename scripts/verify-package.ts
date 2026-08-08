/**
 * Post-build smoke test of the actual artifact: every public entrypoint must
 * import and expose its main exports.
 */
const checks: Array<[path: string, exportName: string]> = [
  ["../dist/index.js", "normalizeError"],
  ["../dist/errors.js", "ProviderError"],
  ["../dist/schema.js", "EndpointUrl"],
  ["../dist/schema.js", "Phone"],
  ["../dist/schema.js", "CpfFromString"],
  ["../dist/utils.js", "sha256Hex"],
  ["../dist/email.js", "EmailService"],
  ["../dist/posthog.js", "PostHogAnalytics"],
  ["../dist/posthog/browser.js", "BrowserFeatureFlags"],
  ["../dist/posthog/react.js", "FeatureFlagsProvider"],
  ["../dist/stripe.js", "StripeClient"],
  ["../dist/auth/workos.js", "WorkosClient"],
  ["../dist/auth/clerk.js", "ClerkClient"],
  ["../dist/contracts.js", "BlobStorage"],
  ["../dist/aws.js", "S3BlobStorageLive"],
  ["../dist/cf.js", "RequestRateLimiter"],
  ["../dist/cf.js", "makeR2BlobStorageLayer"],
  ["../dist/cf/workflow.js", "makeCloudflareWorkflowEngineLayer"],
  ["../dist/testing.js", "runWithService"],
];

for (const [path, exportName] of checks) {
  const module = (await import(path)) as Record<string, unknown>;
  if (module[exportName] === undefined) {
    throw new Error(`${path} does not export ${exportName}.`);
  }
}

// cf/durable-objects imports `cloudflare:workers`, which only exists inside a
// Worker — assert the artifact exists and kept the import external instead.
const durableObjects = await Bun.file(new URL("../dist/cf/durable-objects.js", import.meta.url)).text();
if (!durableObjects.includes('from "cloudflare:workers"')) {
  throw new Error("dist/cf/durable-objects.js must keep cloudflare:workers as an external import.");
}

console.log(`verified ${checks.length + 1} entrypoints`);
