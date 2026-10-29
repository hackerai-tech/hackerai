// Keep this bridge free of Node imports: Convex also analyzes service-client.
// A global symbol shares the observer across separately bundled server entries.
export interface ServiceTransportObservation {
  run<T>(operation: () => T): T;
  snapshot(): Record<string, string | number | boolean>;
  finish(): void;
}

export const serviceTransportObserverKey = Symbol.for(
  "hackerai.serviceTransportObserver.v1",
);
export type ServiceTransportObserver = (
  url: URL,
) => ServiceTransportObservation;
export const serviceTransportRuntime = globalThis as typeof globalThis & {
  [serviceTransportObserverKey]?: ServiceTransportObserver;
};

export function observeServiceTransport(url: URL): ServiceTransportObservation {
  try {
    const observer = serviceTransportRuntime[serviceTransportObserverKey];
    if (observer) return observer(url);
  } catch {
    // Diagnostics are optional in runtimes without Node instrumentation.
  }
  return {
    run: (operation) => operation(),
    snapshot: () => ({ transport_observation: "unavailable" }),
    finish: () => {},
  };
}
