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
  test("encodes back to punctuated form", () => {
    const cpf = decode(CpfFromString, "52998224725");
    expect(Effect.runSync(Schema.encodeEffect(CpfFromString)(cpf))).toBe("529.982.247-25");
    expect(formatCpf(cpf)).toBe("529.982.247-25");
  });
});

describe("Cnpj", () => {
  test("decodes punctuated CNPJ to canonical digits", () => {
    expect(decode(CnpjFromString, "11.222.333/0001-81")).toBe("11222333000181");
  });
  test("rejects wrong check digits", () => {
    expect(decodeFails(CnpjFromString, "11.222.333/0001-82")).toBe(true);
  });
  test("formats for display", () => {
    expect(formatCnpj(decode(CnpjFromString, "11222333000181"))).toBe("11.222.333/0001-81");
  });
});

describe("Cep", () => {
  test("decodes hyphenated CEP", () => {
    expect(decode(CepFromString, "01310-100")).toBe("01310100");
  });
  test("rejects short values", () => {
    expect(decodeFails(CepFromString, "0131010")).toBe(true);
  });
  test("formats for display", () => {
    expect(formatCep(decode(CepFromString, "01310100"))).toBe("01310-100");
  });
});

describe("CepLookup", () => {
  const withFetch = async <A>(fake: typeof fetch, run: () => Promise<A>): Promise<A> => {
    const original = globalThis.fetch;
    globalThis.fetch = fake;
    try {
      return await run();
    } finally {
      globalThis.fetch = original;
    }
  };

  const lookup = (cep: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* CepLookup;
        return yield* service.lookup(cep);
      }).pipe(Effect.provide(CepLookup.layer)) as Effect.Effect<unknown, unknown>,
    );

  test("resolves an address", async () => {
    const address = await withFetch(
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
      () => lookup("01310-100"),
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

  test("fails with not-found for unknown CEP", async () => {
    await withFetch(
      (async () => new Response(JSON.stringify({ erro: true }), { status: 200 })) as typeof fetch,
      async () => {
        await expect(lookup("99999999")).rejects.toThrow();
      },
    );
  });

  test("fails with invalid-cep without hitting the network", async () => {
    let called = false;
    await withFetch(
      (async () => {
        called = true;
        return new Response("{}");
      }) as typeof fetch,
      async () => {
        await expect(lookup("abc")).rejects.toThrow();
      },
    );
    expect(called).toBe(false);
  });
});
