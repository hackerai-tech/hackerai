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

## Run recovery windows

An Agent run recovers a host outage only within a window fixed at its first
interruption. A host that has not proven its native session (a CLI host or an
older Desktop binary without launch identity) cannot vouch for earlier
commands, so its departure stops the run; only the observer's own outage may
recover, within 15 seconds. A host that proved its session may return for the
presence grace, 120 seconds. The backend keeps an unheard connection for at
least 120 seconds after its last heartbeat, which can be up to one heartbeat
interval (30 seconds) before the interruption, so a return late in the window
can find the connection already disconnected and the run stops. Readiness after any
outage still requires a fresh proof from the same launch and page. Every
in-flight command must then be either reconciled or settled as unknown (see
below), and nothing is re-sent.

Re-registering mints a connection that can never satisfy a waiting run and
discards retained output. After a session challenge or targeted operation in
the last 15 minutes, the Desktop bridge therefore keeps reconnecting the same
connection for the run's window; an idle bridge still renegotiates its
transport after 30 seconds. A terminal SDK disconnect still re-registers at
once, and a run stopped this way waits for the user to resume it. A bridge
stopping on purpose (sign-out, page unload, switching Desktop off) first
publishes an end notice on its own connection, so its run stops at once; a
force quit or crash that runs no page code is bounded by the window instead.
The notice can only end a run, and only the relay's publisher record makes it
authoritative.

## Unknown outcomes

When the same session returns but cannot account for an operation, the run
continues instead of stopping. This covers a command whose output the session
no longer retains, and any open terminal, since terminal output is unsequenced
and has no replay. Each such operation is settled as an unknown outcome before
dispatch reopens. Its tool call reports `executionOutcome: "unknown"` with the
same do-not-rerun guidance as Ask mode. A terminal refuses further input. The
operation stays recorded for the run as unknown. It is never named in a later
challenge and never published again.

An operation can also lose its outcome while the host is verified. Causes
include a delivery deadline, unavailable output, an unconfirmed Stop, a
terminal transport failure, unconfirmed input, or a kill with no observed
exit. The operation is recorded the same way, and no later dispatch is
admitted until the same session answers a fresh challenge. That re-verification
does not settle other operations, because their streams were not interrupted.
The rejection carries the unknown outcome, so automatic retries, such as an
attachment transfer's timeout retry or a re-staging after reconnect, never send
it again. An exit that arrives while the host is unverified is still reported
as an exit, with a warning that output sent before it may be missing.

A Stop or kill never reports such a command as terminated. Its receiver is
already closed, so no `command_cancel` is sent; the tool keeps the session and
reports the outcome as unknown. The remaining fragments of a request whose
outcome became unknown during publication are never sent.

A host that never proved its session (a CLI host or an older binary) cannot
answer such a challenge, so an unknown outcome still stops its run. A
different launch or page still stops the run as before.

Terminals are still killed at the end of each response. A live terminal
handle belongs to the run's worker process, there is no protocol for a later
run to reattach to it, and the native side does not reap idle terminals. When
a kill gets no exit in time, the terminal's execution record says `unknown`
(possibly still running) for later turns, and the completion check proceeds
normally rather than reporting a lost connection. A terminal that fails while
its connection stays usable keeps its route open until that kill is sent.

A stop for `desktop_command_unreconciled` records a closed cause and the
operation kind. Any stop while verification is open records whether that was
an outage, the completion check, or re-verification. Runs also report how many
operations they continued past with an unknown outcome.

A native write larger than one relay message is sent as a truncating first
chunk plus appends. If any chunk is unconfirmed, the result is unknown: the
file may be truncated or partly written. The tool says so and asks for one
complete rewrite rather than appending the remainder.
