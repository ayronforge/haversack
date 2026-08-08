import { Schema, SchemaGetter } from "effect";

const onlyDigits = (value: string) => value.replace(/\D/g, "");

const cpfCheckDigit = (digits: string, length: number): number => {
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    sum += Number(digits[index]) * (length + 1 - index);
  }
  const remainder = (sum * 10) % 11;
  return remainder === 10 ? 0 : remainder;
};

/** Validates the 11-digit CPF check digits (input must already be digits-only). */
export const isValidCpf = (digits: string): boolean => {
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
);
export type Cpf = typeof Cpf.Type;

/**
 * Accepts a CPF with or without punctuation (`"123.456.789-09"`), decodes to
 * the canonical 11-digit form, and validates the check digits. Encodes back to
 * the punctuated display format.
 */
export const CpfFromString = Schema.String.pipe(
  Schema.decodeTo(Cpf, {
    decode: SchemaGetter.transform(onlyDigits),
    encode: SchemaGetter.transform(
      (digits: string) =>
        `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`,
    ),
  }),
);

/** Formats a canonical CPF for display: `"12345678909"` -> `"123.456.789-09"`. */
export const formatCpf = (cpf: Cpf): string =>
  `${cpf.slice(0, 3)}.${cpf.slice(3, 6)}.${cpf.slice(6, 9)}-${cpf.slice(9)}`;
