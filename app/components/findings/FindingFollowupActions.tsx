"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LoaderCircle,
  LockKeyhole,
  MessageSquareText,
  MoreHorizontal,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { useComposerActions } from "@/app/contexts/ComposerState";
import { getDraftContentById, upsertDraft } from "@/lib/utils/client-storage";
import {
  findingFollowupPrompt,
  type FindingFollowupIntent,
} from "@/lib/findings/followup";
import { captureFindingEvent } from "@/lib/findings/client-telemetry";
import type { FindingEvent } from "@/lib/findings/telemetry";
import { getSourceMessageHref } from "@/lib/findings/source-message";
import type {
  FindingDetailRecord,
  FindingHuntState,
  FindingRetestState,
} from "@/types/finding";
import {
  FindingExportMenu,
  FindingExportStatus,
  FindingExportSubmenu,
  useFindingExport,
} from "./FindingExportMenu";

type PrepareOptions = { recordRetest?: boolean };

const REQUEST_NAMES: Record<FindingFollowupIntent, string> = {
  verify: "verification request",
  retest: "retest request",
  hunt: "hunt request",
};

/**
 * Prepare an editable Agent request in the finding's source chat and open it.
 * An existing unsent draft is never replaced; nothing is sent automatically.
 */
export function useFindingFollowupDraft(finding: FindingDetailRecord) {
  const router = useRouter();
  const pathname = usePathname();
  const { closeSidebar, setChatMode } = useGlobalState();
  const { getInput, setInput } = useComposerActions();
  const [pending, setPending] = useState<{
    intent: FindingFollowupIntent;
    options: PrepareOptions;
  } | null>(null);
  const sourcePath = `/c/${encodeURIComponent(finding.chat_id)}`;
  const existingDraft = () =>
    pathname === sourcePath
      ? getInput()
      : (getDraftContentById(finding.chat_id) ?? "");

  const prepare = (
    intent: FindingFollowupIntent,
    options: PrepareOptions = {},
    append = false,
  ) => {
    const existing = existingDraft();
    if (existing.trim() && !append) {
      setPending({ intent, options });
      return;
    }
    const prompt = findingFollowupPrompt(finding, intent, options);
    const content = existing.trim() ? `${existing}\n\n${prompt}` : prompt;
    try {
      upsertDraft(finding.chat_id, content);
      if (getDraftContentById(finding.chat_id) !== content)
        throw new Error("Draft not saved");
      if (pathname === sourcePath) setInput(content);
      setChatMode("agent");
      closeSidebar();
      setPending(null);
      router.push(sourcePath);
      toast.info("Draft prepared. Review it and send when ready.");
    } catch {
      toast.error(
        "Could not prepare the draft. Your existing draft is unchanged.",
      );
    }
  };

  const dialog = (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) setPending(null);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Keep your existing draft</DialogTitle>
          <DialogDescription>
            This task already has an unsent draft. Add the{" "}
            {pending ? REQUEST_NAMES[pending.intent] : "request"} below it, then
            review before sending. Nothing runs automatically.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            className="h-11 sm:h-9"
            onClick={() => setPending(null)}
          >
            Cancel
          </Button>
          <Button
            className="h-11 sm:h-9"
            onClick={() => {
              if (pending) prepare(pending.intent, pending.options, true);
            }}
          >
            Add below draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { prepare, dialog };
}

// Mobile keeps 44px touch targets; wider panels use the compact toolbar.
const ACTION_CLASS = "h-11 flex-1 @min-[520px]:h-8 @min-[520px]:flex-none";

/**
 * The finding's only follow-up actions. Retest and Hunt similar prepare an
 * editable draft in the source task. Neither starts anything, and neither is
 * offered before its rollout state is known.
 */
export function FindingFollowupActions({
  finding,
  surface,
  retestState,
  huntState,
  showSource,
  onCloseFinding,
}: {
  finding: FindingDetailRecord;
  /** Where the finding is shown; attributed on source navigation. */
  surface: NonNullable<FindingEvent["surface"]>;
  retestState: FindingRetestState | undefined;
  huntState: FindingHuntState | undefined;
  showSource: boolean;
  onCloseFinding?: () => void;
}) {
  const { prepare, dialog } = useFindingFollowupDraft(finding);
  // One exporter for the toolbar menu and the More submenu: shared busy guard
  // and status, kept here so it survives the More menu closing.
  const exporter = useFindingExport(async () => [finding]);
  const retestRunning =
    retestState?.enabled === true &&
    retestState.retests[0]?.status === "running";
  const huntRunning =
    huntState?.enabled === true && huntState.hunts[0]?.status === "running";

  return (
    <>
      <div className="flex min-w-0 items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className={ACTION_CLASS}
          disabled={retestState === undefined || retestRunning}
          onClick={() =>
            retestState?.enabled
              ? prepare("retest", { recordRetest: true })
              : prepare("retest")
          }
        >
          {retestRunning ? (
            <LoaderCircle
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <RotateCcw className="size-4" aria-hidden="true" />
          )}
          {retestRunning ? "Retesting…" : "Retest"}
        </Button>
        {huntState?.enabled ? (
          <Button
            variant="outline"
            size="sm"
            className={ACTION_CLASS}
            disabled={huntRunning}
            onClick={() => prepare("hunt")}
          >
            {huntRunning ? (
              <LoaderCircle
                className="size-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <ScanSearch className="size-4" aria-hidden="true" />
            )}
            {huntRunning ? "Hunting…" : "Hunt similar"}
          </Button>
        ) : null}
        <div className="hidden @min-[520px]:block">
          <FindingExportMenu
            label="Export"
            getFindings={async () => [finding]}
            exporter={exporter}
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="icon"
              className="size-11 shrink-0 @min-[520px]:size-8"
              aria-label="More actions"
            >
              <MoreHorizontal className="size-4" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuItem onSelect={() => prepare("verify")}>
              <ShieldCheck className="size-4" aria-hidden="true" />
              Verify with Agent
            </DropdownMenuItem>
            <FindingExportSubmenu exporter={exporter} />
            {showSource ? (
              <DropdownMenuItem asChild>
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
                >
                  <MessageSquareText className="size-4" aria-hidden="true" />
                  Open source message
                </Link>
              </DropdownMenuItem>
            ) : null}
            {onCloseFinding ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={onCloseFinding}>
                  <LockKeyhole className="size-4" aria-hidden="true" />
                  Close finding…
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <FindingExportStatus exporter={exporter} />
      {dialog}
    </>
  );
}
