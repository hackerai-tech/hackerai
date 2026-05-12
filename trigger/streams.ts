import { streams } from "@trigger.dev/sdk";
import { AGENT_UI_STREAM_ID } from "./stream-ids";

export { AGENT_UI_STREAM_ID } from "./stream-ids";

/**
 * Typed stream definition for the agent-long UI message stream.
 * Only import this from trigger task files — it pulls in @trigger.dev/sdk
 * (ESM-only) which breaks Jest. Frontend/transport code should import
 * AGENT_UI_STREAM_ID from ./stream-ids instead.
 */
export const agentUiStream = streams.define<unknown>({
  id: AGENT_UI_STREAM_ID,
});
