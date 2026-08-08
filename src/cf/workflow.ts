import type {
  CloudflareWorkersModule,
  Rpc,
  Workflow as CloudflareWorkflowBinding,
} from "@cloudflare/workers-types";
import { Data, Duration, Effect, Exit, Layer, Option, Schema } from "effect";
import { Activity, Workflow, WorkflowEngine } from "effect/unstable/workflow";

type WorkflowStep = CloudflareWorkersModule.WorkflowStep;
type WorkflowStepConfig = CloudflareWorkersModule.WorkflowStepConfig;
type WorkflowStepContext = CloudflareWorkersModule.WorkflowStepContext;

const defaultActivityStepConfig: WorkflowStepConfig = {
  retries: { backoff: "exponential", delay: "5 seconds", limit: 3 },
  timeout: "10 minutes",
};

const storedWorkflowResultSchema = Schema.toCodecJson(
  Workflow.Result({ error: Schema.Any, success: Schema.Any }),
);
const storedDeferredExitSchema = Schema.toCodecJson(
  Schema.Exit(Schema.Any, Schema.Any, Schema.Defect()),
);
const deferredEventTimeoutMs = 365 * 24 * 60 * 60 * 1_000;

type SerializableWorkflowStepCallback = (
  context: WorkflowStepContext,
) => Promise<Rpc.Serializable<unknown>>;

/** Failure reported by a Cloudflare Workflow operation. */
export class CloudflareWorkflowError extends Data.TaggedError("CloudflareWorkflowError")<{
  readonly cause: unknown;
  readonly message: string;
}> {}

/** Dependencies and activity policy for the Cloudflare Workflow engine adapter. */
export type CloudflareWorkflowEngineOptions = {
  /** Binding used to control workflow instances by execution ID. */
  readonly workflow: CloudflareWorkflowBinding;
  /** Step handle for the currently running Cloudflare Workflow instance. */
  readonly step: WorkflowStep;
  /** Optional per-activity override for Cloudflare retry and timeout settings. */
  readonly activityStepConfig?:
    | ((activityName: string) => WorkflowStepConfig | undefined)
    | undefined;
};

/**
 * Provides Effect's `WorkflowEngine` using an explicitly injected Cloudflare
 * Workflow binding and the current instance's step handle.
 */
export function makeCloudflareWorkflowEngineLayer(
  options: CloudflareWorkflowEngineOptions,
): Layer.Layer<WorkflowEngine.WorkflowEngine> {
  return Layer.effect(
    WorkflowEngine.WorkflowEngine,
    Effect.sync(() => {
      const stepDo = (name: string, config: WorkflowStepConfig, callback: () => Promise<unknown>) =>
        options.step.do(
          name,
          config,
          // SAFETY: Activity results are encoded with `Schema.toCodecJson` before
          // crossing the Cloudflare step boundary, so the callback resolves only
          // with values accepted by Cloudflare's RPC serializer.
          callback as SerializableWorkflowStepCallback,
        ) as Promise<unknown>;

      const registrations = new Map<
        string,
        {
          readonly execute: (
            payload: object,
            executionId: string,
          ) => Effect.Effect<
            unknown,
            unknown,
            WorkflowEngine.WorkflowEngine | WorkflowEngine.WorkflowInstance
          >;
        }
      >();

      const engine = WorkflowEngine.makeUnsafe({
        activityExecute: (activity, attempt) =>
          Effect.gen(function* () {
            const instance = yield* WorkflowEngine.WorkflowInstance;
            // oxlint-disable-next-line no-explicit-any -- SAFETY: Activity.Any erases its environment, so the unsafe engine adapter must capture and restore the complete runtime context.
            const context = yield* Effect.context<any>();
            const activityInstance = WorkflowEngine.WorkflowInstance.initial(
              instance.workflow,
              instance.executionId,
            );
            activityInstance.interrupted = instance.interrupted;

            const runInCurrentContext = Effect.runPromiseWith(context);
            const result = yield* Effect.tryPromise({
              try: () =>
                stepDo(
                  activityStepName(activity.name, attempt),
                  options.activityStepConfig?.(activity.name) ?? defaultActivityStepConfig,
                  () =>
                    runInCurrentContext(
                      activity.executeEncoded.pipe(
                        Workflow.intoResult,
                        Effect.flatMap((activityResult) =>
                          Schema.encodeEffect(storedWorkflowResultSchema)(activityResult),
                        ),
                        Effect.provideService(WorkflowEngine.WorkflowInstance, activityInstance),
                        Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
                        Effect.provideService(Activity.CurrentAttempt, attempt),
                      ),
                    ),
                ),
              catch: asCloudflareWorkflowError,
            }).pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(storedWorkflowResultSchema)),
              Effect.orDie,
            );
            return result;
          }) as Effect.Effect<
            Workflow.Result<unknown, unknown>,
            never,
            WorkflowEngine.WorkflowInstance
          >,
        deferredDone: (deferredOptions) =>
          Effect.gen(function* () {
            const payload = yield* Schema.encodeEffect(storedDeferredExitSchema)(
              deferredOptions.exit,
            ).pipe(Effect.orDie);
            yield* Effect.tryPromise({
              try: () =>
                options.workflow.get(deferredOptions.executionId).then((instance) =>
                  instance.sendEvent({
                    payload,
                    type: deferredEventType(deferredOptions.deferredName),
                  }),
                ),
              catch: asCloudflareWorkflowError,
            }).pipe(Effect.orDie);
          }),
        deferredResult: (deferred) =>
          Effect.gen(function* () {
            const event = yield* Effect.tryPromise({
              try: () =>
                options.step.waitForEvent(`DurableDeferred/${deferred.name}`, {
                  timeout: deferredEventTimeoutMs,
                  type: deferredEventType(deferred.name),
                }),
              catch: asCloudflareWorkflowError,
            }).pipe(Effect.orDie);
            const exit = yield* Schema.decodeUnknownEffect(storedDeferredExitSchema)(
              event.payload,
            ).pipe(Effect.orDie);
            return Option.some(exit);
          }),
        execute: (workflow, executeOptions) =>
          Effect.gen(function* () {
            const registration = registrations.get(workflow._tag);
            if (!registration) {
              return yield* Effect.die(`Workflow ${workflow._tag} is not registered.`);
            }

            const instance = WorkflowEngine.WorkflowInstance.initial(
              workflow,
              executeOptions.executionId,
            );
            const result = yield* registration
              .execute(executeOptions.payload, executeOptions.executionId)
              .pipe(
                Workflow.intoResult,
                Effect.provideService(WorkflowEngine.WorkflowInstance, instance),
                Effect.provideService(WorkflowEngine.WorkflowEngine, engine),
              );

            if (executeOptions.discard) return;
            return result;
          }) as Effect.Effect<
            typeof executeOptions.discard extends true ? void : Workflow.Result<unknown, unknown>
          >,
        interrupt: (_workflow, executionId) =>
          Effect.tryPromise({
            try: () => options.workflow.get(executionId).then((instance) => instance.terminate()),
            catch: asCloudflareWorkflowError,
          }).pipe(Effect.orDie),
        interruptUnsafe: (_workflow, executionId) =>
          Effect.tryPromise({
            try: () => options.workflow.get(executionId).then((instance) => instance.terminate()),
            catch: asCloudflareWorkflowError,
          }).pipe(Effect.orDie),
        poll: (_workflow, executionId) =>
          Effect.tryPromise({
            try: () => options.workflow.get(executionId).then((instance) => instance.status()),
            catch: asCloudflareWorkflowError,
          }).pipe(
            Effect.map((status) => {
              if (status.status === "complete") {
                return Option.some(
                  new Workflow.Complete({ exit: Exit.succeed(status.output ?? null) }),
                );
              }
              if (status.status === "errored" || status.status === "terminated") {
                return Option.some(
                  new Workflow.Complete({
                    exit: Exit.fail(
                      status.error ?? {
                        message: `Workflow ${executionId} ended with status ${status.status}.`,
                        name: status.status,
                      },
                    ),
                  }),
                );
              }
              return Option.none();
            }),
            Effect.orDie,
          ),
        register: (workflow, execute) =>
          Effect.sync(() => {
            registrations.set(workflow._tag, { execute });
          }),
        resume: (_workflow, executionId) =>
          Effect.tryPromise({
            try: () => options.workflow.get(executionId).then((instance) => instance.resume()),
            catch: asCloudflareWorkflowError,
          }).pipe(Effect.orDie),
        scheduleClock: (workflow, clockOptions) =>
          Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: () =>
                options.step.sleep(
                  `DurableClock/${clockOptions.clock.name}`,
                  Duration.toMillis(clockOptions.clock.duration),
                ),
              catch: asCloudflareWorkflowError,
            }).pipe(Effect.orDie);
            yield* engine.deferredDone(clockOptions.clock.deferred, {
              deferredName: clockOptions.clock.deferred.name,
              executionId: clockOptions.executionId,
              exit: Exit.void,
              workflowName: workflow._tag,
            });
          }),
      });

      return engine;
    }),
  );
}

function activityStepName(name: string, attempt: number): string {
  if (attempt <= 1) return name;
  return `${name} (attempt ${attempt})`;
}

function deferredEventType(deferredName: string): string {
  const hash = hashEventKey(deferredName);
  const safeName = deferredName.replaceAll(/[^a-zA-Z0-9_-]/g, "-").replaceAll(/-+/g, "-");
  const maxNameLength = 100 - "df__".length - hash.length;
  return `df_${(safeName || "deferred").slice(0, maxNameLength)}_${hash}`;
}

function hashEventKey(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function asCloudflareWorkflowError(cause: unknown): CloudflareWorkflowError {
  let message = typeof cause === "string" ? cause : undefined;
  if (cause instanceof Error) {
    message = cause.message;
  }
  if (!message) {
    try {
      message = JSON.stringify(cause) || String(cause);
    } catch {
      message = String(cause);
    }
  }

  return new CloudflareWorkflowError({ cause, message });
}
