declare module "cloudflare:workers" {
  /** Minimal runtime declaration for Durable Object classes used by this package. */
  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: import("@cloudflare/workers-types").DurableObjectState;
    protected readonly env: Env;

    constructor(ctx: import("@cloudflare/workers-types").DurableObjectState, env: Env);

    alarm?(
      alarmInfo?: import("@cloudflare/workers-types").AlarmInvocationInfo,
    ): void | Promise<void>;
  }
}
