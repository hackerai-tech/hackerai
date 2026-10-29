import { AsyncLocalStorage } from "node:async_hooks";
import { channel } from "node:diagnostics_channel";
import {
  serviceTransportObserverKey,
  serviceTransportRuntime,
} from "./service-transport-observation";

interface Observation {
  origin: string;
  path: string;
  active: boolean;
  request?: object;
  fields: Record<string, string | number | boolean>;
}
interface DiagnosticMessage {
  request: { origin?: string; path?: string; method?: string };
  socket?: object;
}

/** Observe the existing dispatcher; never install a new agent or retry a call. */
export function registerServiceTransportObserver() {
  if (serviceTransportRuntime[serviceTransportObserverKey]) return;
  const context = new AsyncLocalStorage<Observation>();
  const requests = new WeakMap<object, Observation>();
  const sockets = new WeakMap<object, number>();
  const connectedAt = new WeakMap<object, number>();
  const subscribe = (
    name: string,
    handler: (message: DiagnosticMessage) => void,
  ) => {
    channel(name).subscribe((message) => {
      try {
        handler(message as DiagnosticMessage);
      } catch {
        // Throwing from a diagnostics-channel subscriber can crash Node.
      }
    });
  };
  subscribe("undici:client:connected", ({ socket }) => {
    // Save only a timestamp keyed by the socket. Attribute it later, when
    // sendHeaders supplies the exact request/socket pair.
    if (socket) connectedAt.set(socket, performance.now());
  });
  subscribe("undici:request:create", ({ request }) => {
    const observation = context.getStore();
    if (
      !observation?.active ||
      request.origin !== observation.origin ||
      request.path !== observation.path ||
      request.method !== "POST"
    )
      return;
    requests.set(request, observation);
    observation.request = request;
    const count = Number(observation.fields.transport_request_count ?? 0) + 1;
    observation.fields = {
      transport_observation: "request_created",
      transport_request_count: count,
    };
  });
  subscribe("undici:client:sendHeaders", ({ request, socket }) => {
    const observation = requests.get(request);
    if (!observation?.active || observation.request !== request || !socket)
      return;
    const now = performance.now();
    const previous = sockets.get(socket);
    const connected = connectedAt.get(socket);
    sockets.set(socket, now);
    observation.fields.transport_observation = "socket_assigned";
    if (connected !== undefined)
      observation.fields.socket_connection_age_ms = Math.max(
        0,
        Math.round(now - connected),
      );
    else delete observation.fields.socket_connection_age_ms;
    // First observation does not prove a fresh connection: it may predate
    // registration or have carried traffic outside this service adapter.
    observation.fields.socket_prior_service_use_observed =
      previous !== undefined;
    if (previous !== undefined)
      observation.fields.socket_previous_dispatch_age_ms = Math.max(
        0,
        Math.round(now - previous),
      );
    else delete observation.fields.socket_previous_dispatch_age_ms;
  });
  subscribe("undici:request:bodySent", ({ request }) => {
    const observation = requests.get(request);
    if (observation?.active && observation.request === request)
      observation.fields.transport_observation = "request_body_sent";
  });
  subscribe("undici:request:headers", ({ request }) => {
    const observation = requests.get(request);
    if (observation?.active && observation.request === request)
      observation.fields.transport_observation = "response_headers_received";
  });
  // beforeConnect/connectError are pool events, not request-specific. Do not
  // attribute them using ALS; queued concurrent requests can share that pool.
  serviceTransportRuntime[serviceTransportObserverKey] = (url) => {
    const observation: Observation = {
      origin: url.origin,
      path: url.pathname + url.search,
      active: true,
      fields: { transport_observation: "no_request_event" },
    };
    return {
      run: (operation) => context.run(observation, operation),
      snapshot: () => ({ ...observation.fields }),
      finish: () => {
        observation.active = false;
      },
    };
  };
}
