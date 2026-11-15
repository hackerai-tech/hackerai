import type { Doc } from "../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "./serviceFunctions";

export const findHeartbeat = (db: DatabaseReader, connectionId: string) =>
  db
    .query("local_sandbox_heartbeats")
    .withIndex("by_connection_id", (q) => q.eq("connection_id", connectionId))
    .unique();

export async function lastHeartbeat(
  db: DatabaseReader,
  connection: Doc<"local_sandbox_connections">,
) {
  const heartbeat = await findHeartbeat(db, connection.connection_id);
  return heartbeat?.last_heartbeat ?? connection.last_heartbeat;
}

// Call only after authenticating the active connection. Lazy creation lets old
// sessions migrate on their next heartbeat without a table-wide backfill.
export async function recordHeartbeat(
  ctx: MutationCtx,
  connection: Doc<"local_sandbox_connections">,
) {
  const heartbeat = await findHeartbeat(ctx.db, connection.connection_id);
  if (heartbeat) {
    await ctx.db.patch(heartbeat._id, { last_heartbeat: Date.now() });
  } else {
    await ctx.db.insert("local_sandbox_heartbeats", {
      connection_id: connection.connection_id,
      user_id: connection.user_id,
      last_heartbeat: Date.now(),
    });
  }
}
