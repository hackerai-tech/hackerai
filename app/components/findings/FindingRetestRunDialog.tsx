"use client";

import { useState } from "react";
import { Check, LockKeyhole, Monitor, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { HttpRetestRecipe } from "@/lib/findings/http-retest";
import type { FindingRetestRunView } from "@/types/finding";

export type RetestRunResponse =
  | { success: true; run: FindingRetestRunView }
  | { success: false; message: string };

const newRequestId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/**
 * Review the exact requests and enter runtime credentials. Values stay in
 * component state only, are excluded from session replay, and are cleared on
 * close and after submit. Closing the dialog does not stop a started run.
 */
export function FindingRetestRunDialog({
  open,
  onOpenChange,
  findingId,
  version,
  recipe,
  environmentKind,
  environmentRevision,
  onStarted,
  onFinished,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  findingId: string;
  version: number;
  recipe: HttpRetestRecipe;
  environmentKind: "cloud" | "local";
  environmentRevision: string;
  onStarted: () => void;
  onFinished: (result: RetestRunResponse) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [requestId] = useState(newRequestId);
  const [authorized, setAuthorized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requests = [...recipe.baselines, recipe.probe];
  const complete =
    authorized &&
    recipe.credentials.every((credential) => values[credential.name]?.trim());

  const close = (next: boolean) => {
    if (!next) {
      setValues({});
      setAuthorized(false);
      setError(null);
    }
    onOpenChange(next);
  };

  const run = () => {
    if (!complete) return;
    const credentials = Object.fromEntries(
      recipe.credentials.map((c) => [c.name, values[c.name]]),
    );
    const body = JSON.stringify({
      findingId,
      recipeVersion: version,
      requestId,
      reviewedOrigin: recipe.origin,
      reviewedEnvironment: environmentRevision,
      authorized: true,
      credentials,
    });
    // Clear the inputs immediately; the request body is the only copy.
    close(false);
    onStarted();
    void fetch("/api/finding-retests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    })
      .then(async (response) => {
        const result = (await response.json().catch(() => null)) as
          RetestRunResponse | { message?: string } | null;
        if (response.ok && result && "success" in result && result.success)
          onFinished(result);
        else
          onFinished({
            success: false,
            message:
              (result && "message" in result && result.message) ||
              "The retest could not start. Try again.",
          });
      })
      .catch(() =>
        onFinished({
          success: false,
          message:
            "The connection dropped before a result arrived. Reload to see the saved outcome.",
        }),
      );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] overflow-y-auto overscroll-contain p-4 sm:max-w-xl sm:p-6">
        <form
          className="ph-no-capture space-y-5"
          data-ph-no-capture
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            run();
          }}
        >
          <DialogHeader className="pr-8 text-left">
            <DialogTitle>Run HTTP retest</DialogTitle>
            <DialogDescription>
              Sends {requests.length} read-only requests from the computer
              selected in this finding&apos;s source task. HackerAI&apos;s
              servers never contact the target.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">
              Runs on the source task&apos;s computer
            </p>
            <div className="flex h-10 items-center gap-2.5 rounded-lg border border-dashed border-border px-3 text-sm">
              <Monitor
                className="size-4 text-muted-foreground"
                aria-hidden="true"
              />
              {environmentKind === "cloud" ? "Cloud sandbox" : "Local computer"}
            </div>
            <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
              <Check
                className="mt-0.5 size-3.5 shrink-0 text-emerald-500"
                aria-hidden="true"
              />
              <span>
                Only{" "}
                <span className="font-mono text-foreground" translate="no">
                  {recipe.origin}
                </span>{" "}
                is contacted. Other hosts and redirects are refused.
              </span>
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium text-foreground">Requests</p>
            <ol className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-muted/20">
              {requests.map((request, index) => (
                <li
                  key={index}
                  className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-xs"
                >
                  <span className="w-3 shrink-0 font-mono text-muted-foreground">
                    {index + 1}
                  </span>
                  <span
                    className="min-w-0 flex-1 break-all font-mono"
                    translate="no"
                  >
                    <span className="font-semibold">GET</span> {request.path}
                  </span>
                  <span className="w-full break-words pl-6 text-left text-muted-foreground sm:w-auto sm:max-w-[40%] sm:pl-0 sm:text-right">
                    {request.label}
                  </span>
                </li>
              ))}
            </ol>
          </div>

          {recipe.credentials.map((credential) => (
            <div key={credential.name} className="space-y-2">
              <label
                htmlFor={`retest-credential-${credential.name}`}
                className="flex items-baseline gap-2 text-sm font-medium text-foreground"
              >
                {credential.label}
                <span className="font-mono text-xs font-normal text-muted-foreground">
                  {credential.name}
                </span>
              </label>
              <Input
                id={`retest-credential-${credential.name}`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                className="ph-no-capture ph-mask font-mono"
                placeholder={
                  credential.placement === "bearer"
                    ? "Bearer token"
                    : credential.placement === "cookie"
                      ? "Cookie header value"
                      : `${credential.header_name} value`
                }
                value={values[credential.name] ?? ""}
                onChange={(event) =>
                  setValues((prev) => ({
                    ...prev,
                    [credential.name]: event.target.value,
                  }))
                }
              />
            </div>
          ))}
          {recipe.credentials.length > 0 ? (
            <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
              <LockKeyhole
                className="mt-0.5 size-3.5 shrink-0"
                aria-hidden="true"
              />
              Sent to the source task&apos;s computer for this run only. Never
              saved in the recipe, run snapshot, chat or logs.
            </p>
          ) : null}

          <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
            <input
              type="checkbox"
              className="mt-0.5 size-4 shrink-0 accent-foreground"
              checked={authorized}
              onChange={(event) => setAuthorized(event.target.checked)}
            />
            <span className="space-y-0.5">
              <span className="block text-sm font-medium text-foreground">
                I&apos;m authorized to test this target with these accounts
              </span>
              <span className="block text-xs leading-5 text-muted-foreground">
                These are live requests. Requests stop after{" "}
                {recipe.timeout_ms / 1000} s each and the whole run within 30 s.
                Closing the report doesn&apos;t cancel a started run.
              </span>
            </span>
          </label>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter className="sticky bottom-0 z-10 -mx-4 -mb-4 border-t border-border bg-background p-4 sm:static sm:m-0 sm:border-0 sm:bg-transparent sm:p-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => close(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!complete}>
              <Play className="size-4" aria-hidden="true" />
              Run {requests.length} requests
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
