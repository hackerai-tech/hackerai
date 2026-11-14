"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentRetestOutcome } from "@/lib/findings/agent-retest";
import { getSourceMessageHref } from "@/lib/findings/source-message";
import type {
  FindingAgentRetestView,
  FindingRetestState,
} from "@/types/finding";
import {
  AssessmentDetails,
  AssessmentList,
  AssessmentRow,
  EvidenceList,
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

export type EnabledRetestState = Extract<FindingRetestState, { enabled: true }>;

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

/**
 * Retest history for a finding. `undefined` while loading; a failed first read
 * resolves to disabled so the report keeps its existing follow-up actions.
 * Polls only while a real Agent run is recorded as running.
 */
export function useFindingRetestState(
  findingId: string | undefined,
): FindingRetestState | undefined {
  const [loaded, setLoaded] = useState<{
    findingId: string;
    state: FindingRetestState;
  } | null>(null);
  const readSequence = useRef(0);

  // A failed refresh keeps the last good state for the same finding.
  const read = useCallback((id: string, isCurrent: () => boolean) => {
    const sequence = ++readSequence.current;
    return fetchRetestState(id).then((next) => {
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
    state.retests.some((retest) => retest.status === "running");
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

export const RETEST_OUTCOMES: Record<
  AgentRetestOutcome,
  { label: string; tone: OutcomeTone }
> = {
  reproduced: { label: "Reproduced", tone: "red" },
  not_reproduced: { label: "Not reproduced", tone: "emerald" },
  inconclusive: { label: "Inconclusive", tone: "amber" },
};

const INTERRUPTED_SUMMARY =
  "The Agent run ended before it saved an assessment. This doesn't show the issue is fixed.";

export const retestOutcomeOf = (
  retest: FindingAgentRetestView,
): AgentRetestOutcome => retest.outcome ?? "inconclusive";

const summaryOf = (retest: FindingAgentRetestView) =>
  retest.interrupted ? INTERRUPTED_SUMMARY : (retest.summary ?? "");

function RetestDetails({ retest }: { retest: FindingAgentRetestView }) {
  const fields: AssessmentField[] = [];
  if (retest.reproduction_steps?.length)
    fields.push({
      label: "Steps",
      value: <StepList steps={retest.reproduction_steps} />,
    });
  if (retest.expected_result)
    fields.push({ label: "If fixed", value: retest.expected_result });
  if (retest.observed_result)
    fields.push({ label: "Observed", value: retest.observed_result });
  if (hasEvidence(retest.evidence_refs, retest.evidence_verification))
    fields.push({
      label: "Evidence",
      value: (
        <EvidenceList
          refs={retest.evidence_refs ?? []}
          verification={retest.evidence_verification}
        />
      ),
    });
  if (retest.limitations?.length)
    fields.push({
      label: "Limits",
      value: <TextList items={retest.limitations} />,
    });
  const environment = environmentLabel(retest.environment);
  fields.push({
    label: "Source",
    value: (
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <TaskLink
          href={getSourceMessageHref(
            retest.chat_id,
            retest.assistant_message_id,
          )}
        >
          Open in task
        </TaskLink>
        {environment ? (
          <span className="text-muted-foreground">{environment}</span>
        ) : null}
      </span>
    ),
  });
  return <AssessmentDetails fields={fields} />;
}

function RetestRow({ retest }: { retest: FindingAgentRetestView }) {
  const running = retest.status === "running";
  const outcome = RETEST_OUTCOMES[retestOutcomeOf(retest)];
  const label = running ? "Running" : outcome.label;
  return (
    <AssessmentRow
      label={`${label} retest details`}
      outcome={
        <OutcomeLabel tone={outcome.tone} label={label} running={running} />
      }
      primary={
        <span className="text-muted-foreground">
          {running ? "Agent is retesting" : summaryOf(retest)}
        </span>
      }
      meta={
        <span className="whitespace-nowrap tabular-nums">
          <FindingRelativeTime timestamp={retest.started_at} />
        </span>
      }
    >
      {running ? (
        <AssessmentDetails
          fields={[
            {
              label: "Status",
              value:
                "The assessment appears here when Agent saves it. If the run stops first, it's recorded as Inconclusive.",
            },
            {
              label: "Source",
              value: (
                <TaskLink href={`/c/${encodeURIComponent(retest.chat_id)}`}>
                  Watch in task
                </TaskLink>
              ),
            },
          ]}
        />
      ) : (
        <RetestDetails retest={retest} />
      )}
    </AssessmentRow>
  );
}

/**
 * Agent retest history for a finding. Retests start from the finding header,
 * which prepares an editable request in the source task; nothing runs until
 * the user sends it there. Results are the Agent's judgment and never change
 * the finding.
 */
export function FindingAgentRetests({ state }: { state: EnabledRetestState }) {
  if (state.retests.length === 0)
    return (
      <div className="space-y-1.5">
        <p className="text-[15px] font-medium text-foreground">
          No retests yet
        </p>
        <p className="text-sm leading-6 text-muted-foreground">
          Retest prepares a request in{" "}
          <span className="text-foreground">{state.chat_title}</span>. Agent
          repeats the reproduction with the access you have now. Missing or
          expired access is recorded as Inconclusive, never as fixed. Nothing is
          sent until you send it.
        </p>
      </div>
    );
  return (
    <div className="space-y-4">
      <AssessmentList>
        {state.retests.map((retest) => (
          <RetestRow key={retest.retest_id} retest={retest} />
        ))}
      </AssessmentList>
      <p className="text-[13px] leading-5 text-muted-foreground">
        Agent&apos;s assessment, not independent certification. Retests never
        close or edit this finding.
      </p>
    </div>
  );
}
