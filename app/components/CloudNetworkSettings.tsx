"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  normalizeNetworkPolicy,
  type NetworkSettings,
  type NetworkPolicy,
} from "@/lib/cloud-network/policy";
import { usePostHog } from "posthog-js/react";
import { toast } from "sonner";

export function CloudNetworkSettings() {
  const [saved, setSaved] = useState<NetworkSettings | null>(null);
  const [mode, setMode] = useState<NetworkPolicy["mode"]>("unrestricted");
  const [allow, setAllow] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const posthog = usePostHog();
  function adopt(value: NetworkSettings) {
    setSaved(value);
    setMode(value.policy.mode);
    setAllow(value.policy.allow.join("\n"));
  }
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/sandbox/network", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return response.json();
      })
      .then((value) => {
        if (!controller.signal.aborted) adopt(value);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Could not load cloud network settings. Reload to retry.");
      });
    posthog?.capture("cloud_network_settings_viewed");
    return () => controller.abort();
  }, [posthog]);
  async function reload() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/sandbox/network");
      if (!response.ok) throw new Error();
      adopt(await response.json());
    } catch {
      setError("Could not load cloud network settings. Reload to retry.");
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!saved) return;
    setBusy(true);
    setError("");
    try {
      const policy = normalizeNetworkPolicy({
        mode,
        allow:
          mode === "restricted"
            ? allow
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean)
            : [],
      });
      const response = await fetch("/api/sandbox/network", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy, expectedRevision: saved.revision }),
      });
      const result = await response.json();
      if (!response.ok) {
        // A failed provider update may have persisted a new desired revision.
        // Reload before retrying; never claim the old revision is still current.
        setSaved(null);
        throw new Error(
          result.error ??
            result.cause ??
            "Could not apply network settings. Reload and retry.",
        );
      }
      adopt(result);
      toast.success("Network settings updated.");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not apply network settings.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="space-y-3 border-b pb-6"
      aria-labelledby="cloud-network-title"
    >
      <div>
        <h3 id="cloud-network-title" className="font-medium">
          Cloud network access
        </h3>
        <p className="text-sm text-muted-foreground">
          Choose what all tasks in your cloud workspace can access.
        </p>
      </div>
      <Label htmlFor="cloud-network-mode">Access</Label>
      <Select
        value={mode}
        onValueChange={(value) => setMode(value as NetworkPolicy["mode"])}
        disabled={busy || !saved}
      >
        <SelectTrigger id="cloud-network-mode">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="unrestricted">Internet access</SelectItem>
          <SelectItem value="restricted">Allowed destinations only</SelectItem>
          <SelectItem value="offline">No internet</SelectItem>
        </SelectContent>
      </Select>
      {mode === "restricted" && (
        <div className="space-y-2">
          <Label htmlFor="cloud-network-allow">Allowed destinations</Label>
          <Textarea
            id="cloud-network-allow"
            value={allow}
            onChange={(e) => setAllow(e.target.value)}
            disabled={busy || !saved}
            placeholder={"example.com\n*.example.com\n192.0.2.0/24"}
            rows={4}
          />
          <p className="text-xs text-muted-foreground">
            One domain, IP address, or IP range per line.
          </p>
        </div>
      )}
      {saved?.status === "failed" && (
        <p role="status" className="text-sm text-amber-600 dark:text-amber-400">
          The last update was not fully verified. Some workspaces may already
          use these rules. Retry Apply. If an update is still in progress, wait
          up to two minutes.
        </p>
      )}
      {saved?.status === "applying" && (
        <p role="status" className="text-sm">
          A network update is in progress. Reload shortly to check its status.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button onClick={save} disabled={busy || !saved}>
          {busy ? "Applying…" : "Apply network settings"}
        </Button>
        <Button variant="outline" onClick={reload} disabled={busy}>
          Reload settings
        </Button>
      </div>
    </section>
  );
}
