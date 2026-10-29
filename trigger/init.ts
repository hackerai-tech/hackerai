import { registerServiceTransportObserver } from "../lib/db/service-transport-observation.node";

// Trigger loads init.ts in each worker before task execution.
registerServiceTransportObserver();
