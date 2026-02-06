import { nextJsAxiomLogger } from "@/lib/axiom/server";
import { createOnRequestError } from "@axiomhq/nextjs";

export const onRequestError = createOnRequestError(nextJsAxiomLogger);
