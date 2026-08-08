/** Applies missing process environment defaults and returns their resolved values. */
export function applyTestEnvDefaults(defaults: Record<string, string>): Record<string, string> {
  const resolved: Record<string, string> = {};

  for (const [key, value] of Object.entries(defaults)) {
    resolved[key] = process.env[key] ??= value;
  }

  return resolved;
}
