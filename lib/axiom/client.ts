"use client";

import { Logger, ProxyTransport } from "@axiomhq/logging";
import { createUseLogger, createWebVitalsComponent } from "@axiomhq/react";

export const logger = new Logger({
  transports: [new ProxyTransport({ url: "/api/axiom", autoFlush: true })],
});

const useLogger = createUseLogger(logger);
const WebVitals = createWebVitalsComponent(logger);

export { useLogger, WebVitals };
