"use client";

import { useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { RotateCcw, ShieldCheck } from "lucide-react";
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
import { useGlobalState } from "@/app/contexts/GlobalState";
import { useComposerActions } from "@/app/contexts/ComposerState";
import { getDraftContentById, upsertDraft } from "@/lib/utils/client-storage";
import {
  findingFollowupPrompt,
  type FindingFollowupIntent,
} from "@/lib/findings/followup";
import type { FindingDetailRecord } from "@/types/finding";

export function FindingFollowupActions({
  finding,
}: {
  finding: FindingDetailRecord;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const { closeSidebar, setChatMode } = useGlobalState();
  const { getInput, setInput } = useComposerActions();
  const [pending, setPending] = useState<FindingFollowupIntent | null>(null);
  const sourcePath = `/c/${encodeURIComponent(finding.chat_id)}`;
  const existingDraft = () =>
    pathname === sourcePath
      ? getInput()
      : (getDraftContentById(finding.chat_id) ?? "");

  const prepare = (intent: FindingFollowupIntent, append = false) => {
    const existing = existingDraft();
    if (existing.trim() && !append) {
      setPending(intent);
      return;
    }
    const prompt = findingFollowupPrompt(finding, intent);
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

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => prepare("verify")}>
          <ShieldCheck className="size-4" aria-hidden="true" />
          Verify
        </Button>
        <Button variant="outline" size="sm" onClick={() => prepare("retest")}>
          <RotateCcw className="size-4" aria-hidden="true" />
          Retest
        </Button>
      </div>
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
              This task already has an unsent draft. Add the finding request
              below it, then review before sending. Nothing runs automatically.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (pending) prepare(pending, true);
              }}
            >
              Add below draft
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
