import { Schema, SchemaGetter } from "effect";

const onlyDigits = (value: string) => value.replace(/\D/g, "");

const cnpjCheckDigit = (digits: string, length: number): number => {
  const weights =
    length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let index = 0; index < length; index += 1) {
    sum += Number(digits[index]) * weights[index]!;
  }
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
};

/** Validates the 14-digit CNPJ check digits (input must already be digits-only). */
export const isValidCnpj = (digits: string): boolean => {
  if (!/^\d{14}$/.test(digits)) return false;
  if (/^(\d)\1{13}$/.test(digits)) return false;
  return (
    cnpjCheckDigit(digits, 12) === Number(digits[12]) &&
    cnpjCheckDigit(digits, 13) === Number(digits[13])
  );
};

/** A canonical CNPJ: 14 digits, valid check digits. */
export const Cnpj = Schema.String.check(
  Schema.makeFilter<string>((value) => isValidCnpj(value) || "Invalid CNPJ."),
);
export type Cnpj = typeof Cnpj.Type;

/**
 * Accepts a CNPJ with or without punctuation (`"12.345.678/0001-95"`), decodes
 * to the canonical 14-digit form, and validates the check digits. Encodes back
 * to the punctuated display format.
 */
export const CnpjFromString = Schema.String.pipe(
  Schema.decodeTo(Cnpj, {
    decode: SchemaGetter.transform(onlyDigits),
    encode: SchemaGetter.transform(
      (digits: string) =>
        `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`,
    ),
  }),
);

/** Formats a canonical CNPJ for display: `"12345678000195"` -> `"12.345.678/0001-95"`. */
export const formatCnpj = (cnpj: Cnpj): string =>
  `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}`;
