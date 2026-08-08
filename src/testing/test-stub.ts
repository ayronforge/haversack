/**
 * Builds a partial fake of an external interface for tests. This is the single
 * sanctioned escape hatch for faking SDK clients and runtime objects whose full
 * surface (branded classes, runtime-managed members) cannot be implemented
 * structurally. Never use it in production code.
 */
export function testStub<T>(stub: unknown): T {
  return stub as T;
}
