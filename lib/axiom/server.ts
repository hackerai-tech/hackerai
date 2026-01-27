import axiomClient from "@/lib/axiom/axiom";
import { Logger, AxiomJSTransport } from "@axiomhq/logging";
import { createAxiomRouteHandler, nextJsFormatters } from "@axiomhq/nextjs";

export const logger = new Logger({
  transports: [
    new AxiomJSTransport({
      axiom: axiomClient,
      dataset: process.env.AXIOM_DATASET!,
    }),
  ],
  formatters: nextJsFormatters,
});

export const withAxiom = createAxiomRouteHandler(logger);
