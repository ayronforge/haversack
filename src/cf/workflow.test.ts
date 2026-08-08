import { describe, expect, test } from "bun:test";

import { Effect, Option, Schema } from "effect";
import { Activity, Workflow, WorkflowEngine } from "effect/unstable/workflow";

import { testStub } from "../testing/test-stub.ts";
import {
  type CloudflareWorkflowEngineOptions,
  makeCloudflareWorkflowEngineLayer,
} from "./workflow.ts";

const TestWorkflow = Workflow.make("TestWorkflow", {
  error: Schema.String,
  idempotencyKey: () => "test",
  payload: Schema.Struct({}),
  success: Schema.String,
});

const TestActivity = Activity.make({
  error: Schema.String,
  execute: Effect.succeed("ok"),
  name: "first step",
  success: Schema.String,
});

function fakeWorkflowBinding(
  get: (executionId: string) => Promise<{
    resume: () => Promise<void>;
    sendEvent: (event: { payload: unknown; type: string }) => Promise<void>;
    status: () => Promise<{
      output?: unknown;
      status: "complete" | "running";
    }>;
    terminate: () => Promise<void>;
  }> = async () => ({
    resume: async () => undefined,
    sendEvent: async () => undefined,
    status: async () => ({ status: "running" }),
    terminate: async () => undefined,
  }),
): CloudflareWorkflowEngineOptions["workflow"] {
  // SAFETY: The adapter consumes only `Workflow.get`; the recording fake
  // supplies that complete seam without pretending to implement the runtime.
  return testStub<CloudflareWorkflowEngineOptions["workflow"]>({ get });
}

describe("makeCloudflareWorkflowEngineLayer", () => {
  test("preserves a Cloudflare step rejection message", async () => {
    const step = testStub<CloudflareWorkflowEngineOptions["step"]>({
      do: async () => {
        throw new Error("runtime rejected step");
      },
      sleep: async () => undefined,
      waitForEvent: async () => ({ payload: null }),
    });

    const program = Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine;
        yield* engine.register(TestWorkflow, () => TestActivity);
        return yield* engine.execute(TestWorkflow, {
          executionId: "test-execution",
          payload: {},
        });
      }),
    ).pipe(
      Effect.provide(
        makeCloudflareWorkflowEngineLayer({
          step,
          workflow: fakeWorkflowBinding(),
        }),
      ),
    );

    await expect(Effect.runPromise(program)).rejects.toThrow("runtime rejected step");
  });

  test("uses the injected activity configuration without reading Function.bind", async () => {
    const calls: Array<{ name: string; timeout: unknown }> = [];
    const doStep = new Proxy(
      async (
        name: string,
        config: { timeout?: unknown },
        callback: () => Promise<unknown>,
      ): Promise<unknown> => {
        calls.push({ name, timeout: config.timeout });
        return await callback();
      },
      {
        get(target, property, receiver) {
          if (property === "bind") {
            throw new Error('The RPC receiver does not implement the method "bind".');
          }
          return Reflect.get(target, property, receiver);
        },
      },
    );
    const step = testStub<CloudflareWorkflowEngineOptions["step"]>({
      do: doStep,
      sleep: async () => undefined,
      waitForEvent: async () => ({ payload: null }),
    });

    const program = Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine;
        yield* engine.register(TestWorkflow, () => TestActivity);
        return yield* engine.execute(TestWorkflow, {
          executionId: "test-execution",
          payload: {},
        });
      }),
    ).pipe(
      Effect.provide(
        makeCloudflareWorkflowEngineLayer({
          activityStepConfig: () => ({ timeout: "30 minutes" }),
          step,
          workflow: fakeWorkflowBinding(),
        }),
      ),
    );

    await expect(Effect.runPromise(program)).resolves.toBe("ok");
    expect(calls).toEqual([{ name: "first step", timeout: "30 minutes" }]);
  });

  test("uses the injected binding for instance control", async () => {
    const requestedExecutionIds: string[] = [];
    const workflow = fakeWorkflowBinding(async (executionId) => {
      requestedExecutionIds.push(executionId);
      return {
        resume: async () => undefined,
        sendEvent: async () => undefined,
        status: async () => ({ output: "done", status: "complete" }),
        terminate: async () => undefined,
      };
    });
    const step = testStub<CloudflareWorkflowEngineOptions["step"]>({
      do: async () => null,
      sleep: async () => undefined,
      waitForEvent: async () => ({ payload: null }),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine;
        return yield* engine.poll(TestWorkflow, "injected-execution");
      }).pipe(Effect.provide(makeCloudflareWorkflowEngineLayer({ step, workflow }))),
    );

    expect(requestedExecutionIds).toEqual(["injected-execution"]);
    expect(Option.isSome(result)).toBe(true);
  });
});
