import { Schema, SchemaGetter } from "effect";

/** Removes CNPJ punctuation and other non-digit input characters. */
export const normalizeCnpj = (value: string): string => value.replace(/\D/g, "");

const cnpjCheckDigit = (digits: string, length: number): number => {
  const weights =
    length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (const [index, weight] of weights.entries()) {
    sum += Number(digits[index]) * weight;
  }
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
};

/** Validates masked or canonical CNPJ input using both check digits. */
export const isValidCnpj = (input: string): boolean => {
  const digits = normalizeCnpj(input);
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
).pipe(Schema.brand("Cnpj"));
export type Cnpj = typeof Cnpj.Type;

/**
 * Accepts a CNPJ with or without punctuation (`"12.345.678/0001-95"`), decodes
 * to the canonical 14-digit form, and validates the check digits. Encoding
 * keeps the canonical digits; use {@link formatCnpj} only at presentation
 * boundaries.
 */
export const CnpjFromString = Schema.String.pipe(
  Schema.decodeTo(Cnpj, {
    decode: SchemaGetter.transform(normalizeCnpj),
    encode: SchemaGetter.passthrough(),
  }),
);

/** Formats a canonical CNPJ for display: `"12345678000195"` -> `"12.345.678/0001-95"`. */
export const formatCnpj = (cnpj: Cnpj): string =>
  `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}`;
