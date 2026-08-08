export function splitFullName(name?: string | null): {
  firstName: string | undefined;
  lastName: string | undefined;
} {
  const trimmed = name?.trim();
  if (!trimmed) {
    return { firstName: undefined, lastName: undefined };
  }

  const [firstName, ...rest] = trimmed.split(/\s+/);
  const lastName = rest.join(" ").trim();

  return {
    firstName,
    lastName: lastName.length > 0 ? lastName : undefined,
  };
}
