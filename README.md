# Haversack

An Effect-native toolbox for TypeScript applications. Haversack consolidates
the services, schemas, and helpers reused across Ayronforge projects into one
package with independent subpath exports — install once, import only what you
use, and heavy SDKs stay optional peer dependencies.

```bash
bun add @ayronforge/haversack effect
```

Effect is pinned to an exact 4.0 beta. Match the version declared in
`peerDependencies` — beta releases break APIs between versions.

## Schemas

Reusable Effect Schema building blocks, including Brazilian documents with
check-digit validation and display-format encoding.

```ts
import { Schema } from "effect";
import { CpfFromString, EndpointUrl, SlugFromString } from "@ayronforge/haversack/schema";

const cpf = Schema.decodeUnknownSync(CpfFromString)("529.982.247-25");
// "52998224725" — decodes to canonical digits, encodes back to "529.982.247-25"

const host = Schema.decodeUnknownSync(EndpointUrl)("https://api.example.com/");
// "https://api.example.com" — normalized, rejects query strings and fragments

const slug = Schema.decodeUnknownSync(SlugFromString)("Café com Leite!");
// "cafe-com-leite"
```

`CepLookup` resolves addresses through ViaCEP as an Effect service with tagged
errors. `Phone` parses international numbers via libphonenumber-js.

## Email

A provider port with a Resend adapter. Send pre-rendered HTML or a react-email
element, and sync contacts to segments and topics.

```ts
import { Effect, Layer, Redacted } from "effect";
import { EmailConfig, EmailLive, EmailService } from "@ayronforge/haversack/email";

const config = EmailConfig.layer({
  apiKey: Redacted.make(process.env.RESEND_API_KEY!),
  from: "Acme <noreply@acme.com>",
});

const program = Effect.gen(function* () {
  const email = yield* EmailService;
  yield* email.send({
    to: "user@example.com",
    subject: "Welcome",
    html: "<p>Hello!</p>",
    idempotencyKey: "welcome-user-1",
  });
}).pipe(Effect.provide(EmailLive.pipe(Layer.provide(config))));
```

## PostHog

Server-side capture and feature flags over fetch (no SDK, works in Workers),
plus a browser store compatible with `useSyncExternalStore` and React bindings.
Everything is fail-open: delivery and evaluation failures log and fall back,
they never break a request.

```ts
import { Effect, Layer, Redacted } from "effect";
import { FeatureFlags, PostHogAnalytics, PostHogConfig } from "@ayronforge/haversack/posthog";

const config = PostHogConfig.layer({
  projectToken: Redacted.make(process.env.POSTHOG_TOKEN!),
});

const program = Effect.gen(function* () {
  const analytics = yield* PostHogAnalytics;
  yield* analytics.track({ event: "signup", distinctId: "user_1" });

  const flags = yield* FeatureFlags;
  return yield* flags.isEnabled(
    { key: "new-checkout", fallback: false },
    { distinctId: "user_1" },
  );
}).pipe(
  Effect.provide(PostHogAnalytics.layer.pipe(Layer.provide(config))),
  Effect.provide(FeatureFlags.layer.pipe(Layer.provide(config))),
);
```

React bindings live in `@ayronforge/haversack/posthog/react`
(`FeatureFlagsProvider`, `useFeatureFlag`, `FeatureGate`) over the browser
store in `@ayronforge/haversack/posthog/browser`.

## Stripe

An SDK wrapper where every call is named: the operation becomes the tracing
span (`stripe.checkout.sessions.create`) and error metadata.

```ts
import { Effect, Layer, Redacted } from "effect";
import { StripeClient, StripeConfig } from "@ayronforge/haversack/stripe";

const config = StripeConfig.layer({
  secretKey: Redacted.make(process.env.STRIPE_SECRET_KEY!),
  webhookSecret: Redacted.make(process.env.STRIPE_WEBHOOK_SECRET!),
});

const program = Effect.gen(function* () {
  const stripe = yield* StripeClient;
  const session = yield* stripe.use("checkout.sessions.create", (sdk) =>
    sdk.checkout.sessions.create({ mode: "subscription", line_items: [/* ... */] }),
  );
  return session.url;
}).pipe(Effect.provide(StripeClient.layer.pipe(Layer.provide(config))));
```

`verifyWebhook(payload, signature)` validates webhook signatures with tagged
errors. `makeStripeClientFromSdk` is the seam for injecting a fake SDK in tests.

## Auth

Thin client layers for WorkOS (`/auth/workos`) and Clerk (`/auth/clerk`),
following the same provider pattern: config with redacted keys, `use` with
spans, tagged errors. Clerk additionally exposes `useWebhook` for verified
webhook events.

## Cloudflare

Workers primitives, all binding-oriented — you pass bindings explicitly, the
library never reads a global env.

- `RequestRateLimiter` — fixed-window and token-bucket over
  `effect/unstable/persistence`, with `layerMemory` for tests and
  `layerDurableObject(namespace)` for cross-isolate limits. Fail-open on store
  failures.
- `DistributedLock` / `withLock(key, effect)` — a keyed mutex on a Durable
  Object with TTL leases and `acquireUseRelease` semantics.
- `makeQueueClientService(queue)` — queue producer publishing in Cloudflare's
  100-message batches.
- `AnalyticsEngine` — the Analytics Engine SQL API with Schema-decoded rows.
- `makeR2BlobStorageLayer(bucket)` / `R2BlobPresignerLive` — the blob storage
  contract over R2 (see Contracts below).
- `@ayronforge/haversack/cf/workflow` —
  `makeCloudflareWorkflowEngineLayer({ workflow, step })` adapts
  `effect/unstable/workflow` to Cloudflare Workflows: activities map to
  `step.do` with retries, durable deferreds to `sendEvent`/`waitForEvent`,
  durable clocks to `step.sleep`.

The Durable Object classes ship in a separate entrypoint that only loads
inside a Worker:

```ts
// worker entry file, referenced by wrangler
export { LockBucket, RateLimitBucket } from "@ayronforge/haversack/cf/durable-objects";
```

## Contracts and AWS

`@ayronforge/haversack/contracts` defines vendor-neutral ports — currently
`BlobStorage` (put/get/delete/exists/list) and `BlobPresigner`. Code against
the port; pick the implementation per runtime:

```ts
import { Effect } from "effect";
import { BlobStorage } from "@ayronforge/haversack/contracts";
import { makeR2BlobStorageLayer } from "@ayronforge/haversack/cf";
import { S3BlobStorageLive, S3Config } from "@ayronforge/haversack/aws";

const program = Effect.gen(function* () {
  const storage = yield* BlobStorage;
  yield* storage.put("reports/q3.pdf", bytes, { contentType: "application/pdf" });
});

// In a Worker:  Effect.provide(program, makeR2BlobStorageLayer(env.BUCKET))
// Elsewhere:    Effect.provide(program, S3BlobStorageLive) + S3Config.layer({ ... })
```

## Testing

- `runWithService(tag, layer)` — a Promise-based runner for exercising one
  service in tests without repeating provide/run boilerplate.
- `testExecutionContext()` — a fake Cloudflare `ExecutionContext` whose
  `drainWaitUntil()` awaits fire-and-forget work.
- `testStub<T>(partial)` — the sanctioned escape hatch for faking SDK clients
  in tests. Never use it in production code.
- `applyTestEnvDefaults(record)` — fills missing `process.env` keys.

## Environment configuration

Haversack deliberately contains no env-var handling. Use
[`@ayronforge/envil`](https://github.com/ayronforge/envil) for type-safe
environment validation and feed the decoded values into the config layers.

## Development

```bash
bun install
bun run typecheck
bun test
bun run build   # bundles with tsdown and smoke-tests every entrypoint
```

MIT
