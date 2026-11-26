import { v } from "convex/values";
import {
  LOCAL_AUTO_CONTINUE_REASONS,
  LOCAL_AUTO_CONTINUE_STATES,
} from "../../lib/chat/local-auto-continue";

const literals = <T extends string>(values: readonly T[]) =>
  v.union(...values.map((value) => v.literal(value)));

export const localAutoContinueStateValidator = literals(
  LOCAL_AUTO_CONTINUE_STATES,
);
export const localAutoContinueReasonValidator = literals(
  LOCAL_AUTO_CONTINUE_REASONS,
);
