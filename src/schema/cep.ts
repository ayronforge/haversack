import { Context, Data, Duration, Effect, Layer, Schema, SchemaGetter } from "effect";

/** Removes CEP punctuation and other non-digit input characters. */
export const normalizeCep = (value: string): string => value.replace(/\D/g, "");

/** A canonical CEP: exactly 8 digits. */
export const Cep = Schema.String.check(Schema.isPattern(/^\d{8}$/)).pipe(Schema.brand("Cep"));
export type Cep = typeof Cep.Type;

/**
 * Accepts a CEP with or without the hyphen (`"01310-100"`) and decodes to
 * the canonical 8-digit form. Encoding preserves the canonical digits; use
 * {@link formatCep} only at presentation boundaries.
 */
export const CepFromString = Schema.String.pipe(
  Schema.decodeTo(Cep, {
    decode: SchemaGetter.transform(normalizeCep),
    encode: SchemaGetter.passthrough(),
  }),
);

/** Formats a canonical CEP for display: `"01310100"` -> `"01310-100"`. */
export const formatCep = (cep: Cep): string => `${cep.slice(0, 5)}-${cep.slice(5)}`;

const ViaCepResponse = Schema.Struct({
  cep: Schema.optional(Schema.String),
  logradouro: Schema.optional(Schema.String),
  bairro: Schema.optional(Schema.String),
  localidade: Schema.optional(Schema.String),
  estado: Schema.optional(Schema.String),
  uf: Schema.optional(Schema.String),
  erro: Schema.optional(Schema.Union([Schema.Boolean, Schema.String])),
});

export type CepAddress = {
  readonly postalCode: Cep;
  readonly street: string;
  readonly neighborhood: string;
  readonly city: string;
  readonly state: string;
  readonly stateAbbreviation: string;
};

export class CepNotFound extends Data.TaggedError("CepNotFound")<{}> {}

export class CepLookupUnavailable extends Data.TaggedError("CepLookupUnavailable")<{
  readonly cause?: unknown;
  readonly status?: number;
}> {}

export class InvalidCepResponse extends Data.TaggedError("InvalidCepResponse")<{
  readonly cause?: unknown;
}> {}

export type CepLookupError = CepNotFound | CepLookupUnavailable | InvalidCepResponse;

export type CepLookupLayerOptions = {
  readonly fetch: typeof globalThis.fetch;
  readonly timeout?: Duration.Input | undefined;
};

/** CEP address lookup backed by an injected external directory. */
export class CepLookup extends Context.Service<
  CepLookup,
  {
    readonly lookup: (cep: Cep) => Effect.Effect<CepAddress, CepLookupError>;
  }
>()("@ayronforge/haversack/br/CepLookup") {
  /** Creates a ViaCEP implementation without capturing a global fetch function. */
  static layerViaCep(options: CepLookupLayerOptions): Layer.Layer<CepLookup> {
    const timeout = options.timeout ?? "5 seconds";

    return Layer.succeed(
      CepLookup,
      CepLookup.of({
        lookup: Effect.fn("CepLookup.lookup")(function* (cep: Cep) {
          const response = yield* Effect.tryPromise({
            try: (signal) => options.fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal }),
            catch: (cause) => new CepLookupUnavailable({ cause }),
          }).pipe(
            Effect.timeoutOrElse({
              duration: timeout,
              orElse: () => Effect.fail(new CepLookupUnavailable({})),
            }),
          );

          if (!response.ok) {
            return yield* new CepLookupUnavailable({ status: response.status });
          }

          const body = yield* Effect.tryPromise({
            try: () => response.json(),
            catch: (cause) => new InvalidCepResponse({ cause }),
          });
          const data = yield* Schema.decodeUnknownEffect(ViaCepResponse)(body).pipe(
            Effect.mapError((cause) => new InvalidCepResponse({ cause })),
          );

          if (data.erro === true || data.erro === "true") {
            return yield* new CepNotFound();
          }
          if (!data.localidade || !data.uf) {
            return yield* new InvalidCepResponse({});
          }

          return {
            postalCode: cep,
            street: data.logradouro ?? "",
            neighborhood: data.bairro ?? "",
            city: data.localidade,
            state: data.estado ?? data.uf,
            stateAbbreviation: data.uf,
          } satisfies CepAddress;
        }),
      }),
    );
  }
}
