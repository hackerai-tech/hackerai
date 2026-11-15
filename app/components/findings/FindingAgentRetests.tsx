"use client";

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
import {
  useFindingHistoryState,
  type FindingHistorySource,
} from "./useFindingHistoryState";

export type EnabledRetestState = Extract<FindingRetestState, { enabled: true }>;

const RETEST_HISTORY: FindingHistorySource<EnabledRetestState> = {
  load: async (findingId) => {
    try {
      const response = await fetch(
        `/api/finding-retests?findingId=${encodeURIComponent(findingId)}`,
        { cache: "no-store" },
      );
      return response.ok
        ? ((await response.json()) as FindingRetestState)
        : null;
    } catch {
      return null;
    }
  },
  isRunning: (state) =>
    state.retests.some((retest) => retest.status === "running"),
};

/**
 * Retest history for a finding. `undefined` while loading; a failed first read
 * resolves to disabled so the report keeps its existing follow-up actions.
 */
export const useFindingRetestState = (
  findingId: string | undefined,
): FindingRetestState | undefined =>
  useFindingHistoryState(RETEST_HISTORY, findingId);

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
