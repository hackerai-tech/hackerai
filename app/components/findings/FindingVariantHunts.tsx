"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { getSourceMessageHref } from "@/lib/findings/source-message";
import {
  countHuntOutcomes,
  huntEvidenceBasisLabel,
  type HuntCandidateOutcome,
} from "@/lib/findings/variant-hunt";
import type {
  FindingHuntCandidateView,
  FindingHuntState,
  FindingHuntView,
} from "@/types/finding";
import {
  AssessmentDetails,
  AssessmentList,
  AssessmentRow,
  EvidenceList,
  OutcomeDot,
  OutcomeLabel,
  StepList,
  TaskLink,
  TextList,
  environmentLabel,
  hasEvidence,
  type AssessmentField,
  type OutcomeTone,
} from "./FindingAssessment";
import { FindingRelativeTime } from "./FindingTime";

const POLL_INTERVAL_MS = 5_000;

export type EnabledHuntState = Extract<FindingHuntState, { enabled: true }>;

async function fetchHuntState(
  findingId: string,
): Promise<FindingHuntState | null> {
  try {
    const response = await fetch(
      `/api/finding-hunts?findingId=${encodeURIComponent(findingId)}`,
      { cache: "no-store" },
    );
    return response.ok ? ((await response.json()) as FindingHuntState) : null;
  } catch {
    return null;
  }
}

/**
 * Hunt history for a finding. `undefined` while loading, so no hunt action is
 * offered before the rollout is known; a failed first read resolves to
 * disabled. A failed refresh keeps the last good state, a stale response never
 * replaces a newer one, and polling runs only while a hunt is recorded running.
 */
export function useFindingHuntState(
  findingId: string | undefined,
): FindingHuntState | undefined {
  const [loaded, setLoaded] = useState<{
    findingId: string;
    state: FindingHuntState;
  } | null>(null);
  const readSequence = useRef(0);

  const read = useCallback((id: string, isCurrent: () => boolean) => {
    const sequence = ++readSequence.current;
    return fetchHuntState(id).then((next) => {
      if (!isCurrent() || sequence !== readSequence.current) return;
      setLoaded((prev) => ({
        findingId: id,
        state:
          next ??
          (prev?.findingId === id ? prev.state : { enabled: false as const }),
      }));
    });
  }, []);

  useEffect(() => {
    if (!findingId) return;
    let current = true;
    void read(findingId, () => current);
    return () => {
      current = false;
    };
  }, [findingId, read]);

  const state =
    loaded && loaded.findingId === findingId ? loaded.state : undefined;
  const running =
    state?.enabled === true &&
    state.hunts.some((hunt) => hunt.status === "running");
  useEffect(() => {
    if (!findingId || !running) return;
    let current = true;
    const timer = setInterval(
      () => void read(findingId, () => current),
      POLL_INTERVAL_MS,
    );
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [findingId, running, read]);

  return state;
}

export const HUNT_OUTCOMES: Record<
  HuntCandidateOutcome,
  { label: string; tone: OutcomeTone }
> = {
  reproduced: { label: "Reproduced", tone: "red" },
  ruled_out: { label: "Ruled out", tone: "emerald" },
  inconclusive: { label: "Inconclusive", tone: "amber" },
  not_examined: { label: "Not examined", tone: "hollow" },
};

const OUTCOME_ORDER: HuntCandidateOutcome[] = [
  "reproduced",
  "ruled_out",
  "inconclusive",
  "not_examined",
];

/** Outcome counts derived from saved candidates, e.g. "2 reproduced". */
export function HuntCounts({ hunt }: { hunt: FindingHuntView }) {
  const counts = countHuntOutcomes(hunt.candidates);
  const shown = OUTCOME_ORDER.filter((outcome) => counts[outcome] > 0);
  if (shown.length === 0)
    return <span className="text-muted-foreground">No candidates saved</span>;
  return (
    <>
      {shown.map((outcome) => (
        <span key={outcome} className="inline-flex items-center gap-2">
          <OutcomeDot tone={HUNT_OUTCOMES[outcome].tone} />
          {counts[outcome]} {HUNT_OUTCOMES[outcome].label.toLowerCase()}
        </span>
      ))}
    </>
  );
}

export const huntPhase = (hunt: FindingHuntView) =>
  hunt.status === "running"
    ? ("running" as const)
    : hunt.interrupted
      ? ("stopped" as const)
      : ("complete" as const);

function CandidateDetails({
  candidate,
}: {
  candidate: FindingHuntCandidateView;
}) {
  const fields: AssessmentField[] = [
    { label: "Why here", value: candidate.rationale },
  ];
  if (candidate.reproduction_steps.length)
    fields.push({
      label: "Steps",
      value: <StepList steps={candidate.reproduction_steps} />,
    });
  if (candidate.expected_result)
    fields.push({ label: "Expected", value: candidate.expected_result });
  if (candidate.observed_result)
    fields.push({ label: "Observed", value: candidate.observed_result });
  if (candidate.evidence_basis)
    fields.push({
      label: "Basis",
      value: huntEvidenceBasisLabel(
        candidate.evidence_basis,
        candidate.outcome,
      ),
    });
  if (hasEvidence(candidate.evidence_refs, candidate.evidence_verification))
    fields.push({
      label: "Evidence",
      value: (
        <EvidenceList
          refs={candidate.evidence_refs}
          verification={candidate.evidence_verification}
        />
      ),
    });
  if (candidate.limitations.length)
    fields.push({
      label: "Limits",
      value: <TextList items={candidate.limitations} />,
    });
  return <AssessmentDetails fields={fields} />;
}

function CandidateRows({ hunt }: { hunt: FindingHuntView }) {
  return (
    <AssessmentList>
      {hunt.candidates.map((candidate) => {
        const outcome = HUNT_OUTCOMES[candidate.outcome];
        return (
          <AssessmentRow
            key={candidate.candidate_key}
            label={`${outcome.label}: ${candidate.surface}`}
            outcome={<OutcomeLabel tone={outcome.tone} label={outcome.label} />}
            primary={
              <span className="break-all font-mono text-[13px]" translate="no">
                {candidate.surface}
              </span>
            }
          >
            <CandidateDetails candidate={candidate} />
          </AssessmentRow>
        );
      })}
    </AssessmentList>
  );
}

const HEAD_TITLE = {
  running: "Agent is hunting",
  stopped: "Hunt stopped early",
  complete: "Hunt complete",
} as const;

function HuntBody({ hunt }: { hunt: FindingHuntView }) {
  const phase = huntPhase(hunt);
  const environment = environmentLabel(hunt.environment);
  const saved = hunt.candidates.length;
  const description =
    phase === "running"
      ? `${saved} ${saved === 1 ? "candidate" : "candidates"} saved so far. Each one appears here when Agent records its assessment.`
      : phase === "stopped"
        ? `The Agent run ended before it finished. ${saved === 0 ? "No candidates were saved." : `${saved === 1 ? "This assessment was" : `These ${saved} assessments were`} saved.`} Anything not listed wasn't examined, so start a new hunt to continue.`
        : hunt.summary;
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
              {phase === "running" ? (
                <LoaderCircle
                  className="size-3.5 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : null}
              {HEAD_TITLE[phase]}
            </span>
            <span className="text-[13px] text-muted-foreground">
              {phase === "running" ? "started " : null}
              <FindingRelativeTime
                timestamp={hunt.finished_at ?? hunt.started_at}
              />
              {environment ? ` · ${environment}` : null}
            </span>
          </p>
          <TaskLink
            href={
              phase === "running"
                ? `/c/${encodeURIComponent(hunt.chat_id)}`
                : getSourceMessageHref(hunt.chat_id, hunt.assistant_message_id)
            }
          >
            {phase === "running" ? "Watch in task" : "Open in task"}
          </TaskLink>
        </div>
        {description ? (
          <p
            className="text-[15px] leading-[26px] text-foreground"
            {...(phase === "running" && { role: "status" })}
          >
            {description}
          </p>
        ) : null}
        {phase === "complete" && hunt.limitations?.length ? (
          <TextList items={hunt.limitations} />
        ) : null}
      </div>
      {saved > 0 ? <CandidateRows hunt={hunt} /> : null}
    </div>
  );
}

function EarlierHunts({ hunts }: { hunts: FindingHuntView[] }) {
  return (
    <Collapsible className="group">
      <CollapsibleTrigger className="inline-flex min-h-8 items-center gap-2 rounded text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight
          className="size-3.5 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
          aria-hidden="true"
        />
        <span className="font-medium text-foreground">
          {hunts.length} earlier {hunts.length === 1 ? "hunt" : "hunts"}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-4 space-y-8">
        {hunts.map((hunt) => (
          <HuntBody key={hunt.hunt_id} hunt={hunt} />
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * Agent hunts for other surfaces that may share this finding's root cause.
 * Hunts start from the finding header, which prepares an editable request in
 * the source task; nothing runs until the user sends it. Only candidates the
 * Agent actually saved are shown, and none of them is a finding.
 */
export function FindingVariantHunts({ state }: { state: EnabledHuntState }) {
  const [latest, ...earlier] = state.hunts;
  if (!latest)
    return (
      <div className="space-y-1.5">
        <p className="text-[15px] font-medium text-foreground">No hunts yet</p>
        <p className="text-sm leading-6 text-muted-foreground">
          Hunt similar prepares a request in{" "}
          <span className="text-foreground">{state.chat_title}</span>. Agent
          then checks other surfaces you&apos;re authorized to test for this
          root cause. Nothing is sent until you send it.
        </p>
      </div>
    );
  return (
    <div className="space-y-5">
      <HuntBody hunt={latest} />
      <p className="text-[13px] leading-5 text-muted-foreground">
        Agent&apos;s assessment, not certification. Candidates aren&apos;t
        findings and never change this one.
      </p>
      {earlier.length > 0 ? <EarlierHunts hunts={earlier} /> : null}
    </div>
  );
}
