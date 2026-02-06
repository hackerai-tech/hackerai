import axiomClient from "@/lib/axiom/axiom";
import { Logger, AxiomJSTransport } from "@axiomhq/logging";
import { nextJsFormatters } from "@axiomhq/nextjs";

export const nextJsAxiomLogger = new Logger({
  transports: [
    new AxiomJSTransport({
      axiom: axiomClient,
      dataset: process.env.AXIOM_DATASET!,
    }),
  ],
  formatters: nextJsFormatters,
});
