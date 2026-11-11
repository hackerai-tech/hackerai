"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  Info,
  LoaderCircle,
  LockKeyhole,
  Pencil,
  Play,
  RotateCcw,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import {
  HTTP_RETEST_REASON_LABELS,
  httpRetestFindingOrigin,
  type HttpRetestOutcome,
  type HttpRetestRecipe,
  type HttpRetestStep,
} from "@/lib/findings/http-retest";
import { cn } from "@/lib/utils";
import type {
  FindingDetailRecord,
  FindingRetestRunView,
  FindingRetestState,
} from "@/types/finding";
import { FindingRelativeTime } from "./FindingTime";
import { FindingRetestRecipeEditor } from "./FindingRetestRecipeEditor";
import {
  FindingRetestRunDialog,
  type RetestRunResponse,
} from "./FindingRetestRunDialog";

const POLL_INTERVAL_MS = 2_000;

async function fetchRetestState(
  findingId: string,
): Promise<FindingRetestState | null> {
  try {
    const response = await fetch(
      `/api/finding-retests?findingId=${encodeURIComponent(findingId)}`,
      { cache: "no-store" },
    );
    return response.ok ? ((await response.json()) as FindingRetestState) : null;
  } catch {
    return null;
  }
}

const OUTCOME_META: Record<HttpRetestOutcome, { label: string; dot: string }> =
  {
    reproduced: { label: "Reproduced", dot: "bg-red-500" },
    not_reproduced: { label: "Not reproduced", dot: "bg-emerald-500" },
    skipped: { label: "Skipped", dot: "bg-muted-foreground/60" },
    error: { label: "Error", dot: "bg-amber-500" },
  };

const environmentLabel = (run: FindingRetestRunView) => {
  if (!run.environment) return "Source task's computer";
  const kind =
    run.environment.kind === "cloud"
      ? "Cloud sandbox"
      : run.environment.kind === "desktop"
        ? "Desktop"
        : "Local";
  return run.environment.name ? `${kind} · ${run.environment.name}` : kind;
};

const shortHash = (hash: string) => `${hash.slice(0, 4)}…${hash.slice(-4)}`;

const requestCount = (recipe: HttpRetestRecipe) => recipe.baselines.length + 1;

function OutcomeDot({
  outcome,
  large,
}: {
  outcome: HttpRetestOutcome;
  large?: boolean;
}) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-full",
        large ? "size-2.5" : "size-2",
        OUTCOME_META[outcome].dot,
      )}
      aria-hidden="true"
    />
  );
}

function StepRow({
  number,
  request,
  step,
  kind,
}: {
  number: number;
  request: HttpRetestRecipe["probe"] | HttpRetestRecipe["baselines"][number];
  step: HttpRetestStep | undefined;
  kind: "baseline" | "probe";
}) {
  const verdict = !step
    ? { tag: "NOT SENT", tone: "text-muted-foreground", text: "Not sent" }
    : step.error !== "none"
      ? {
          tag: "ERROR",
          tone: "text-amber-500",
          text:
            step.error === "redirect"
              ? "Redirect refused"
              : step.error === "oversized"
                ? "Response over 1 MB"
                : step.error === "timeout"
                  ? "Timed out"
                  : step.error === "tls"
                    ? "TLS verification failed"
                    : step.error === "invalid_response"
                      ? "Invalid HTTP response"
                      : "Could not connect",
        }
      : kind === "baseline"
        ? step.status === 401 || step.status === 403
          ? {
              tag: "AUTH",
              tone: "text-amber-500",
              text:
                step.status === 401
                  ? "Rejected as unauthenticated"
                  : "Rejected as unauthorized",
            }
          : step.matched
            ? {
                tag: "PASS",
                tone: "text-emerald-500",
                text: "Matched the expected baseline response",
              }
            : {
                tag: "FAIL",
                tone: "text-amber-500",
                text: "Did not match the expected baseline response",
              }
        : step.matched
          ? {
              tag: "MATCH",
              tone: "text-red-400",
              text: "Matched the vulnerable response condition",
            }
          : step.nonreproduction_matched
            ? {
                tag: "DENIED",
                tone: "text-emerald-500",
                text: `Denied with ${step.status}`,
              }
            : {
                tag: "OTHER",
                tone: "text-muted-foreground",
                text: "Matched neither condition",
              };
  return (
    <li className="flex gap-3 border-b border-border px-4 py-3.5 last:border-b-0">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border font-mono text-[11px] font-semibold text-muted-foreground">
        {number}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="text-sm font-medium text-foreground">
            {request.label}
          </span>
          {step?.status ? (
            <span className="flex gap-2 font-mono text-xs tabular-nums text-muted-foreground">
              <span
                className={cn(
                  "font-medium",
                  step.status < 300 ? "text-foreground" : "",
                )}
              >
                {step.status}
              </span>
              <span>{step.duration_ms} ms</span>
              {step.bytes !== null ? <span>{step.bytes} B</span> : null}
            </span>
          ) : null}
        </div>
        <div
          className="break-all font-mono text-xs text-muted-foreground"
          translate="no"
        >
          <span className="font-semibold text-foreground">GET</span>{" "}
          {request.path}
        </div>
        <div className="flex gap-2 border-l-2 border-border pl-3 text-xs leading-5">
          <span
            className={cn(
              "w-14 shrink-0 font-mono font-semibold",
              verdict.tone,
            )}
          >
            {verdict.tag}
          </span>
          <span className="text-muted-foreground">{verdict.text}</span>
        </div>
        {step?.body_sha256 ? (
          <div
            className="font-mono text-xs text-muted-foreground"
            translate="no"
          >
            Response body not stored · body sha256:{shortHash(step.body_sha256)}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function LatestRun({ run }: { run: FindingRetestRunView }) {
  if (run.status === "running") return <RunningCard />;
  const outcome = run.outcome ?? "error";
  const requests = [...run.recipe.baselines, run.recipe.probe];
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-muted/10">
      <div className="space-y-2 border-b border-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <OutcomeDot outcome={outcome} large />
            <span className="text-base font-semibold text-foreground">
              {OUTCOME_META[outcome].label}
            </span>
            <span className="text-xs text-muted-foreground">Latest run</span>
          </div>
          <span className="text-xs tabular-nums text-muted-foreground">
            Recipe v{run.recipe_version} ·{" "}
            <FindingRelativeTime timestamp={run.started_at} /> ·{" "}
            {environmentLabel(run)}
          </span>
        </div>
        {run.reason ? (
          <p className="text-sm leading-6 text-foreground">
            {HTTP_RETEST_REASON_LABELS[run.reason]}
          </p>
        ) : null}
      </div>
      {run.steps && run.steps.length > 0 ? (
        <ol>
          {requests.map((request, index) => {
            const kind =
              index < run.recipe.baselines.length ? "baseline" : "probe";
            const step = run.steps?.find((s) =>
              kind === "baseline"
                ? s.kind === "baseline" && s.index === index
                : s.kind === "probe",
            );
            return (
              <StepRow
                key={index}
                number={index + 1}
                request={request}
                step={step}
                kind={kind}
              />
            );
          })}
        </ol>
      ) : null}
      {run.evidence_sha256 ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
          <LockKeyhole className="size-3.5" aria-hidden="true" />
          <span className="text-foreground/80">Run snapshot locked</span>
          <span className="font-mono" translate="no">
            sha256:{shortHash(run.evidence_sha256)}
          </span>
          <span aria-hidden="true">·</span>
          <span>auth redacted · response bodies not stored</span>
        </div>
      ) : null}
    </div>
  );
}

function RunningCard() {
  return (
    <div
      role="status"
      className="overflow-hidden rounded-xl border border-foreground/20 bg-muted/10"
    >
      <div className="flex flex-wrap items-center gap-2.5 border-b border-border p-4">
        <LoaderCircle
          className="size-4 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
        <span className="text-base font-semibold text-foreground">
          Running retest
        </span>
        <span className="text-xs text-muted-foreground">
          Source task&apos;s computer · 30 s limit
        </span>
      </div>
      <p className="flex items-start gap-2 px-4 py-3 text-xs leading-5 text-muted-foreground">
        <LockKeyhole className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        Each run stops within 30 s. Closing this report doesn&apos;t cancel it —
        the result is saved here. The token is used for this run only.
      </p>
    </div>
  );
}

function History({ runs }: { runs: FindingRetestRunView[] }) {
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold text-foreground">Run history</h4>
        <span className="text-xs text-muted-foreground">
          Each run keeps its own snapshot
        </span>
      </div>
      <ul className="overflow-hidden rounded-xl border border-border">
        {runs.map((run) => {
          const outcome = run.outcome ?? "error";
          return (
            <li
              key={run.run_id}
              className="grid grid-cols-[8.5rem_minmax(0,1fr)_auto] items-center gap-3 border-b border-border px-4 py-2.5 text-xs last:border-b-0 max-sm:grid-cols-[minmax(0,1fr)_auto]"
            >
              <span className="flex items-center gap-2 text-[13px] font-medium text-foreground">
                {run.status === "running" ? (
                  <>
                    <LoaderCircle
                      className="size-3 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                    Running
                  </>
                ) : (
                  <>
                    <OutcomeDot outcome={outcome} />
                    {OUTCOME_META[outcome].label}
                  </>
                )}
              </span>
              <span className="min-w-0 truncate text-muted-foreground max-sm:col-span-2 max-sm:row-start-2">
                {run.reason
                  ? HTTP_RETEST_REASON_LABELS[run.reason]
                  : "In progress"}
              </span>
              <span className="whitespace-nowrap tabular-nums text-foreground/80 max-sm:col-start-2 max-sm:row-start-1">
                <FindingRelativeTime timestamp={run.started_at} />
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RecipeDetails({
  version,
  recipe,
}: {
  version: number;
  recipe: HttpRetestRecipe;
}) {
  const requests = [...recipe.baselines, recipe.probe];
  return (
    <Collapsible className="group overflow-hidden rounded-xl border border-border bg-muted/10">
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-foreground">
            Saved recipe
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            v{version} · inputs, requests and outcome rules
          </span>
        </span>
        <ChevronDown
          className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-5 border-t border-border p-4 text-sm">
        {recipe.credentials.length > 0 ? (
          <div className="space-y-2">
            <h5 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Inputs
            </h5>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {recipe.credentials.map((credential) => (
                <li
                  key={credential.name}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-xs"
                >
                  <span className="w-36 font-mono text-foreground">
                    {credential.name}
                  </span>
                  <span className="min-w-0 flex-1 text-muted-foreground">
                    {credential.label}
                  </span>
                  <span className="flex items-center gap-1.5 text-amber-500">
                    <LockKeyhole className="size-3" aria-hidden="true" />
                    Asked each run · never saved
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <div className="space-y-2">
          <h5 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Requests
          </h5>
          <ol className="space-y-2">
            {requests.map((request, index) => (
              <li key={index} className="space-y-1">
                <div className="flex flex-wrap items-baseline gap-2 text-xs">
                  <span className="font-mono text-muted-foreground">
                    {index + 1}
                  </span>
                  <span className="font-medium text-foreground">
                    {request.label}
                  </span>
                </div>
                <pre className="max-w-full overflow-x-auto rounded-lg border border-border bg-background/60 px-3 py-2 text-xs leading-5">
                  <code translate="no">
                    {`GET ${recipe.origin}${request.path}`}
                    {request.credential
                      ? `\nauth: {{${request.credential}}}`
                      : ""}
                  </code>
                </pre>
              </li>
            ))}
          </ol>
        </div>
        <div className="space-y-2">
          <h5 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Outcome rules
          </h5>
          <ul className="space-y-1.5 text-xs leading-5 text-muted-foreground">
            <li>
              <span className="font-medium text-foreground">Skipped</span> — a
              401, a redirect, or a baseline that doesn&apos;t match its
              expected response.
            </li>
            <li>
              <span className="font-medium text-foreground">Reproduced</span> —
              the probe returns {recipe.probe.vulnerable.status} and matches the
              saved response checks.
            </li>
            <li>
              <span className="font-medium text-foreground">
                Not reproduced
              </span>{" "}
              — the probe returns{" "}
              {recipe.probe.not_reproduced.statuses.join(" or ")}.
            </li>
            <li>
              <span className="font-medium text-foreground">Error</span> — a
              timeout, lost connection or unverifiable TLS.
            </li>
          </ul>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Executable HTTP retests for a finding. Renders nothing unless the server
 * reports the rollout enabled, so the existing report is unchanged otherwise.
 */
export function FindingHttpRetests({
  finding,
}: {
  finding: Pick<FindingDetailRecord, "finding_id" | "title" | "target">;
}) {
  const [state, setState] = useState<FindingRetestState | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [runReview, setRunReview] = useState<{
    recipe: NonNullable<
      Extract<FindingRetestState, { enabled: true }>["recipe"]
    >;
    environment: Extract<FindingRetestState, { enabled: true }>["environment"];
  } | null>(null);
  const [pending, setPending] = useState(false);
  const exposed = useRef(false);
  const loadSequence = useRef(0);
  const findingId = finding.finding_id;
  const targetOrigin = httpRetestFindingOrigin(finding.target);

  // A failed read keeps the last good state; with none, the section stays hidden.
  const apply = useCallback(
    (next: FindingRetestState | null) =>
      setState((prev) => next ?? prev ?? { enabled: false }),
    [],
  );
  const load = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const next = await fetchRetestState(findingId);
    if (sequence === loadSequence.current) apply(next);
  }, [findingId, apply]);

  useEffect(() => {
    const sequence = ++loadSequence.current;
    void fetchRetestState(findingId).then((next) => {
      if (sequence === loadSequence.current) apply(next);
    });
    return () => {
      loadSequence.current++;
    };
  }, [findingId, apply]);

  const serverRunning =
    state?.enabled === true &&
    state.runs.some((run) => run.status === "running");
  useEffect(() => {
    if (!serverRunning && !pending) return;
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [serverRunning, pending, load]);

  useEffect(() => {
    if (state?.enabled !== true || !targetOrigin || exposed.current) return;
    exposed.current = true;
    try {
      captureAuthenticatedEvent("finding_http_retest_section_viewed", {
        has_recipe: state.recipe !== null,
        run_count: state.runs.length,
      });
    } catch {
      // Analytics cannot block the retest workflow.
    }
  }, [state, targetOrigin]);

  if (!state || !state.enabled || !targetOrigin) return null;

  const recipe = state.recipe;
  const latest = state.runs[0];
  const running = pending || serverRunning;
  const targetChanged = !!recipe && recipe.recipe.origin !== targetOrigin;

  const onFinished = (result: RetestRunResponse) => {
    setPending(false);
    if (!result.success) toast.error(result.message);
    void load();
  };

  return (
    <section
      className="scroll-mt-8 space-y-5 border-b border-border pb-10"
      aria-labelledby={`${findingId}-retest-heading`}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 basis-full space-y-1.5 @min-[760px]:basis-auto @min-[760px]:flex-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <h3
              id={`${findingId}-retest-heading`}
              className="text-lg font-semibold text-foreground"
            >
              Retest
            </h3>
            {recipe ? (
              <span className="rounded-md border border-border bg-muted/30 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                HTTP recipe · {requestCount(recipe.recipe)} requests
              </span>
            ) : null}
          </div>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            {recipe
              ? "Replays the saved requests on the source task's computer. Each run is saved as an immutable snapshot. The finding's status never changes automatically."
              : "Check whether this vulnerability still reproduces."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {recipe ? (
            <Button
              size="sm"
              disabled={running || targetChanged}
              onClick={() =>
                setRunReview({ recipe, environment: state.environment })
              }
            >
              {running ? (
                <LoaderCircle
                  className="size-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <Play className="size-4" aria-hidden="true" />
              )}
              {running ? "Running…" : "Run retest"}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={running}
            onClick={() => setEditorOpen(true)}
          >
            <Pencil className="size-4" aria-hidden="true" />
            {recipe ? "Edit recipe" : "Add HTTP recipe"}
          </Button>
        </div>
      </div>
      {targetChanged ? (
        <p className="text-sm text-muted-foreground">
          The finding&apos;s target changed. Edit the recipe before running it
          again.
        </p>
      ) : null}

      {!recipe ? (
        <div className="flex items-start gap-3 rounded-xl border border-dashed border-border p-4">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/30">
            <RotateCcw
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
          </div>
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">
              No executable recipe
            </p>
            <p className="text-sm leading-6 text-muted-foreground">
              Add one for HTTP/API checks with a clear response condition, such
              as IDOR or missing authorization. For anything else, use Retest
              with Agent above.
            </p>
          </div>
        </div>
      ) : pending && latest?.status !== "running" ? (
        <RunningCard />
      ) : latest ? (
        <LatestRun run={latest} />
      ) : (
        <div className="rounded-xl border border-dashed border-border p-4">
          <p className="text-sm font-medium text-foreground">
            No retest runs yet
          </p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Review the recipe below, then run it to check whether the
            vulnerability still reproduces.
          </p>
        </div>
      )}

      {recipe ? (
        <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          The finding keeps its status. Each run is an immutable snapshot of
          what the source task&apos;s computer observed, not independent
          certification. Runs never close or edit the finding.
        </p>
      ) : null}

      {state.runs.length > 0 ? <History runs={state.runs} /> : null}
      {recipe ? (
        <RecipeDetails version={recipe.version} recipe={recipe.recipe} />
      ) : null}

      {editorOpen ? (
        <FindingRetestRecipeEditor
          open={editorOpen}
          onOpenChange={setEditorOpen}
          findingId={findingId}
          finding={finding}
          current={
            recipe ? { version: recipe.version, recipe: recipe.recipe } : null
          }
          onSaved={() => {
            toast.success("Recipe saved");
            void load();
          }}
          onConflict={() => void load()}
        />
      ) : null}
      {runReview ? (
        <FindingRetestRunDialog
          open
          onOpenChange={(open) => {
            if (!open) setRunReview(null);
          }}
          findingId={findingId}
          version={runReview.recipe.version}
          recipe={runReview.recipe.recipe}
          environmentKind={runReview.environment.kind}
          environmentRevision={runReview.environment.revision}
          onStarted={() => {
            setPending(true);
          }}
          onFinished={onFinished}
        />
      ) : null}
    </section>
  );
}
