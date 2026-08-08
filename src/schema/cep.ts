import { Context, Data, Effect, Layer, Schema, SchemaGetter } from "effect";

const onlyDigits = (value: string) => value.replace(/\D/g, "");

/** A canonical CEP: exactly 8 digits. */
export const Cep = Schema.String.check(Schema.isPattern(/^\d{8}$/));
export type Cep = typeof Cep.Type;

/**
 * Accepts a CEP with or without the hyphen (`"01310-100"`), decodes to the
 * canonical 8-digit form. Encodes back to the hyphenated display format.
 */
export const CepFromString = Schema.String.pipe(
  Schema.decodeTo(Cep, {
    decode: SchemaGetter.transform(onlyDigits),
    encode: SchemaGetter.transform((digits: string) => `${digits.slice(0, 5)}-${digits.slice(5)}`),
  }),
);

/** Formats a canonical CEP for display: `"01310100"` -> `"01310-100"`. */
export const formatCep = (cep: Cep): string => `${cep.slice(0, 5)}-${cep.slice(5)}`;

const ViaCepResponse = Schema.Union([
  Schema.Struct({ erro: Schema.Literal(true) }),
  Schema.Struct({
    cep: Schema.String,
    logradouro: Schema.String,
    bairro: Schema.String,
    localidade: Schema.String,
    estado: Schema.optional(Schema.String),
    uf: Schema.String,
  }),
]);

export type CepAddress = {
  readonly postalCode: Cep;
  readonly street: string;
  readonly neighborhood: string;
  readonly city: string;
  readonly state: string;
  readonly stateAbbreviation: string;
};

export class CepLookupError extends Data.TaggedError("CepLookupError")<{
  readonly cep: string;
  readonly reason: "invalid-cep" | "not-found" | "request-failed" | "invalid-response";
  readonly cause?: unknown;
}> {}

/** CEP address lookup backed by an external directory (ViaCEP by default). */
export class CepLookup extends Context.Service<
  CepLookup,
  {
    readonly lookup: (cep: string) => Effect.Effect<CepAddress, CepLookupError>;
  }
>()("@ayronforge/haversack/br/CepLookup") {
  /** ViaCEP (https://viacep.com.br) implementation. */
  static readonly layer: Layer.Layer<CepLookup> = Layer.succeed(
    CepLookup,
    CepLookup.of({
      lookup: Effect.fn("CepLookup.lookup")(function* (input: string) {
        const cep = yield* Schema.decodeUnknownEffect(CepFromString)(input).pipe(
          Effect.mapError(() => new CepLookupError({ cep: input, reason: "invalid-cep" })),
        );

        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(`https://viacep.com.br/ws/${cep}/json/`, {
              signal: AbortSignal.timeout(5_000),
            }),
          catch: (cause) => new CepLookupError({ cep, reason: "request-failed", cause }),
        });

        if (!response.ok) {
          return yield* new CepLookupError({ cep, reason: "request-failed" });
        }

        const body = yield* Effect.tryPromise({
          try: () => response.json(),
          catch: (cause) => new CepLookupError({ cep, reason: "invalid-response", cause }),
        });
        const data = yield* Schema.decodeUnknownEffect(ViaCepResponse)(body).pipe(
          Effect.mapError(
            (cause) => new CepLookupError({ cep, reason: "invalid-response", cause }),
          ),
        );

        if ("erro" in data) {
          return yield* new CepLookupError({ cep, reason: "not-found" });
        }

        return {
          postalCode: cep,
          street: data.logradouro,
          neighborhood: data.bairro,
          city: data.localidade,
          state: data.estado ?? data.uf,
          stateAbbreviation: data.uf,
        } satisfies CepAddress;
      }),
    }),
  );
}
