import { type Context, Effect, type Layer } from "effect";

/**
 * Creates a Promise-based test runner for one Effect service and its test layer.
 * The callback may fail in the Effect error channel but must not require services
 * beyond the service supplied to it.
 */
export function runWithService<Identifier, Service, LayerError>(
  service: Context.Service<Identifier, Service>,
  layer: Layer.Layer<Identifier, LayerError>,
): <A, E>(use: (service: Service) => Effect.Effect<A, E>) => Promise<A> {
  return <A, E>(use: (service: Service) => Effect.Effect<A, E>) =>
    Effect.runPromise(service.use(use).pipe(Effect.provide(layer)));
}
