"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { abuseStatuses } from "@/lib/abuse/operator";
import type { Doc } from "@/convex/_generated/dataModel";
import type { AbuseReport } from "@/lib/abuse/report";

type Case = Omit<
  Doc<"abuse_cases">,
  "ciphertext" | "digest" | "operationToken"
> & { report: AbuseReport | null };
type Event = Omit<Doc<"abuse_events">, "ciphertext"> & {
  detail: { text: string } | null;
};
type QueueItem = Pick<Case, "reference" | "kind" | "status" | "updatedAt">;
const statusLabels: Record<Case["status"], string> = {
  new: "New",
  reviewing: "Reviewing",
  containing: "Containment in progress",
  contained: "Contained",
  needs_followup: "Needs follow-up",
  resolved: "Resolved",
};
const operations = [
  ["annotate", "Add review note"],
  ["contain", "Restrict and contain"],
  ["retry", "Retry existing containment"],
  ["stop_without_snapshot", "Stop without full snapshot"],
  ["confirm_local_stop", "Record local / Desktop process verification"],
  ["resolve", "Resolve this case restriction"],
  ["reconcile_snapshot", "Reconcile possible provider snapshot"],
  ["hold", "Change evidence hold"],
  ["erase", "Delete case evidence"],
] as const;
type Operation = (typeof operations)[number][0];
const labels: Partial<Record<keyof AbuseReport, string>> = {
  email: "Contact email",
  target: "Affected system",
  occurredAt: "Reported time",
  description: "Description",
  sourceIp: "Source address",
  sourcePort: "Source port",
  protocol: "Protocol",
  reference: "Reporter-provided reference",
  evidence: "Evidence excerpt",
};
const selectClass =
  "h-11 w-full rounded-md border border-input bg-background px-3 text-sm";
const date = (time: number) =>
  new Date(time).toISOString().replace("T", " ").slice(0, 19) + " UTC";
class OperatorRequestError extends Error {}

async function request(body: unknown) {
  const response = await fetch("/api/internal/abuse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(305_000),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => null);
    if (failure?.code === "ABUSE_ACTIVE_ROOT_CHANGED")
      throw new OperatorRequestError(
        "Rejected: the selected root is not the current active run for this user and chat. This action changed nothing. For a completed or replaced run, use the late-report procedure in the abuse-response runbook.",
      );
    throw new OperatorRequestError(
      "Action unconfirmed. Reload the case to inspect saved progress. Check the revision, reviewed attribution, existing containment, and action requirements before retrying. An interrupted operation remains locked for up to ten minutes.",
    );
  }
  return response.json();
}

export default function OperatorReview() {
  const [status, setStatus] = useState<(typeof abuseStatuses)[number]>("new");
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [queueCursor, setQueueCursor] = useState<string | null>(null);
  const [reference, setReference] = useState("");
  const [selected, setSelected] = useState<Case | null>(null);
  const [restrictionStatus, setRestrictionStatus] = useState<
    "active" | "resolved" | null
  >(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [eventsCursor, setEventsCursor] = useState<string | null>(null);
  const [operation, setOperation] = useState<Operation>("annotate");
  const [cloud, setCloud] = useState(false);
  const [scopeInputs, setScopeInputs] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function run(work: () => Promise<void>) {
    if (pending) return;
    setPending(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (failure) {
      setError(
        failure instanceof OperatorRequestError
          ? failure.message
          : "Action unconfirmed. Reload the case before acting again. No process stop has been established by this error.",
      );
    } finally {
      setPending(false);
    }
  }
  async function loadCase(value: string, cursor: string | null = null) {
    const result = await request({ action: "read", reference: value, cursor });
    setSelected(result.case);
    setRestrictionStatus(result.restrictionStatus);
    setReference(value);
    setEvents((previous) =>
      cursor ? [...previous, ...result.events] : result.events,
    );
    setEventsCursor(result.isDone ? null : result.continueCursor);
  }
  async function loadQueue(cursor: string | null = null) {
    const result = await request({ action: "list", status, cursor });
    setQueue((previous) =>
      cursor ? [...previous, ...result.page] : result.page,
    );
    setQueueCursor(result.isDone ? null : result.continueCursor);
  }
  async function act(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    const fields = new FormData(event.currentTarget);
    const input: Record<string, unknown> = {
      action: operation,
      reference: selected.reference,
      expectedRevision: selected.revision,
    };
    const value = (key: string) => String(fields.get(key) ?? "").trim();
    if (!["retry", "erase", "reconcile_snapshot"].includes(operation))
      input.decision = value("decision");
    if (operation === "annotate") input.kind = value("kind");
    if (operation === "hold") input.hold = value("hold") === "true";
    if (operation === "erase") input.confirmation = value("confirmation");
    if (operation === "stop_without_snapshot")
      input.acknowledgeEvidenceLoss = fields.has("acknowledge");
    if (operation === "contain")
      Object.assign(input, {
        userId: value("userId"),
        chatId: value("chatId"),
        runId: value("runId"),
        acknowledgeImpact: fields.has("acknowledge"),
        preserveSnapshot: cloud && fields.has("preserveSnapshot"),
        ...(cloud
          ? { sandboxId: value("sandboxId"), region: value("region") }
          : {}),
      });
    await run(async () => {
      const result = await request(input);
      await loadCase(selected.reference);
      setMessage(
        result.more
          ? "Evidence deletion is incomplete. Repeat this action with the updated revision to remove the next batch."
          : "Action recorded. Inspect the case and separate run, process, and workspace states below.",
      );
    });
  }
  const scope = selected?.containment;
  const locked =
    selected?.status === "containing" &&
    (selected.operationExpiresAt ?? 0) > Date.now();
  const unavailable =
    !selected ||
    (operation === "contain" &&
      (Boolean(scope) || selected.status === "resolved")) ||
    (operation === "retry" &&
      (!scope ||
        !["containing", "needs_followup"].includes(selected.status) ||
        locked)) ||
    (operation === "stop_without_snapshot" &&
      (!scope ||
        scope.transport !== "cloud" ||
        !scope.snapshotRequested ||
        Boolean(scope.snapshotId) ||
        locked)) ||
    (operation === "confirm_local_stop" &&
      (!scope ||
        scope.transport === "cloud" ||
        selected.status !== "needs_followup")) ||
    (operation === "resolve" &&
      (selected.status === "resolved" || selected.status === "containing")) ||
    (operation === "reconcile_snapshot" &&
      (!scope?.snapshotName || selected.status === "containing")) ||
    (operation === "erase" &&
      (selected.status !== "resolved" || selected.evidenceHold)) ||
    (["annotate", "hold"].includes(operation) && !selected.report);

  return (
    <div className="ph-no-capture mt-10 space-y-9" data-ph-no-capture>
      <section className="space-y-4 border-t pt-7">
        <h2 className="text-lg font-medium">Review queue</h2>
        <div className="flex flex-col gap-3 sm:flex-row">
          <label className="flex-1 text-sm">
            Status
            <select
              className={`${selectClass} mt-2`}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as typeof status);
                setQueue([]);
                setQueueCursor(null);
              }}
            >
              {abuseStatuses.map((item) => (
                <option key={item} value={item}>
                  {statusLabels[item]}
                </option>
              ))}
            </select>
          </label>
          <Button
            disabled={pending}
            className="h-11 sm:self-end"
            onClick={() => run(() => loadQueue())}
          >
            Load queue
          </Button>
        </div>
        <ul className="divide-y">
          {queue.map((row) => (
            <li key={row.reference} className="space-y-2 py-4 text-sm">
              <p className="break-all font-mono text-xs">{row.reference}</p>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-muted-foreground">
                  {row.kind === "abuse" ? "Report" : "Appeal"} ·{" "}
                  {statusLabels[row.status]} · {date(row.updatedAt)}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => run(() => loadCase(row.reference))}
                >
                  Open (audited)
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {queueCursor && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => run(() => loadQueue(queueCursor))}
          >
            Load more cases
          </Button>
        )}
      </section>
      <form
        className="space-y-3 border-t pt-7"
        onSubmit={(event) => {
          event.preventDefault();
          void run(() => loadCase(reference.trim()));
        }}
      >
        <label htmlFor="case-reference" className="text-sm font-medium">
          Open by reference
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input
            id="case-reference"
            value={reference}
            onChange={(event) => setReference(event.target.value)}
            className="h-11 font-mono text-xs"
            required
          />
          <Button className="h-11" disabled={pending}>
            Open (audited)
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Opening evidence records your operator identity and time.
        </p>
      </form>
      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive p-4 text-sm leading-6"
        >
          {error}
        </div>
      )}
      {message && (
        <p role="status" className="rounded-md border p-4 text-sm leading-6">
          {message}
        </p>
      )}
      {selected && (
        <>
          <section className="space-y-5 border-t pt-7">
            <h2 className="break-all font-mono text-sm">
              {selected.reference}
            </h2>
            <p className="text-sm">
              {selected.kind === "abuse" ? "Report" : "Appeal"} ·{" "}
              {statusLabels[selected.status]} · Revision {selected.revision} ·
              Evidence hold {selected.evidenceHold ? "on" : "off"}
            </p>
            <p className="text-xs leading-6 text-muted-foreground">
              Submitted fields are allegations. Links are displayed as plain
              text and are not fetched by this page.
            </p>
            {selected.report ? (
              <dl className="space-y-4">
                {Object.entries(labels).map(([key, label]) => (
                  <div
                    key={key}
                    className="grid gap-1 sm:grid-cols-[170px_1fr]"
                  >
                    <dt className="text-sm text-muted-foreground">{label}</dt>
                    <dd className="whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">
                      {String(
                        selected.report?.[key as keyof AbuseReport] ||
                          "Not provided",
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                Report evidence has been deleted. Audit metadata and any
                snapshot references remain.
              </p>
            )}
          </section>
          {scope && (
            <section className="space-y-4 border-t pt-7">
              <h2 className="text-lg font-medium">Containment status</h2>
              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                {Object.entries({
                  Transport: scope.transport,
                  "Case security restriction":
                    restrictionStatus ?? "No matching restriction recorded",
                  "Restriction source": `abuse:${selected.reference}`,
                  "Trigger runs": scope.triggerState,
                  "Child run scope": scope.childRunIds.length
                    ? scope.childRunIds.join(", ")
                    : "No recorded child runs",
                  "Underlying process": scope.processState,
                  "Workspace release": scope.workspaceState,
                  "Snapshot requested": scope.snapshotRequested
                    ? "Yes"
                    : "No — scoped case evidence",
                  "Snapshot ID": scope.snapshotId ?? "None recorded",
                  "Snapshot lookup name": scope.snapshotName ?? "Not requested",
                  "Snapshot review": scope.snapshotReviewPending
                    ? "Pending — reconcile provider inventory before releasing evidence hold"
                    : "No unresolved lookup",
                  "User ID": scope.userId,
                  "Root run": scope.runId,
                  "Sandbox ID": scope.sandboxId ?? "Local / Desktop",
                }).map(([key, value]) => (
                  <div key={key}>
                    <dt className="text-muted-foreground">{key}</dt>
                    <dd className="mt-1 break-all font-mono text-xs">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
              {scope.processState === "unconfirmed" && (
                <p
                  role="alert"
                  className="rounded-md border border-destructive p-4 text-sm leading-6"
                >
                  <strong>Process stop is NOT confirmed.</strong>{" "}
                  {scope.transport === "cloud"
                    ? "Escalate now. Retry the recorded operation. If full snapshot preservation is unavailable, preserve the minimum relevant attribution evidence, document why it is sufficient, and use Stop without full snapshot. Keep the restriction active until provider stop and workspace release are verified."
                    : "Trigger cancellation does not prove that commands stopped on the user's computer. Verify the actual machine and record the method, process scope, time, and evidence."}
                </p>
              )}
              {locked && (
                <p className="text-sm text-muted-foreground">
                  Operation locked until {date(selected.operationExpiresAt!)}.
                  Reload before retrying.
                </p>
              )}
            </section>
          )}
          <section className="space-y-4 border-t pt-7">
            <h2 className="text-lg font-medium">Review timeline</h2>
            <ol className="space-y-4">
              {events.map((entry) => (
                <li key={entry._id} className="space-y-2 border-l-2 pl-4">
                  <p className="text-xs font-medium uppercase tracking-wide">
                    {entry.kind.replaceAll("_", " ")}
                  </p>
                  <p className="break-all text-xs text-muted-foreground">
                    {date(entry.createdAt)} · {entry.actor}
                  </p>
                  {entry.detail && (
                    <p className="whitespace-pre-wrap break-words text-sm leading-6">
                      {entry.detail.text}
                    </p>
                  )}
                </li>
              ))}
            </ol>
            {eventsCursor && (
              <Button
                disabled={pending}
                variant="outline"
                onClick={() =>
                  run(() => loadCase(selected.reference, eventsCursor))
                }
              >
                Load older events (audited)
              </Button>
            )}
          </section>
          <form onSubmit={act} className="space-y-5 border-t pt-7">
            <h2 className="text-lg font-medium">Record an action</h2>
            <label className="block space-y-2 text-sm">
              <span>Operation</span>
              <select
                className={selectClass}
                value={operation}
                onChange={(e) => {
                  setOperation(e.target.value as Operation);
                  setScopeInputs({});
                }}
              >
                {operations.map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {operation === "annotate" && (
              <label className="block space-y-2 text-sm">
                <span>Note kind</span>
                <select name="kind" className={selectClass}>
                  <option value="allegation">Allegation</option>
                  <option value="verified_fact">Verified fact</option>
                  <option value="decision">Decision</option>
                </select>
              </label>
            )}
            {operation === "contain" && (
              <>
                <p className="text-sm leading-6 text-muted-foreground">
                  Record verified attribution before acting. This action
                  requires the chat&apos;s current active root. For a completed
                  or replaced run, use the separate late-report procedure in the
                  abuse-response runbook. When accepted, this adds a temporary
                  security restriction to this user, cancels the selected root
                  and its children, and stops the verified cloud workspace.
                  Other work in the same workspace is affected. A competing
                  active case must be reviewed in its existing workflow.
                </p>
                {[
                  ["userId", "User ID"],
                  ["chatId", "Chat ID"],
                  ["runId", "Trigger run ID (current active root)"],
                ].map(([name, label]) => (
                  <label key={name} className="block space-y-2 text-sm">
                    <span>{label}</span>
                    <Input
                      name={name}
                      className="h-11 font-mono text-xs sm:text-sm"
                      onChange={(event) =>
                        setScopeInputs((values) => ({
                          ...values,
                          [name]: event.target.value,
                        }))
                      }
                      required
                      maxLength={160}
                    />
                    {scopeInputs[name]?.length > 36 && (
                      <span className="block break-all font-mono text-xs text-muted-foreground">
                        {scopeInputs[name]}
                      </span>
                    )}
                  </label>
                ))}
                <label className="flex items-start gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={cloud}
                    onChange={(e) => setCloud(e.target.checked)}
                    className="mt-1"
                  />
                  <span>
                    This run uses a cloud workspace. The server independently
                    verifies its transport.
                  </span>
                </label>
                {cloud && (
                  <>
                    <label className="block space-y-2 text-sm">
                      <span>Selected sandbox ID</span>
                      <Input
                        name="sandboxId"
                        required
                        className="h-11 font-mono text-xs sm:text-sm"
                        onChange={(event) =>
                          setScopeInputs((values) => ({
                            ...values,
                            sandboxId: event.target.value,
                          }))
                        }
                      />
                      {scopeInputs.sandboxId?.length > 36 && (
                        <span className="block break-all font-mono text-xs text-muted-foreground">
                          {scopeInputs.sandboxId}
                        </span>
                      )}
                    </label>
                    <label className="block space-y-2 text-sm">
                      <span>Region</span>
                      <select name="region" className={selectClass}>
                        <option>us-east-1</option>
                        <option>us-west-2</option>
                        <option>eu-central-1</option>
                      </select>
                    </label>
                    <label className="flex items-start gap-3 text-sm leading-6">
                      <input
                        type="checkbox"
                        name="preserveSnapshot"
                        className="mt-1"
                      />
                      <span>
                        Preserve a full cloud workspace snapshot. Only when
                        needed: this captures files and memory. Record why it is
                        necessary and who will review retention. A preservation
                        failure requires immediate follow-up.
                      </span>
                    </label>
                  </>
                )}
                <label className="flex items-start gap-3 text-sm leading-6">
                  <input
                    type="checkbox"
                    name="acknowledge"
                    required
                    className="mt-1"
                  />
                  <span>
                    I verified the scope and understand the account restriction,
                    workspace impact, and possible loss of volatile evidence
                    when no full snapshot is requested.
                  </span>
                </label>
              </>
            )}
            {operation === "stop_without_snapshot" && (
              <label className="flex items-start gap-3 text-sm leading-6">
                <input
                  type="checkbox"
                  name="acknowledge"
                  required
                  className="mt-1"
                />
                <span>
                  I have preserved the minimum relevant attribution evidence. I
                  authorize stopping this exact workspace despite unconfirmed
                  full snapshot preservation and possible loss of volatile data.
                  My decision records why.
                </span>
              </label>
            )}
            {operation === "resolve" && (
              <p className="text-sm leading-6 text-muted-foreground">
                Resolves only this case’s security restriction. Billing and
                independent holds remain. Evidence preservation stays on. No
                snapshot is restored. Cloud workspace release must be verified
                first. An exonerated case restores its verified original
                selection without killing the sandbox.
              </p>
            )}
            {operation === "hold" && (
              <label className="block space-y-2 text-sm">
                <span>Evidence hold</span>
                <select name="hold" className={selectClass}>
                  <option value="true">Keep preservation on</option>
                  <option value="false">
                    Release hold — resolved cases only
                  </option>
                </select>
                <span className="block leading-6 text-muted-foreground">
                  Releasing the hold deletes nothing. Record the reviewer,
                  reason, and retention decision.
                </span>
              </label>
            )}
            {operation === "erase" ? (
              <>
                <p className="text-sm leading-6 text-muted-foreground">
                  Only for a resolved case with no evidence hold. Deletes report
                  and note contents in bounded batches; retains audit metadata
                  and containment identifiers. Provider snapshots require a
                  separate authorized deletion and verification. This action
                  cannot be undone.
                </p>
                <label className="block space-y-2 text-sm">
                  <span>Type the full case reference</span>
                  <Input
                    name="confirmation"
                    required
                    className="h-11 font-mono text-xs"
                    autoComplete="off"
                  />
                </label>
              </>
            ) : (
              !["retry", "reconcile_snapshot"].includes(operation) && (
                <label className="block space-y-2 text-sm">
                  <span>
                    {operation === "confirm_local_stop"
                      ? "Machine verification method, process scope, time, and evidence"
                      : "Review note / decision"}
                  </span>
                  <Textarea
                    name="decision"
                    required
                    minLength={20}
                    maxLength={6000}
                    className="min-h-36"
                  />
                  <span className="block text-xs text-muted-foreground">
                    20–6,000 characters. Keep necessary evidence only; do not
                    include credentials.
                  </span>
                </label>
              )
            )}
            {unavailable && (
              <p className="text-sm text-muted-foreground">
                This action’s requirements are not met for the current case.
                Review its status, preservation hold, and containment progress.
              </p>
            )}
            <Button
              type="submit"
              disabled={pending || unavailable}
              variant={
                ["contain", "stop_without_snapshot", "erase"].includes(
                  operation,
                )
                  ? "destructive"
                  : "default"
              }
              className="w-full sm:w-auto"
            >
              {pending
                ? "Working…"
                : operations.find(([key]) => key === operation)?.[1]}
            </Button>
            <p className="text-xs text-muted-foreground">
              Applies to revision {selected.revision}. Reload the case after any
              unconfirmed action.
            </p>
          </form>
        </>
      )}
    </div>
  );
}
