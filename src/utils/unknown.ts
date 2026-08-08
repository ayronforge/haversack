type UnknownFieldType = "string" | "number" | "boolean" | "unknown";

type ExtractedUnknownField<TType extends UnknownFieldType> = TType extends "string"
  ? string
  : TType extends "number"
    ? number
    : TType extends "boolean"
      ? boolean
      : unknown;

type ExtractedUnknownFields<TFields extends Record<string, UnknownFieldType>> = {
  [TKey in keyof TFields]?: ExtractedUnknownField<TFields[TKey]>;
};

/**
 * Type-safe extraction of known fields from an `unknown` value (e.g. a caught
 * error). Fields whose runtime type does not match the spec are omitted.
 */
export function extractUnknownFields<const TFields extends Record<string, UnknownFieldType>>(
  value: unknown,
  fields: TFields,
): ExtractedUnknownFields<TFields> {
  const source = value as Record<string, unknown> | null | undefined;
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(fields) as Array<keyof TFields & string>) {
    const fieldValue = source?.[key];
    const fieldType = fields[key];

    if (fieldType === "unknown") {
      if (fieldValue !== undefined) result[key] = fieldValue;
    } else if (typeof fieldValue === fieldType) {
      result[key] = fieldValue;
    }
  }

  return result as ExtractedUnknownFields<TFields>;
}
