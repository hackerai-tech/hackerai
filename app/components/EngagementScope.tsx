"use client";

import { useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  normalizePolicy,
  type ScopeSnapshot,
} from "@/lib/engagement-scope/policy";

export function EngagementScope({ chatId }: { chatId: string }) {
  const scope = useQuery(api.engagementScopes.get, { chatId });
  const save = useMutation(api.engagementScopes.edit);
  const [editing, setEditing] = useState<ScopeSnapshot | null>(null);
  const [rules, setRules] = useState("");
  const [restrictions, setRestrictions] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  if (!scope) return null;
  const open = () => {
    setEditing(scope);
    setRules(
      scope.rules
        .map(
          (r) =>
            `${r.effect === "allow" ? (r.activity === "passive_discovery" ? "passive" : r.ports === "any" ? "allow-all-ports" : "allow") : r.activity === "all_contact" ? "no-contact" : "exclude"} ${r.target}`,
        )
        .join("\n"),
    );
    setRestrictions(scope.restrictions.join("\n"));
    setError("");
  };
  const submit = async () => {
    if (!editing) return;
    setSaving(true);
    setError("");
    try {
      const policy = normalizePolicy({
        rules: rules
          .split("\n")
          .filter((line) => line.trim())
          .map((line) => {
            const match =
              /^(allow|allow-all-ports|passive|exclude|no-contact)\s+(\S+)\s*$/.exec(
                line.trim(),
              );
            if (!match)
              throw new Error(
                "Use one rule per line: allow, exclude, or no-contact followed by a host or URL.",
              );
            return {
              target: match[2],
              ...(match[1] === "allow-all-ports"
                ? { ports: "any" as const }
                : {}),
              effect: ["allow", "allow-all-ports", "passive"].includes(match[1])
                ? ("allow" as const)
                : ("deny" as const),
              activity:
                match[1] === "passive"
                  ? ("passive_discovery" as const)
                  : match[1] === "no-contact"
                    ? ("all_contact" as const)
                    : ("active_testing" as const),
            };
          }),
        restrictions: restrictions
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      await save({ chatId, expectedRevision: editing.revision, policy });
      setEditing(null);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not save scope. Try again.",
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={open}
        aria-label="View and edit engagement scope"
      >
        {scope.status === "ready"
          ? "Scope"
          : scope.status === "ambiguous"
            ? "Scope needs detail"
            : "Scope paused"}
      </Button>
      <Dialog
        open={!!editing}
        onOpenChange={(value) => {
          if (!value && !saving) setEditing(null);
        }}
      >
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Engagement scope</DialogTitle>
            <DialogDescription>
              Saved for this task and its delegated agents. You can also change
              it in chat.
            </DialogDescription>
          </DialogHeader>
          {scope.clarification && (
            <p role="status" className="text-sm">
              {scope.clarification}
            </p>
          )}
          {(scope.status === "unavailable" ||
            scope.status === "processing") && (
            <p role="status" className="text-sm">
              Scope is temporarily paused. Retry the last request or edit the
              scope here. Your saved rules are retained.
            </p>
          )}
          <label htmlFor="scope-rules" className="text-sm font-medium">
            Targets and exclusions
          </label>
          <Textarea
            id="scope-rules"
            value={rules}
            onChange={(e) => setRules(e.target.value)}
            rows={7}
            placeholder={
              "allow example.com\nallow *.example.com\nexclude admin.example.com"
            }
            className="font-mono text-sm"
          />
          <p className="text-sm text-muted-foreground">
            Exact hosts do not include subdomains. Wildcards do not include the
            apex. Bare hosts use HTTP/HTTPS default ports; use a URL for a
            specific port or path. Exclusions take precedence. Use passive for
            passive-only discovery, or allow-all-ports for an explicit all-port
            grant.
          </p>
          <label htmlFor="scope-restrictions" className="text-sm font-medium">
            Activity limits
          </label>
          <Textarea
            id="scope-restrictions"
            value={restrictions}
            onChange={(e) => setRestrictions(e.target.value)}
            rows={3}
            placeholder="For example: passive discovery only"
          />
          <p className="text-xs text-muted-foreground">
            Scope guides all agents and checks submitted URLs. It does not
            filter every shell or browser request.
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button onClick={submit} disabled={saving}>
            {saving ? "Saving…" : "Save scope"}
          </Button>
        </DialogContent>
      </Dialog>
    </>
  );
}
