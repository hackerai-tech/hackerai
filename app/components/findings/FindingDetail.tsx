"use client";

import Link from "next/link";
import { useMutation, useQueries, type RequestForQueries } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  ArrowLeft,
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  Copy,
  LockKeyhole,
  ScrollText,
  ShieldAlert,
} from "lucide-react";
import { Tabs } from "radix-ui";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { MemoizedMarkdown } from "@/app/components/MemoizedMarkdown";
import { FINDING_CATEGORY_LABELS } from "@/lib/findings/category";
import {
  FINDING_CLOSURE_CONTEXT_MAX,
  FINDING_CLOSURE_REASON_LABELS,
  FINDING_CLOSURE_REASONS,
} from "@/lib/findings/lifecycle";
import type {
  Cvss31Breakdown,
  FindingClosureReason,
  FindingDetailRecord,
  FindingHuntState,
  FindingRetestState,
} from "@/types/finding";
import { cn } from "@/lib/utils";
import { getSourceMessageHref } from "@/lib/findings/source-message";
import { findingEvidenceLabel } from "@/lib/findings/evidence-status";
import { getFindingSeverityDotClasses } from "./FindingCard";
import {
  FINDING_EVIDENCE_BASIS_NOTE,
  FindingEvidenceBadge,
} from "./FindingEvidenceBadge";
import { FindingFollowupActions } from "./FindingFollowupActions";
import {
  FindingAgentRetests,
  RETEST_OUTCOMES,
  retestOutcomeOf,
  useFindingRetestState,
} from "./FindingAgentRetests";
import {
  FindingVariantHunts,
  HuntCounts,
  huntPhase,
  useFindingHuntState,
} from "./FindingVariantHunts";
import { OutcomeLabel } from "./FindingAssessment";
import { FindingDiscoveredAt, FindingRelativeTime } from "./FindingTime";

import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import { captureFindingEvent } from "@/lib/findings/client-telemetry";
import { FindingFeedback } from "./FindingFeedback";
import { FindingHistory } from "./FindingHistory";

const CVSS_METRICS: Array<{
  key: keyof Cvss31Breakdown;
  label: string;
}> = [
  { key: "attack_vector", label: "Attack Vector" },
  { key: "attack_complexity", label: "Attack Complexity" },
  { key: "privileges_required", label: "Privileges Required" },
  { key: "user_interaction", label: "User Interaction" },
  { key: "scope", label: "Scope" },
  { key: "confidentiality", label: "Confidentiality" },
  { key: "integrity", label: "Integrity" },
  { key: "availability", label: "Availability" },
];

const CVSS_VALUE_LABELS: Record<
  keyof Cvss31Breakdown,
  Record<string, string>
> = {
  attack_vector: {
    N: "Network",
    A: "Adjacent",
    L: "Local",
    P: "Physical",
  },
  attack_complexity: { L: "Low", H: "High" },
  privileges_required: { N: "None", L: "Low", H: "High" },
  user_interaction: { N: "None", R: "Required" },
  scope: { U: "Unchanged", C: "Changed" },
  confidentiality: { N: "None", L: "Low", H: "High" },
  integrity: { N: "None", L: "Low", H: "High" },
  availability: { N: "None", L: "Low", H: "High" },
};

const CVSS_VALUE_EXPLANATIONS: Record<
  keyof Cvss31Breakdown,
  Record<string, string>
> = {
  attack_vector: {
    N: "Reachable over a network",
    A: "Requires access to an adjacent network",
    L: "Requires local system access",
    P: "Requires physical access",
  },
  attack_complexity: {
    L: "No special conditions are required",
    H: "Requires conditions beyond the attacker's control",
  },
  privileges_required: {
    N: "No existing account or privileges are required",
    L: "Requires basic user privileges",
    H: "Requires elevated privileges",
  },
  user_interaction: {
    N: "No separate user action is required",
    R: "A separate user must take an action",
  },
  scope: {
    U: "Impact stays within the vulnerable component's security boundary",
    C: "Impact crosses into another component's security boundary",
  },
  confidentiality: {
    N: "No confidentiality impact was demonstrated",
    L: "Limited confidential information can be exposed",
    H: "Broad or critical confidential information can be exposed",
  },
  integrity: {
    N: "No integrity impact was demonstrated",
    L: "Limited data or behavior can be modified",
    H: "Broad or critical data or behavior can be modified",
  },
  availability: {
    N: "No availability impact was demonstrated",
    L: "Availability can be partially reduced",
    H: "Availability can be severely disrupted",
  },
};

const formatLabel = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1).replaceAll("_", " ");

const CopyTextButton = ({
  value,
  label,
  successMessage,
}: {
  value: string;
  label: string;
  successMessage: string;
}) => {
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(successMessage);
    } catch {
      toast.error("Could not copy. Try again.");
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-8"
      onClick={() => void handleCopy()}
      aria-label={label}
    >
      <Copy className="size-3.5" aria-hidden="true" />
    </Button>
  );
};

const DetailSection = ({
  id,
  title,
  children,
}: {
  id?: string;
  title: string;
  children: React.ReactNode;
}) => (
  <section
    className="space-y-3"
    aria-labelledby={id ? `${id}-heading` : undefined}
  >
    <h4
      id={id ? `${id}-heading` : undefined}
      className="scroll-mt-20 text-sm font-semibold text-foreground"
    >
      {title}
    </h4>
    <div className="min-w-0 break-words text-sm leading-6 text-foreground">
      {children}
    </div>
  </section>
);

const MarkdownSection = ({
  id,
  title,
  value,
}: {
  id?: string;
  title: string;
  value: string;
}) => (
  <DetailSection id={id} title={title}>
    <MemoizedMarkdown content={value} />
  </DetailSection>
);

type FindingTab = "overview" | "report" | "retests" | "hunts";

/** Quiet labelled text block for the default Overview. */
const OverviewSection = ({
  id,
  title,
  value,
}: {
  id: string;
  title: string;
  value: string;
}) => (
  <section className="space-y-2" aria-labelledby={`${id}-heading`}>
    <h3
      id={`${id}-heading`}
      className="text-[13px] font-medium leading-5 text-muted-foreground"
    >
      {title}
    </h3>
    <div className="min-w-0 break-words text-[15px] leading-[26px] text-foreground">
      <MemoizedMarkdown content={value} />
    </div>
  </section>
);

const NOT_RUN = <span className="text-muted-foreground">Not run yet</span>;

function RetestCheckStatus({
  state,
}: {
  state: Extract<FindingRetestState, { enabled: true }>;
}) {
  const latest = state.retests[0];
  if (!latest) return NOT_RUN;
  if (latest.status === "running")
    return <OutcomeLabel tone="amber" label="Running…" running />;
  const outcome = RETEST_OUTCOMES[retestOutcomeOf(latest)];
  return (
    <>
      <OutcomeLabel tone={outcome.tone} label={outcome.label} />
      <span className="text-muted-foreground">
        <FindingRelativeTime
          timestamp={latest.finished_at ?? latest.started_at}
        />
      </span>
    </>
  );
}

function HuntCheckStatus({
  state,
}: {
  state: Extract<FindingHuntState, { enabled: true }>;
}) {
  const latest = state.hunts[0];
  if (!latest) return NOT_RUN;
  const phase = huntPhase(latest);
  const saved = latest.candidates.length;
  if (phase === "running")
    return (
      <OutcomeLabel tone="amber" label={`Hunting… ${saved} saved`} running />
    );
  return (
    <>
      {phase === "stopped" ? (
        <span className="text-foreground">Stopped early</span>
      ) : null}
      <HuntCounts hunt={latest} />
      <span className="text-muted-foreground">
        <FindingRelativeTime
          timestamp={latest.finished_at ?? latest.started_at}
        />
      </span>
    </>
  );
}

/** One compact Overview row that opens the matching tab. */
function AgentCheckRow({
  label,
  onOpen,
  children,
}: {
  label: string;
  onOpen: () => void;
  children: React.ReactNode;
}) {
  // The visible status is the button's description; aria-label names it.
  const statusId = useId();
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${label}`}
        aria-describedby={statusId}
        // Cells are placed explicitly; auto-placement would move the
        // row-locked chevron into the first column on wide panels.
        className="grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 py-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset @min-[520px]:grid-cols-[8rem_minmax(0,1fr)_auto]"
      >
        <span className="col-start-1 row-start-1 text-sm font-medium text-foreground">
          {label}
        </span>
        <span
          id={statusId}
          className="col-span-2 col-start-1 row-start-2 flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-1 text-sm text-foreground @min-[520px]:col-span-1 @min-[520px]:col-start-2 @min-[520px]:row-start-1"
        >
          {children}
        </span>
        <ChevronRight
          className="col-start-2 row-start-1 size-4 text-muted-foreground @min-[520px]:col-start-3"
          aria-hidden="true"
        />
      </button>
    </li>
  );
}

const TabTrigger = ({
  value,
  label,
  count,
}: {
  value: FindingTab;
  label: string;
  count?: number;
}) => (
  <Tabs.Trigger
    value={value}
    // Inset ring inside px-1.5 padding: never clipped by the scrolling list
    // and never drawn over the label or count.
    className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-t border-b-2 border-transparent px-1.5 pb-2.5 pt-1 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[state=active]:border-foreground data-[state=active]:text-foreground"
  >
    {label}
    {count ? (
      <span className="text-xs tabular-nums text-muted-foreground/70">
        {count}
      </span>
    ) : null}
  </Tabs.Trigger>
);

const MetaItem = ({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) => (
  <span className="inline-flex items-center gap-2">
    <span aria-hidden="true">·</span>
    <span title={title}>{children}</span>
  </span>
);

/** Content-free, best-effort exposure capture. */
const captureExposure = (
  event: string,
  properties: Record<string, string | number>,
) => {
  try {
    captureAuthenticatedEvent(event, properties);
  } catch {
    // Analytics cannot block the finding view.
  }
};

export function FindingDetail({
  findingId,
  finding: suppliedFinding,
  surface = "detail",
  className,
  onRequestClose,
}: {
  findingId?: string;
  finding?: FindingDetailRecord | null;
  surface?: "computer_sidebar" | "findings_page" | "detail";
  className?: string;
  onRequestClose?: () => void;
}) {
  // Keep the subscription request stable; useQueries returns failures as values.
  const skipQuery = suppliedFinding !== undefined || !findingId;
  const queries = useMemo<RequestForQueries>(
    (): RequestForQueries =>
      skipQuery || !findingId
        ? {}
        : { finding: { query: api.findings.getFinding, args: { findingId } } },
    [skipQuery, findingId],
  );
  const { finding: queriedFinding } = useQueries(queries) as {
    finding?: FindingDetailRecord | null | Error;
  };
  const closeFinding = useMutation(api.findings.closeFinding);
  const [isCloseDialogOpen, setIsCloseDialogOpen] = useState(false);
  const [isClosing, setIsClosing] = useState(false);
  const [closureReason, setClosureReason] =
    useState<FindingClosureReason>("already_fixed");
  const [closureContext, setClosureContext] = useState("");
  const [localClosure, setLocalClosure] = useState<
    | Pick<
        FindingDetailRecord,
        "status" | "closure_reason" | "closure_context" | "closed_at"
      >
    | undefined
  >();
  const persistedFinding =
    suppliedFinding !== undefined ? suppliedFinding : queriedFinding;
  const shownFindingId =
    persistedFinding && !(persistedFinding instanceof Error)
      ? persistedFinding.finding_id
      : undefined;
  const retestState = useFindingRetestState(shownFindingId);
  const huntState = useFindingHuntState(shownFindingId);
  // The selected tab belongs to one finding; another finding opens on Overview.
  const [tabState, setTabState] = useState<{
    findingId?: string;
    tab: FindingTab;
  }>({ tab: "overview" });

  // Exposure: once per finding encounter, only when the enabled controls are
  // actually shown in the header. Never from flag reads or hidden tabs.
  const exposed = useRef<{ retest?: string; hunt?: string }>({});
  useEffect(() => {
    if (!shownFindingId) return;
    if (retestState?.enabled && exposed.current.retest !== shownFindingId) {
      exposed.current.retest = shownFindingId;
      captureExposure("finding_retest_section_viewed", {
        retest_count: retestState.retests.length,
      });
    }
    if (huntState?.enabled && exposed.current.hunt !== shownFindingId) {
      exposed.current.hunt = shownFindingId;
      captureExposure("finding_hunt_section_viewed", {
        surface,
        hunt_count: huntState.hunts.length,
      });
    }
  }, [shownFindingId, retestState, huntState, surface]);

  const observed = useRef<string | null>(null);
  useEffect(() => {
    if (persistedFinding === undefined) return;
    const outcome =
      persistedFinding instanceof Error
        ? "failed"
        : persistedFinding
          ? "success"
          : "rejected";
    const key = `${findingId ?? suppliedFinding?.finding_id}:${outcome}:${persistedFinding && !(persistedFinding instanceof Error) ? persistedFinding.updated_at : ""}`;
    if (observed.current === key) return;
    observed.current = key;
    captureFindingEvent({
      operation: "load",
      outcome,
      surface,
      ...(persistedFinding && !(persistedFinding instanceof Error)
        ? {
            finding_id: persistedFinding.finding_id,
            report_updated_at: persistedFinding.updated_at,
            evidence_warning: Boolean(
              persistedFinding.evidence_verification?.warning,
            ),
          }
        : {
            reason: persistedFinding instanceof Error ? "general" : "not_found",
          }),
    });
  }, [persistedFinding, findingId, suppliedFinding?.finding_id, surface]);

  if (persistedFinding instanceof Error) {
    return (
      <div
        role="alert"
        className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center"
      >
        <p className="font-medium">Could not load finding</p>
        <p className="text-sm text-muted-foreground">
          Your saved report has not changed. Reload to try again.
        </p>
        <Button onClick={() => window.location.reload()}>Reload report</Button>
        {onRequestClose && (
          <Button variant="ghost" onClick={onRequestClose}>
            Back to chat
          </Button>
        )}
      </div>
    );
  }

  if (persistedFinding === undefined) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        Loading finding…
      </div>
    );
  }

  if (!persistedFinding) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
        <ShieldAlert
          className="size-8 text-muted-foreground"
          aria-hidden="true"
        />
        <div>
          <p className="font-medium text-foreground">Finding deleted</p>
          <p className="mt-1 text-sm text-muted-foreground">
            This structured finding is no longer available.
          </p>
        </div>
      </div>
    );
  }

  const finding = localClosure
    ? { ...persistedFinding, ...localClosure }
    : persistedFinding;

  const handleCloseFinding = async () => {
    if (!closureContext.trim()) return;
    setIsClosing(true);
    try {
      const result = await closeFinding({
        findingId: finding.finding_id,
        reason: closureReason,
        context: closureContext,
      });
      captureFindingEvent({
        operation: "close",
        outcome: result.closed ? "success" : "rejected",
        finding_id: finding.finding_id,
        ...(result.closed
          ? { closure_reason: closureReason }
          : { reason: result.not_found ? "not_found" : "conflict" }),
      });
      if (result.closed) {
        setLocalClosure({
          status: "closed",
          closure_reason: closureReason,
          closure_context: closureContext.trim(),
          closed_at: result.closed_at,
        });
        setIsCloseDialogOpen(false);
        setClosureContext("");
        toast.success("Finding closed");
      } else if (result.already_closed) {
        setIsCloseDialogOpen(false);
        toast.info("This finding is already closed.");
      } else if (result.not_found) {
        setIsCloseDialogOpen(false);
        toast.error("This finding no longer exists.");
      }
    } catch {
      captureFindingEvent({
        operation: "close",
        outcome: "uncertain",
        reason: "general",
      });
      toast.error("Could not close finding. Try again.");
    } finally {
      setIsClosing(false);
    }
  };

  const sectionId = (section: string) => `${finding.finding_id}-${section}`;
  const tabAvailable = (tab: FindingTab) =>
    tab === "retests"
      ? retestState?.enabled === true
      : tab === "hunts"
        ? huntState?.enabled === true
        : true;
  const selectedTab =
    tabState.findingId === finding.finding_id ? tabState.tab : "overview";
  // A tab hidden by a rollout change falls back to the Overview.
  const activeTab: FindingTab = tabAvailable(selectedTab)
    ? selectedTab
    : "overview";
  const selectTab = (tab: FindingTab) =>
    setTabState({ findingId: finding.finding_id, tab });

  return (
    <div
      className={cn(
        "@container h-full overflow-x-hidden overflow-y-auto overscroll-contain",
        className,
      )}
    >
      <article className="mx-auto w-full max-w-3xl px-4 pt-[max(1.25rem,env(safe-area-inset-top))] pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-7 @min-[760px]:px-0 @min-[760px]:py-10">
        <header className="space-y-5">
          {surface === "findings_page" && onRequestClose ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-ml-3 hidden text-muted-foreground hover:text-foreground sm:inline-flex"
              onClick={onRequestClose}
            >
              <ArrowLeft className="size-4" aria-hidden="true" />
              Back to Findings
            </Button>
          ) : null}

          <div className="min-w-0 space-y-2.5">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-5 text-muted-foreground">
              <span className="inline-flex items-center gap-2 font-medium text-foreground">
                <span
                  className={cn(
                    "size-2 rounded-full",
                    getFindingSeverityDotClasses(finding.severity),
                  )}
                  aria-hidden="true"
                />
                {formatLabel(finding.severity)}{" "}
                <span className="tabular-nums">
                  {finding.cvss_score.toFixed(1)}
                </span>
              </span>
              {/* Each separator wraps with the value after it, never alone. */}
              <MetaItem>
                {finding.status === "active" ? "Active" : "Closed"}
              </MetaItem>
              <MetaItem>{FINDING_CATEGORY_LABELS[finding.category]}</MetaItem>
              <MetaItem title={FINDING_EVIDENCE_BASIS_NOTE}>
                <span className="sr-only">Evidence basis: </span>
                {findingEvidenceLabel(finding.evidence_status)}
              </MetaItem>
            </p>
            <h2 className="text-balance text-2xl font-semibold leading-tight tracking-tight text-foreground @min-[760px]:text-[28px] @min-[760px]:leading-[34px]">
              {finding.title}
            </h2>
            <p
              className="break-all font-mono text-xs leading-5 text-muted-foreground"
              translate="no"
            >
              {finding.method ? (
                <span className="font-semibold text-foreground">
                  {finding.method}{" "}
                </span>
              ) : null}
              {finding.target}
              {finding.endpoint && !finding.target.endsWith(finding.endpoint)
                ? ` · ${finding.endpoint}`
                : null}
            </p>
          </div>

          <FindingFollowupActions
            finding={finding}
            surface={surface}
            retestState={retestState}
            huntState={huntState}
            showSource={surface === "findings_page"}
            onCloseFinding={
              surface === "findings_page" && finding.status === "active"
                ? () => setIsCloseDialogOpen(true)
                : undefined
            }
          />
        </header>

        <Tabs.Root
          value={activeTab}
          onValueChange={(value) => selectTab(value as FindingTab)}
          className="mt-7"
        >
          <Tabs.List
            aria-label="Finding sections"
            // -mx-1.5 offsets the triggers' padding so labels stay aligned.
            className="-mx-1.5 flex gap-2 overflow-x-auto border-b border-border @min-[520px]:gap-3"
          >
            <TabTrigger value="overview" label="Overview" />
            <TabTrigger value="report" label="Report" />
            {retestState?.enabled ? (
              <TabTrigger
                value="retests"
                label="Retests"
                count={retestState.retests.length}
              />
            ) : null}
            {huntState?.enabled ? (
              <TabTrigger
                value="hunts"
                label="Similar issues"
                count={huntState.hunts[0]?.candidates.length}
              />
            ) : null}
          </Tabs.List>

          <Tabs.Content
            value="overview"
            className="space-y-8 pt-7 focus-visible:outline-none"
          >
            {finding.status === "closed" &&
            finding.closure_reason &&
            finding.closure_context ? (
              <section
                className="border-l-2 border-muted-foreground/40 pl-4"
                aria-labelledby={`${finding.finding_id}-closure-heading`}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3
                    id={`${finding.finding_id}-closure-heading`}
                    className="flex items-center gap-2 text-sm font-semibold text-foreground"
                  >
                    <LockKeyhole
                      className="size-4 text-muted-foreground"
                      aria-hidden="true"
                    />
                    Closure Context
                  </h3>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="rounded-md border border-border bg-background px-2 py-1 font-medium text-foreground">
                      {FINDING_CLOSURE_REASON_LABELS[finding.closure_reason]}
                    </span>
                    {finding.closed_at ? (
                      <span>
                        Closed{" "}
                        <FindingDiscoveredAt timestamp={finding.closed_at} />
                      </span>
                    ) : null}
                  </div>
                </div>
                <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-foreground">
                  {finding.closure_context}
                </p>
              </section>
            ) : null}
            <OverviewSection
              id={sectionId("overview")}
              title="Summary"
              value={finding.description}
            />
            <OverviewSection
              id={sectionId("impact")}
              title="Impact"
              value={finding.impact}
            />
            {retestState?.enabled || huntState?.enabled ? (
              <section
                className="space-y-1"
                aria-labelledby={`${sectionId("checks")}-heading`}
              >
                <h3
                  id={`${sectionId("checks")}-heading`}
                  className="pb-1 text-[13px] font-medium leading-5 text-muted-foreground"
                >
                  Agent checks
                </h3>
                <ul className="divide-y divide-border border-y border-border">
                  {retestState?.enabled ? (
                    <AgentCheckRow
                      label="Retest"
                      onOpen={() => selectTab("retests")}
                    >
                      <RetestCheckStatus state={retestState} />
                    </AgentCheckRow>
                  ) : null}
                  {huntState?.enabled ? (
                    <AgentCheckRow
                      label="Similar issues"
                      onOpen={() => selectTab("hunts")}
                    >
                      <HuntCheckStatus state={huntState} />
                    </AgentCheckRow>
                  ) : null}
                </ul>
              </section>
            ) : null}
          </Tabs.Content>

          {retestState?.enabled ? (
            <Tabs.Content
              value="retests"
              className="pt-6 focus-visible:outline-none"
            >
              <FindingAgentRetests state={retestState} />
            </Tabs.Content>
          ) : null}

          {huntState?.enabled ? (
            <Tabs.Content
              value="hunts"
              className="pt-6 focus-visible:outline-none"
            >
              <FindingVariantHunts state={huntState} />
            </Tabs.Content>
          ) : null}

          <Tabs.Content
            value="report"
            className="pt-7 focus-visible:outline-none"
          >
            <div className="min-w-0 space-y-10 @min-[760px]:space-y-12">
              <dl className="grid gap-x-10 gap-y-4 border-b border-border pb-8 @min-[520px]:grid-cols-2">
                <div className="min-w-0">
                  <dt className="text-[13px] text-muted-foreground">
                    Category
                  </dt>
                  <dd className="mt-1 text-sm text-foreground">
                    {FINDING_CATEGORY_LABELS[finding.category]}
                    {finding.cwe || finding.cve ? (
                      <span
                        className="ml-2 break-words font-mono text-xs text-muted-foreground"
                        translate="no"
                      >
                        {[finding.cwe, finding.cve].filter(Boolean).join(" · ")}
                      </span>
                    ) : null}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-[13px] text-muted-foreground">
                    Evidence basis
                  </dt>
                  <dd className="mt-1">
                    <FindingEvidenceBadge status={finding.evidence_status} />
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-[13px] text-muted-foreground">
                    Fix Effort
                  </dt>
                  <dd className="mt-1 text-sm text-foreground">
                    {formatLabel(finding.fix_effort)}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="text-[13px] text-muted-foreground">Found</dt>
                  <dd className="mt-1 text-sm text-foreground">
                    <FindingDiscoveredAt timestamp={finding.created_at} />
                  </dd>
                </div>
                {surface === "findings_page" ? (
                  <div className="min-w-0">
                    <dt className="text-[13px] text-muted-foreground">
                      Source task
                    </dt>
                    <dd className="mt-1 text-sm">
                      <Link
                        href={getSourceMessageHref(
                          finding.chat_id,
                          finding.message_id,
                        )}
                        onClick={() =>
                          captureFindingEvent({
                            operation: "source",
                            outcome: "initiated",
                            finding_id: finding.finding_id,
                            surface,
                          })
                        }
                        aria-label={`Open source message in ${finding.chat_title}`}
                        className="inline-flex min-w-0 items-center gap-1 rounded text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <span className="min-w-0 truncate">
                          {finding.chat_title}
                        </span>
                        <ArrowUpRight
                          className="size-3.5 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                      </Link>
                    </dd>
                  </div>
                ) : null}
              </dl>

              <section
                id={sectionId("technical")}
                className="scroll-mt-8 space-y-4 border-b border-border pb-10"
                aria-labelledby={`${sectionId("technical")}-heading`}
              >
                <h3
                  id={`${sectionId("technical")}-heading`}
                  className="text-pretty text-lg font-semibold text-foreground"
                >
                  Root Cause
                </h3>
                <div className="min-w-0 break-words text-sm leading-7 text-foreground">
                  <MemoizedMarkdown content={finding.technical_analysis} />
                </div>
              </section>

              <section
                id={sectionId("evidence")}
                className="scroll-mt-8 space-y-8 border-b border-border pb-10"
                aria-labelledby={`${sectionId("evidence")}-heading`}
              >
                <div className="space-y-1.5">
                  <h3
                    id={`${sectionId("evidence")}-heading`}
                    className="text-pretty text-lg font-semibold text-foreground"
                  >
                    Validation
                  </h3>
                  <p className="text-sm leading-6 text-muted-foreground">
                    Reproduction steps, observed evidence, and affected
                    locations used to confirm this vulnerability.
                  </p>
                </div>

                <section
                  className="rounded-xl border border-border bg-muted/10 p-4"
                  aria-labelledby={`${sectionId("evidence")}-basis-heading`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <h4
                      id={`${sectionId("evidence")}-basis-heading`}
                      className="text-sm font-semibold text-foreground"
                    >
                      Evidence basis
                    </h4>
                    <FindingEvidenceBadge status={finding.evidence_status} />
                  </div>
                  {finding.evidence_status_reason ? (
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
                      {finding.evidence_status_reason}
                    </p>
                  ) : (
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">
                      No reasoning was recorded for this evidence basis.
                    </p>
                  )}
                  <p className="mt-2 text-xs leading-5 text-muted-foreground">
                    {FINDING_EVIDENCE_BASIS_NOTE}
                  </p>
                </section>

                {finding.evidence_verification?.warning && (
                  <div
                    role="note"
                    className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-4 text-sm"
                  >
                    <p className="font-medium">
                      Evidence verification incomplete
                    </p>
                    <p className="mt-2">
                      {finding.evidence_verification.warning}
                    </p>
                    <ul className="mt-2 space-y-1">
                      {finding.evidence_verification.unavailable_refs.map(
                        (ref) => (
                          <li key={ref} className="break-all font-mono text-xs">
                            {ref}
                          </li>
                        ),
                      )}
                    </ul>
                  </div>
                )}
                {(finding.evidence_refs?.length ?? 0) > 0 && (
                  <div className="text-sm">
                    <p className="font-medium">Evidence references</p>
                    <ul className="mt-2 space-y-1">
                      {finding.evidence_refs!.map((ref) => (
                        <li key={ref} className="break-all font-mono text-xs">
                          {ref}
                          {finding.evidence_verification?.checked_refs.includes(
                            ref,
                          )
                            ? " — file available at submission"
                            : " — not checked"}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                <section
                  className="border-l-2 border-border pl-4"
                  aria-labelledby={`${sectionId("evidence")}-captured-heading`}
                >
                  <h4
                    id={`${sectionId("evidence")}-captured-heading`}
                    className="flex items-center gap-2 text-sm font-semibold text-foreground"
                  >
                    <ScrollText
                      className="size-4 text-muted-foreground"
                      aria-hidden="true"
                    />
                    Observed Evidence
                  </h4>
                  <pre className="mt-3 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-muted/30 p-4 text-xs leading-relaxed text-foreground">
                    <code translate="no">{finding.evidence}</code>
                  </pre>
                </section>

                <MarkdownSection
                  id={sectionId("reproduce")}
                  title="Reproduction"
                  value={finding.poc_description}
                />

                <section
                  className="overflow-hidden rounded-xl border border-border bg-muted/15"
                  aria-labelledby={`${sectionId("reproduce")}-payload-heading`}
                >
                  <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
                    <h4
                      id={`${sectionId("reproduce")}-payload-heading`}
                      className="text-sm font-semibold text-foreground"
                    >
                      PoC Script or Payload
                    </h4>
                    <CopyTextButton
                      value={finding.poc_script_code}
                      label="Copy PoC"
                      successMessage="PoC copied"
                    />
                  </div>
                  <pre className="max-w-full overflow-x-auto p-4 text-xs leading-relaxed">
                    <code translate="no">{finding.poc_script_code}</code>
                  </pre>
                </section>

                {finding.code_locations && finding.code_locations.length > 0 ? (
                  <DetailSection title="Affected Locations">
                    <div className="space-y-4">
                      {finding.code_locations.map((location, index) => (
                        <section
                          key={`${location.file}:${location.start_line}:${index}`}
                          className="overflow-hidden rounded-xl border border-border"
                          aria-label={
                            location.label ??
                            `${location.file}:${location.start_line}-${location.end_line}`
                          }
                        >
                          <div className="flex min-w-0 flex-col gap-1 px-4 py-3 @min-[620px]:flex-row @min-[620px]:items-start @min-[620px]:justify-between">
                            <div className="min-w-0">
                              {location.label ? (
                                <div className="text-sm font-medium text-foreground">
                                  {location.label}
                                </div>
                              ) : null}
                              <div
                                className="mt-0.5 break-all font-mono text-xs text-muted-foreground"
                                translate="no"
                              >
                                {location.file}:{location.start_line}-
                                {location.end_line}
                              </div>
                            </div>
                            <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                              Source Reference
                            </span>
                          </div>
                          {location.snippet ? (
                            <pre className="max-w-full overflow-x-auto border-t border-border bg-muted/15 p-4 text-xs leading-relaxed">
                              <code translate="no">{location.snippet}</code>
                            </pre>
                          ) : (
                            <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
                              No source snippet was included with this report.
                            </p>
                          )}
                        </section>
                      ))}
                    </div>
                  </DetailSection>
                ) : null}
              </section>

              <section
                id={sectionId("remediation")}
                className="scroll-mt-8 space-y-8 border-b border-border pb-10"
                aria-labelledby={`${sectionId("remediation")}-heading`}
              >
                <div className="space-y-1.5">
                  <h3
                    id={`${sectionId("remediation")}-heading`}
                    className="text-pretty text-lg font-semibold text-foreground"
                  >
                    Remediation
                  </h3>
                  <p className="text-sm leading-6 text-muted-foreground">
                    Recommended changes to remove the root cause and prevent
                    regression.
                  </p>
                </div>

                <div className="min-w-0 break-words text-sm leading-7 text-foreground">
                  <MemoizedMarkdown content={finding.remediation_steps} />
                </div>

                {finding.code_locations?.some(
                  (location) => location.fix_before && location.fix_after,
                ) ? (
                  <DetailSection title="Suggested Code Changes">
                    <div className="space-y-4">
                      {finding.code_locations
                        ?.filter(
                          (location) =>
                            location.fix_before && location.fix_after,
                        )
                        .map((location, index) => (
                          <section
                            key={`${location.file}:${location.start_line}:${index}`}
                            className="rounded-xl border border-border p-4"
                          >
                            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                              <div
                                className="break-all font-mono text-xs text-foreground"
                                translate="no"
                              >
                                {location.file}:{location.start_line}-
                                {location.end_line}
                              </div>
                              <span className="rounded-md border border-border px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                Read-only Guidance
                              </span>
                            </div>
                            <div className="mt-4 grid gap-4 @min-[620px]:grid-cols-2">
                              <div className="min-w-0">
                                <div className="mb-1.5 text-[11px] font-medium uppercase text-muted-foreground">
                                  Current Code
                                </div>
                                <pre className="max-w-full overflow-x-auto rounded-md border border-red-500/20 bg-red-500/5 p-3 text-xs">
                                  <code translate="no">
                                    {location.fix_before}
                                  </code>
                                </pre>
                              </div>
                              <div className="min-w-0">
                                <div className="mb-1.5 text-[11px] font-medium uppercase text-muted-foreground">
                                  Suggested Change
                                </div>
                                <pre className="max-w-full overflow-x-auto rounded-md border border-green-500/20 bg-green-500/5 p-3 text-xs">
                                  <code translate="no">
                                    {location.fix_after}
                                  </code>
                                </pre>
                              </div>
                            </div>
                          </section>
                        ))}
                    </div>
                  </DetailSection>
                ) : null}
              </section>

              <section
                className="space-y-8 pb-4"
                aria-labelledby={`${sectionId("assessment")}-heading`}
              >
                <div className="space-y-1.5">
                  <h3
                    id={`${sectionId("assessment")}-heading`}
                    className="text-pretty text-lg font-semibold text-foreground"
                  >
                    Assessment Details
                  </h3>
                  <p className="text-sm leading-6 text-muted-foreground">
                    Confidence, assessment limits, and the server-calculated
                    CVSS 3.1 score.
                  </p>
                </div>

                <MarkdownSection
                  title="Assumptions"
                  value={finding.assumptions}
                />

                <div className="rounded-xl border border-border bg-muted/10 p-4">
                  <h4 className="text-sm font-semibold">
                    Assessment confidence
                  </h4>
                  <p className="mt-2 text-sm capitalize">
                    {finding.confidence ?? "Not recorded"}
                  </p>
                </div>
                <p className="text-xs text-muted-foreground">
                  Assessment confidence reflects the report’s evidence and
                  limitations. Saved file availability does not independently
                  validate a vulnerability.
                </p>
                {finding.confidence_rationale && (
                  <MarkdownSection
                    title="Confidence rationale"
                    value={finding.confidence_rationale}
                  />
                )}
                <FindingHistory finding={finding} />
                <FindingFeedback
                  key={`${finding.finding_id}:${finding.updated_at}`}
                  finding={finding}
                />
                {finding.counterevidence && (
                  <MarkdownSection
                    title="Counterevidence"
                    value={finding.counterevidence}
                  />
                )}
                {finding.severity_change_conditions && (
                  <MarkdownSection
                    title="What would change severity"
                    value={finding.severity_change_conditions}
                  />
                )}

                <Collapsible className="group overflow-hidden rounded-xl border border-border bg-muted/10">
                  <CollapsibleTrigger className="flex w-full items-center justify-between gap-4 px-4 py-3.5 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset">
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-foreground">
                        Why this severity?
                      </span>
                      <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
                        See how exploitability and demonstrated impact produced
                        this score.
                      </span>
                    </span>
                    <ChevronDown
                      className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180"
                      aria-hidden="true"
                    />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="border-t border-border">
                    <dl className="grid grid-cols-1 @min-[620px]:grid-cols-2">
                      {CVSS_METRICS.map((metric) => {
                        const value = finding.cvss_breakdown[metric.key];
                        return (
                          <div
                            key={metric.key}
                            className="border-b border-border px-4 py-3 last:border-b-0 @min-[620px]:odd:border-r @min-[620px]:[&:nth-last-child(-n+2)]:border-b-0"
                          >
                            <dt className="flex items-center justify-between gap-3 text-xs font-medium text-foreground">
                              <span>{metric.label}</span>
                              <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
                                {CVSS_VALUE_LABELS[metric.key][value] ?? value}
                              </span>
                            </dt>
                            <dd className="mt-1 text-xs leading-5 text-muted-foreground">
                              {CVSS_VALUE_EXPLANATIONS[metric.key][value]}
                            </dd>
                          </div>
                        );
                      })}
                    </dl>
                  </CollapsibleContent>
                </Collapsible>

                <DetailSection title="CVSS 3.1 Breakdown">
                  <div className="overflow-hidden rounded-lg border border-border">
                    <dl className="grid grid-cols-1 divide-y divide-border @min-[520px]:grid-cols-2 @min-[520px]:divide-x @min-[520px]:divide-y-0">
                      {CVSS_METRICS.map((metric) => (
                        <div
                          key={metric.key}
                          className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5 last:border-b-0 @min-[520px]:[&:nth-last-child(-n+2)]:border-b-0"
                        >
                          <dt className="text-xs text-muted-foreground">
                            {metric.label}
                          </dt>
                          <dd className="text-xs font-medium text-foreground">
                            {CVSS_VALUE_LABELS[metric.key][
                              finding.cvss_breakdown[metric.key]
                            ] ?? finding.cvss_breakdown[metric.key]}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <div className="flex min-w-0 items-center gap-2 border-t border-border px-3 py-1.5">
                      <div
                        className="min-w-0 flex-1 break-all font-mono text-[11px] text-muted-foreground"
                        translate="no"
                      >
                        {finding.cvss_vector}
                      </div>
                      <CopyTextButton
                        value={finding.cvss_vector}
                        label="Copy CVSS vector"
                        successMessage="CVSS vector copied"
                      />
                    </div>
                  </div>
                </DetailSection>
              </section>
            </div>
          </Tabs.Content>
        </Tabs.Root>
      </article>

      {surface === "findings_page" ? (
        <Dialog
          open={isCloseDialogOpen}
          onOpenChange={(open) => {
            if (!isClosing) setIsCloseDialogOpen(open);
          }}
        >
          <DialogContent
            showCloseButton={!isClosing}
            overlayClassName="bg-black/60 backdrop-blur-sm"
            className="max-h-[calc(100dvh-1rem)] overflow-y-auto overscroll-contain p-4 sm:max-w-xl sm:p-6"
          >
            <form
              className="space-y-5 sm:space-y-6"
              onSubmit={(event) => {
                event.preventDefault();
                void handleCloseFinding();
              }}
            >
              <DialogHeader className="pr-8 text-left">
                <DialogTitle>Close finding</DialogTitle>
                <DialogDescription>
                  Choose a reason and leave a note for future reference. You can
                  still view the report and source message.
                </DialogDescription>
              </DialogHeader>

              <fieldset className="space-y-3">
                <legend className="text-sm font-medium text-foreground">
                  Why are you closing it?
                </legend>
                <RadioGroup
                  value={closureReason}
                  onValueChange={(value) =>
                    setClosureReason(value as FindingClosureReason)
                  }
                  className="grid gap-2 sm:grid-cols-3"
                >
                  {FINDING_CLOSURE_REASONS.map((reason) => (
                    <label
                      key={reason}
                      htmlFor={`finding-closure-${reason}`}
                      className={cn(
                        "flex min-h-12 cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
                        closureReason === reason
                          ? "border-foreground/50 bg-muted/50 text-foreground"
                          : "border-border text-muted-foreground hover:bg-muted/30 hover:text-foreground",
                      )}
                    >
                      <RadioGroupItem
                        id={`finding-closure-${reason}`}
                        value={reason}
                        aria-label={FINDING_CLOSURE_REASON_LABELS[reason]}
                      />
                      <span className="min-w-0 text-sm font-medium">
                        {FINDING_CLOSURE_REASON_LABELS[reason]}
                      </span>
                    </label>
                  ))}
                </RadioGroup>
              </fieldset>

              <div className="space-y-2">
                <label
                  htmlFor="finding-closure-context"
                  className="text-sm font-medium text-foreground"
                >
                  Closure note
                  <span className="ml-1 font-normal text-muted-foreground">
                    (required)
                  </span>
                </label>
                <Textarea
                  id="finding-closure-context"
                  name="finding-closure-context"
                  autoComplete="off"
                  value={closureContext}
                  onChange={(event) => setClosureContext(event.target.value)}
                  placeholder="Describe what changed, how it was verified, or why it is being closed…"
                  maxLength={FINDING_CLOSURE_CONTEXT_MAX}
                  rows={4}
                  className="min-h-28 resize-y sm:min-h-32"
                  required
                />
                <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>Add enough detail for your future self.</span>
                  <span className="tabular-nums">
                    {closureContext.length}/{FINDING_CLOSURE_CONTEXT_MAX}
                  </span>
                </div>
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  disabled={isClosing}
                  onClick={() => setIsCloseDialogOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={isClosing || !closureContext.trim()}
                >
                  {isClosing ? "Closing…" : "Close finding"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
