import { Schema, SchemaGetter } from "effect";

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;

/** A DNS-label-style slug: 3-63 chars, lowercase alphanumerics and hyphens, no edge hyphens. */
export const Slug = Schema.String.check(Schema.isPattern(SLUG_PATTERN)).pipe(Schema.brand("Slug"));
export type Slug = typeof Slug.Type;

const toSlug = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

/**
 * Decodes arbitrary text into a valid slug: strips diacritics, lowercases,
 * collapses separators, then validates the DNS-label shape. Fails when the
 * result is too short (< 3 chars).
 */
export const SlugFromString = Schema.String.pipe(
  Schema.decodeTo(Slug, {
    decode: SchemaGetter.transform(toSlug),
    encode: SchemaGetter.passthrough(),
  }),
);
