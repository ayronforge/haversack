# Haversack

> A haversack is the bag you pack once and carry everywhere.

Every new [Effect](https://effect.website) project starts by rebuilding the
same things: an email service wrapped around Resend, feature flags that fail
open, a Stripe client with proper tracing spans, a rate limiter on Durable
Objects, CPF validation with real check digits. Haversack is that code —
extracted from production apps, written as idiomatic Effect from end to end,
and packed into one package so you never write it twice.

**Everything is a typed Effect service.** No loose async functions, no
untyped errors, no global config. Each capability is a `Context.Service` with
tagged errors, tracing spans, and a `Layer` you compose like any other —
config in, service out, test layers included.

**Import only what you use.** Each module is an independent subpath export,
and heavy SDKs (Stripe, Resend, posthog-js, ...) are optional peer
dependencies: if you never import `/stripe`, you never install Stripe.

```bash
bun add @ayronforge/haversack effect@rc
```

Haversack is built on the Effect 4 release candidate, published under the `rc`
dist-tag.

## What's inside

| Module | What it gives you |
|---|---|
| [`/schema`](#schemas) | Schema building blocks: URLs, slugs, phone numbers, Brazilian documents (CPF, CNPJ, CEP) |
| [`/email`](#email) | Resend-backed email service with react-email rendering and contact sync |
| [`/posthog`](#posthog) | Fail-open server analytics and flags, plus typed React flag policy over the official PostHog provider |
| [`/stripe`](#stripe) | Stripe SDK wrapper with per-operation tracing spans and webhook verification |
| [`/auth/workos`, `/auth/clerk`](#auth) | Auth SDK client layers with redacted config and tagged errors |
| [`/cf`](#cloudflare) | Workers primitives: rate limiter, distributed lock, queues, Analytics Engine, R2, Workflows adapter |
| [`/contracts`, `/aws`](#contracts-and-aws) | Vendor-neutral blob storage port with R2 and S3 implementations |
| [`/testing`](#testing) | Test helpers: service runners, ExecutionContext fakes, SDK stubs |
| `/errors`, `/utils` | Tagged error primitives, error normalization, and pure helpers |

## Schemas

Reusable Effect Schema building blocks with canonical storage values and
separate presentation formatters.

```ts
import { Schema } from "effect";
import {
  CpfFromString,
  EmailAddressFromString,
  EndpointUrl,
  formatCpf,
  PhoneNumberFromString,
  SlugFromString,
} from "@ayronforge/haversack/schema";

const cpf = Schema.decodeUnknownSync(CpfFromString)("529.982.247-25");
// "52998224725" — canonical digits in both decoded and encoded forms
formatCpf(cpf); // "529.982.247-25"

const phone = Schema.decodeUnknownSync(PhoneNumberFromString({ defaultCountry: "BR" }))(
  "(11) 98765-4321",
);
// "+5511987654321" — canonical E.164

const email = Schema.decodeUnknownSync(EmailAddressFromString())("User@Example.COM");
// "User@example.com" — domain normalized, local part preserved by default

const host = Schema.decodeUnknownSync(EndpointUrl)("https://api.example.com/");
// "https://api.example.com" — normalized, rejects query strings and fragments

const slug = Schema.decodeUnknownSync(SlugFromString)("Café com Leite!");
// "cafe-com-leite"
```

`CepLookup.layerViaCep({ fetch })` resolves an already parsed `Cep` without
capturing global I/O and distinguishes not-found, unavailable, and malformed
responses. `PhoneNumberFromString` parses international or explicitly
country-scoped national input through libphonenumber-js.

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

Server-side capture and feature flags run over fetch without an SDK and work in
Workers. Server delivery and evaluation are fail-open: failures log and fall
back rather than break a request.

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

React feature-flag policy lives in `@ayronforge/haversack/posthog/react` and
composes directly with the official `@posthog/react` provider. `useFeatureFlag`
subscribes through `useSyncExternalStore`; `FeatureGate` adds typed fallback and
pending rendering without owning SDK initialization, capture, or identity.

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
  `layerDurableObject(namespace)` for cross-isolate limits. The namespace points
  to a caller-owned Durable Object implementing `RateLimiterRpc`; the application
  owns persistence, migrations and cleanup. Fail-open on store failures.
- `DistributedLock` / `withLock(key, effect)` — `acquireUseRelease` lifecycle
  over a caller-owned Durable Object implementing the typed lease RPC contract.
- `makeQueueClientService(queue)` — queue producer publishing in Cloudflare's
  100-message batches.
- `AnalyticsEngine` — the strict Analytics Engine SQL API with Schema-decoded
  rows. Non-successful responses remain typed query errors; the library does
  not infer undocumented Cloudflare error semantics from response text.
- `makeR2BlobStorageLayer(bucket)` / `R2BlobPresignerLive` — the blob storage
  contract over R2 (see Contracts below).
- `@ayronforge/haversack/cf/workflow` —
  `makeCloudflareWorkflowEngineLayer({ workflow, step })` adapts
  `effect/unstable/workflow` to Cloudflare Workflows: activities map to
  `step.do` with retries, durable deferreds to `sendEvent`/`waitForEvent`,
  durable clocks to `step.sleep`.

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
  const report = yield* storage.get("reports/q3.pdf", { maxBytes: 10_000_000 });
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

## Contributing

```bash
bun install
bun run typecheck
bun test
bun run build   # bundles with tsdown and smoke-tests every entrypoint
```

Issues and pull requests are welcome. If you're adding a new integration,
follow the house style: every capability is a `Context.Service` with a config
layer, tagged errors, and tracing spans — and multi-vendor capabilities get a
port in `/contracts` with one implementation per vendor.

## License

MIT
