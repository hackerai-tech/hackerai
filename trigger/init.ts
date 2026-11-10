import { tasks } from "@trigger.dev/sdk";
import { runWithServiceQueryRecovery } from "../lib/db/service-query-recovery.node";
import { registerServiceTransportObserver } from "../lib/db/service-transport-observation.node";

// Trigger loads init.ts in each worker before task execution.
registerServiceTransportObserver();

// Streaming tasks still have maxAttempts=1. Only bounded, pure reads inside
// that one execution can recover; no task, tool, action or mutation is replayed.
tasks.middleware(
  "bounded-service-query-recovery",
  async ({ task, signal, next }) => {
    if (task === "agent-long" || task === "hackerai-subagent") {
      await runWithServiceQueryRecovery(next, signal);
    } else {
      await next();
    }
  },
);
