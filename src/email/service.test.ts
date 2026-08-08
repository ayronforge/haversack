import { describe, expect, test } from "bun:test";

import { Effect, Layer, Redacted } from "effect";

import { testStub } from "../testing/test-stub.ts";
import { EmailConfig } from "./config.ts";
import { EmailProviderError } from "./errors.ts";
import { EmailProvider, type EmailProviderClient } from "./provider.ts";
import { EmailLive, EmailService } from "./service.ts";

const testConfig = EmailConfig.layer({
  apiKey: Redacted.make("re_test"),
  from: "Test <noreply@test.dev>",
  segmentId: "seg_1",
  topicId: "top_1",
});

const fakeProviderLayer = (client: Partial<EmailProviderClient>) =>
  Layer.succeed(
    EmailProvider,
    EmailProvider.of({
      use: (operation) =>
        Effect.tryPromise({
          try: () => operation(client as EmailProviderClient),
          catch: (cause) => new EmailProviderError({ cause }),
        }),
    }),
  );

const runWith = <A, E>(
  effect: Effect.Effect<A, E, EmailService>,
  client: Partial<EmailProviderClient>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        EmailService.layer.pipe(Layer.provide([testConfig, fakeProviderLayer(client)])),
      ),
    ) as Effect.Effect<A, E>,
  );

describe("EmailService.send", () => {
  test("sends pre-rendered html with config default from", async () => {
    const calls: Array<unknown> = [];
    const client = testStub<EmailProviderClient>({
      emails: {
        send: async (payload: unknown, options: unknown) => {
          calls.push({ payload, options });
          return { data: { id: "email_1" }, error: null };
        },
      },
    });

    const result = await runWith(
      Effect.gen(function* () {
        const service = yield* EmailService;
        return yield* service.send({
          to: "user@test.dev",
          subject: "Hi",
          html: "<p>hello</p>",
          idempotencyKey: "key-1",
        });
      }),
      client,
    );

    expect(result).toEqual({ id: "email_1" });
    const call = calls[0] as { payload: Record<string, unknown>; options: unknown };
    expect(call.payload.from).toBe("Test <noreply@test.dev>");
    expect(call.payload.html).toBe("<p>hello</p>");
    expect(call.options).toEqual({ idempotencyKey: "key-1" });
  });

  test("maps provider failures to EmailSendError", async () => {
    const client = testStub<EmailProviderClient>({
      emails: {
        send: async () => ({ data: null, error: { message: "rate limited" } }),
      },
    });

    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const service = yield* EmailService;
        return yield* service.send({ to: "user@test.dev", subject: "Hi", html: "x" });
      }).pipe(
        Effect.provide(
          EmailService.layer.pipe(Layer.provide([testConfig, fakeProviderLayer(client)])),
        ),
      ) as Effect.Effect<unknown, unknown>,
    );

    expect(exit._tag).toBe("Failure");
  });
});

describe("EmailService.syncContact", () => {
  test("creates missing contact with segment and topic", async () => {
    const created: Array<unknown> = [];
    const client = testStub<EmailProviderClient>({
      contacts: {
        get: async () => ({ data: null, error: { name: "not_found", message: "nope" } }),
        create: async (payload: unknown) => {
          created.push(payload);
          return { data: { id: "contact_1" }, error: null };
        },
      },
    });

    const result = await runWith(
      Effect.gen(function* () {
        const service = yield* EmailService;
        return yield* service.syncContact({
          email: "  User@Test.DEV ",
          firstName: "Ada",
          subscribe: true,
        });
      }),
      client,
    );

    expect(result.contactId).toBe("contact_1");
    expect(result.email).toBe("user@test.dev");
    const payload = created[0] as Record<string, unknown>;
    expect(payload.segments).toEqual([{ id: "seg_1" }]);
    expect(payload.topics).toEqual([{ id: "top_1", subscription: "opt_in" }]);
  });

  test("updates existing contact and adds to segment when missing", async () => {
    const segmentAdds: Array<unknown> = [];
    const client = testStub<EmailProviderClient>({
      contacts: {
        get: async () => ({ data: { id: "contact_9" }, error: null }),
        update: async () => ({ data: { id: "contact_9" }, error: null }),
        segments: {
          list: async () => ({ data: { data: [] }, error: null }),
          add: async (payload: unknown) => {
            segmentAdds.push(payload);
            return { data: { id: "m1" }, error: null };
          },
        },
      },
    });

    const result = await runWith(
      Effect.gen(function* () {
        const service = yield* EmailService;
        return yield* service.syncContact({ email: "user@test.dev" });
      }),
      client,
    );

    expect(result.contactId).toBe("contact_9");
    expect(segmentAdds).toEqual([{ email: "user@test.dev", segmentId: "seg_1" }]);
  });
});

describe("EmailLive", () => {
  test("layer composes with only EmailConfig required", () => {
    const layer = EmailLive.pipe(Layer.provide(testConfig));
    expect(layer).toBeDefined();
  });
});
