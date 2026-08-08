/**
 * Best-effort extraction of a human-readable message from an unknown thrown value.
 */
export const errorMessage = (value: unknown): string => {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && "message" in value) {
    const message = (value as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

/**
 * Normalizes an unknown thrown value into a real `Error`, preserving the
 * original value as `cause` when it was not already an `Error`.
 */
export const normalizeError = (value: unknown): Error => {
  if (value instanceof Error) return value;
  return new Error(errorMessage(value), { cause: value });
};
