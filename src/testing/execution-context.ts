import type { ExecutionContext } from "@cloudflare/workers-types";

import { testStub } from "./test-stub.ts";

/** A test ExecutionContext that exposes and drains work registered with `waitUntil`. */
export type TestExecutionContext = ExecutionContext & {
  readonly drainWaitUntil: () => Promise<ReadonlyArray<unknown>>;
  readonly waitUntilPromises: ReadonlyArray<Promise<unknown>>;
};

/** Creates a Cloudflare ExecutionContext fake that owns all registered background work. */
export function testExecutionContext(): TestExecutionContext {
  const waitUntilPromises: Array<Promise<unknown>> = [];
  const executionContext = {
    abort: () => undefined,
    drainWaitUntil: () => Promise.all(waitUntilPromises),
    exports: {},
    passThroughOnException: () => undefined,
    props: undefined,
    tracing: {},
    waitUntil: (promise: Promise<unknown>) => {
      waitUntilPromises.push(promise);
    },
    waitUntilPromises,
  };

  // The fake implements the ExecutionContext methods used by handlers and
  // supplies inert values for runtime-managed metadata (tracing, exports).
  return testStub<TestExecutionContext>(executionContext);
}
