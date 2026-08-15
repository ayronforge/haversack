import { describe, expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import {
  CepFromString,
  CepLookup,
  CnpjFromString,
  CpfFromString,
  formatCep,
  formatCnpj,
  formatCpf,
  isValidCnpj,
  isValidCpf,
  normalizeCnpj,
} from "./index.ts";

const decode = <S extends Schema.Top>(schema: S, input: unknown): S["Type"] =>
  Effect.runSync(Schema.decodeUnknownEffect(schema)(input) as Effect.Effect<S["Type"], unknown>);

const decodeFails = (schema: Schema.Top, input: unknown): boolean => {
  try {
    Effect.runSync(Schema.decodeUnknownEffect(schema)(input) as Effect.Effect<unknown, unknown>);
    return false;
  } catch {
    return true;
  }
};

describe("Cpf", () => {
  test("decodes punctuated CPF to canonical digits", () => {
    expect(decode(CpfFromString, "529.982.247-25")).toBe("52998224725");
  });
  test("accepts bare digits", () => {
    expect(decode(CpfFromString, "52998224725")).toBe("52998224725");
  });
  test("rejects wrong check digits", () => {
    expect(decodeFails(CpfFromString, "529.982.247-26")).toBe(true);
  });
  test("rejects repeated digits", () => {
    expect(decodeFails(CpfFromString, "111.111.111-11")).toBe(true);
  });
  test("encodes canonical digits and formats only for display", () => {
    const cpf = decode(CpfFromString, "52998224725");
    expect(Effect.runSync(Schema.encodeEffect(CpfFromString)(cpf))).toBe("52998224725");
    expect(formatCpf(cpf)).toBe("529.982.247-25");
  });
  test("validates masked input", () => {
    expect(isValidCpf("529.982.247-25")).toBe(true);
  });
});

describe("Cnpj", () => {
  test("decodes punctuated CNPJ to canonical digits", () => {
    expect(decode(CnpjFromString, "11.222.333/0001-81")).toBe("11222333000181");
  });
  test("accepts bare digits", () => {
    expect(decode(CnpjFromString, "11222333000181")).toBe("11222333000181");
  });
  test("rejects wrong check digits", () => {
    expect(decodeFails(CnpjFromString, "11.222.333/0001-82")).toBe(true);
  });
  test("rejects repeated digits", () => {
    expect(decodeFails(CnpjFromString, "11.111.111/1111-11")).toBe(true);
  });
  test("encodes canonical digits and formats only for display", () => {
    const cnpj = decode(CnpjFromString, "11222333000181");
    expect(Effect.runSync(Schema.encodeEffect(CnpjFromString)(cnpj))).toBe("11222333000181");
    expect(formatCnpj(cnpj)).toBe("11.222.333/0001-81");
  });
  test("validates masked input", () => {
    expect(isValidCnpj("11.222.333/0001-81")).toBe(true);
  });
  test("exports canonical normalization", () => {
    expect(normalizeCnpj("11.222.333/0001-81")).toBe("11222333000181");
  });
});

describe("Cep", () => {
  test("decodes hyphenated CEP", () => {
    expect(decode(CepFromString, "01310-100")).toBe("01310100");
  });
  test("rejects short values", () => {
    expect(decodeFails(CepFromString, "0131010")).toBe(true);
  });
  test("encodes canonical digits and formats only for display", () => {
    const cep = decode(CepFromString, "01310-100");
    expect(Effect.runSync(Schema.encodeEffect(CepFromString)(cep))).toBe("01310100");
    expect(formatCep(cep)).toBe("01310-100");
  });
});

describe("CepLookup", () => {
  const lookupEffect = (fake: typeof fetch, input: string) => {
    const cep = decode(CepFromString, input);
    return Effect.gen(function* () {
      const service = yield* CepLookup;
      return yield* service.lookup(cep);
    }).pipe(Effect.provide(CepLookup.layerViaCep({ fetch: fake })));
  };
  const lookup = (fake: typeof fetch, input: string) =>
    Effect.runPromise(lookupEffect(fake, input));

  test("resolves an address", async () => {
    const address = await lookup(
      (async () =>
        new Response(
          JSON.stringify({
            cep: "01310-100",
            logradouro: "Avenida Paulista",
            bairro: "Bela Vista",
            localidade: "São Paulo",
            estado: "São Paulo",
            uf: "SP",
          }),
          { status: 200 },
        )) as typeof fetch,
      "01310-100",
    );
    expect(address).toEqual({
      postalCode: "01310100",
      street: "Avenida Paulista",
      neighborhood: "Bela Vista",
      city: "São Paulo",
      state: "São Paulo",
      stateAbbreviation: "SP",
    });
  });

  test("accepts ViaCEP responses without street or neighborhood", async () => {
    const address = await lookup(
      (async () =>
        new Response(
          JSON.stringify({
            cep: "69301-970",
            localidade: "Boa Vista",
            uf: "RR",
          }),
          { status: 200 },
        )) as typeof fetch,
      "69301-970",
    );
    expect(address.street).toBe("");
    expect(address.neighborhood).toBe("");
    expect(address.state).toBe("RR");
  });

  test.each([true, "true"])("fails with CepNotFound for erro=%p", async (erro) => {
    const failure = await Effect.runPromise(
      lookupEffect(
        (async () => new Response(JSON.stringify({ erro }), { status: 200 })) as typeof fetch,
        "99999999",
      ).pipe(Effect.flip),
    );
    expect(failure._tag).toBe("CepNotFound");
  });

  test("fails with InvalidCepResponse for incomplete responses", async () => {
    const failure = await Effect.runPromise(
      lookupEffect(
        (async () => new Response(JSON.stringify({ cep: "01310-100" }))) as typeof fetch,
        "01310-100",
      ).pipe(Effect.flip),
    );
    expect(failure._tag).toBe("InvalidCepResponse");
  });

  test("fails with CepLookupUnavailable for unsuccessful responses", async () => {
    const failure = await Effect.runPromise(
      lookupEffect(
        (async () => new Response("unavailable", { status: 503 })) as typeof fetch,
        "01310-100",
      ).pipe(Effect.flip),
    );
    expect(failure._tag).toBe("CepLookupUnavailable");
    if (failure._tag === "CepLookupUnavailable") expect(failure.status).toBe(503);
  });
});
