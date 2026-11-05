# Desktop command output recovery

A command start and its output delivery have different lifetimes. Reconnecting
must never invoke an execution request again. `OperationChannelRouter` owns the
existing per-command channel and duplicate-start fence; the Desktop bridge owns
the native invocation; `AcknowledgedCommandOutput` owns retained delivery.

## Negotiation and receipt

New workers request `outputProtocol: "ack-v1"` only for isolated Desktop command
channels. A supporting Desktop labels every output frame with that protocol and
a consecutive sequence. An older Desktop ignores the request and emits its
existing stream; the worker keeps its legacy completeness checks. CLI, file and
PTY protocols are unchanged.

The worker accepts only the next consecutive frame, deduplicates older frames,
and requests resume at its last contiguous cursor when a gap or resubscription
occurs. Cumulative `command_output_ack` messages acknowledge receiver acceptance,
not merely broker acceptance. Desktop retains frames until that cursor advances;
a lost frame or ACK causes output replay with the original sequence, never
execution replay. Stale controls cannot rewind the cursor, and a future cursor
cannot discard output that has not been sent. Controls remain scoped to the
accepted command route and target connection.

A native exit does not close the operation channel. The terminal frame stays
available until acknowledged or the original execution-plus-delivery deadline
expires. Stop still uses the existing idempotent cancellation protocol. Auth
termination, session replacement and explicit bridge stop end delivery ownership.
Confirmed cancellation discards the output window immediately; the lightweight
route stays available until its existing TTL so a lost cancellation response can
still be answered on retry.

## Bounds and failure semantics

The unacknowledged window is capped at 8 MiB and 4,096 frames per command; the
router caps concurrent operations at 100. The sender sends at most 32 outstanding
frames per pass, retries unacknowledged frames after one second, and uses the
existing execution timeout plus 30-second delivery grace. It does not extend
native execution. A full window or exhausted deadline reports unavailable
output; the worker preserves partial output and reports an unknown outcome.

Acknowledgements describe the live receiver's contiguous output, not a durable
worker checkpoint. This protocol recovers transport disconnects while the native
bridge and worker operation remain alive. It does not reconstruct a killed
worker, restart a process after app exit, or promise exactly-once execution across
crashes. Existing persisted terminal execution records remain the recovery source
for process loss. Missing state must never be repaired by rerunning a command.

Tests should drop both publications and ACKs, interrupt only one peer, lose the
terminal frame, reorder controls, cancel during recovery, exhaust bounds, and
verify duplicate starts do not execute. Native acceptance must additionally show
real command output before an outage, completion afterward, and saved-result
persistence after restarting the app.
