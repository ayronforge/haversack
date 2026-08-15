import { Schema, SchemaGetter } from "effect";

/** Removes CPF punctuation and other non-digit input characters. */
export const normalizeCpf = (value: string): string => value.replace(/\D/g, "");

const cpfCheckDigit = (digits: string, length: number): number => {
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    sum += Number(digits[index]) * (length + 1 - index);
  }
  const remainder = (sum * 10) % 11;
  return remainder === 10 ? 0 : remainder;
};

/** Validates masked or canonical CPF input using both check digits. */
export const isValidCpf = (input: string): boolean => {
  const digits = normalizeCpf(input);
  if (!/^\d{11}$/.test(digits)) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false;
  return (
    cpfCheckDigit(digits, 9) === Number(digits[9]) &&
    cpfCheckDigit(digits, 10) === Number(digits[10])
  );
};

/** A canonical CPF: 11 digits, valid check digits. */
export const Cpf = Schema.String.check(
  Schema.makeFilter<string>((value) => isValidCpf(value) || "Invalid CPF."),
).pipe(Schema.brand("Cpf"));
export type Cpf = typeof Cpf.Type;

/**
 * Accepts a CPF with or without punctuation (`"123.456.789-09"`), decodes to
 * the canonical 11-digit form, and validates the check digits. Encoding keeps
 * the canonical digits; use {@link formatCpf} only at presentation boundaries.
 */
export const CpfFromString = Schema.String.pipe(
  Schema.decodeTo(Cpf, {
    decode: SchemaGetter.transform(normalizeCpf),
    encode: SchemaGetter.passthrough(),
  }),
);

/** Formats a canonical CPF for display: `"12345678909"` -> `"123.456.789-09"`. */
export const formatCpf = (cpf: Cpf): string =>
  `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
