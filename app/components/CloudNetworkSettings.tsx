"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { normalizeProxyInput } from "@/lib/cloud-network/proxy";
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

type SettingsResponse = NetworkSettings & { proxyAvailable?: boolean };

export function CloudNetworkSettings() {
  const [saved, setSaved] = useState<SettingsResponse | null>(null);
  const [mode, setMode] = useState<NetworkPolicy["mode"]>("unrestricted");
  const [allow, setAllow] = useState("");
  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [proxyAddress, setProxyAddress] = useState("");
  const [proxyAuth, setProxyAuth] = useState(false);
  const [replaceCredentials, setReplaceCredentials] = useState(false);
  const [proxyUsername, setProxyUsername] = useState("");
  const [proxyPassword, setProxyPassword] = useState("");
  const [operation, setOperation] = useState<"save" | "reload" | null>(null);
  const busy = operation !== null;
  const [error, setError] = useState("");
  const posthog = usePostHog();
  function adopt(value: SettingsResponse) {
    setSaved(value);
    setMode(value.policy.mode);
    setAllow(value.policy.allow.join("\n"));
    setProxyEnabled(Boolean(value.proxy));
    setProxyAddress(value.proxy?.address ?? "");
    setProxyAuth(Boolean(value.proxy?.authenticated));
    setReplaceCredentials(
      value.status === "failed" && Boolean(value.proxy?.authenticated),
    );
    setProxyUsername("");
    setProxyPassword("");
  }
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/sandbox/network", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        return response.json();
      })
      .then((value) => {
        if (!controller.signal.aborted) {
          adopt(value);
          if (value.proxyAvailable || value.proxy)
            posthog?.capture("cloud_proxy_settings_viewed");
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Could not load cloud network settings. Reload to retry.");
      });
    posthog?.capture("cloud_network_settings_viewed");
    return () => controller.abort();
  }, [posthog]);
  // Only poll while the server owns an update. Keep edits locked so refreshing
  // its status cannot replace an unsaved draft, and bound abandoned updates.
  useEffect(() => {
    if (saved?.status !== "applying" || busy || error) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = setTimeout(() => {
      controller.abort();
      clearTimeout(timer);
      setError(
        "The update is taking longer than expected. Reload or retry saving.",
      );
    }, 120_000);
    async function poll() {
      try {
        const response = await fetch("/api/sandbox/network", {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error();
        const value: SettingsResponse = await response.json();
        if (controller.signal.aborted) return;
        adopt(value);
        if (value.status === "applying") timer = setTimeout(poll, 3_000);
      } catch {
        if (!controller.signal.aborted) {
          setSaved(null);
          setError(
            "Could not refresh cloud network settings. Reload to retry.",
          );
        }
      }
    }
    timer = setTimeout(poll, 3_000);
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearTimeout(deadline);
    };
  }, [saved?.status, busy, error]);
  const updating = saved?.status === "applying" && !error;
  const showReload =
    operation === "reload" ||
    Boolean(error && (!saved || saved.status === "applying"));
  async function reload() {
    setOperation("reload");
    setError("");
    try {
      const response = await fetch("/api/sandbox/network");
      if (!response.ok) throw new Error();
      adopt(await response.json());
    } catch {
      setError("Could not load cloud network settings. Reload to retry.");
    } finally {
      setOperation(null);
    }
  }
  async function save() {
    if (!saved) return;
    setOperation("save");
    setError("");
    let submitted = false;
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
      const proxyChanged =
        (saved.status === "failed" && proxyEnabled && saved.proxyAvailable) ||
        proxyEnabled !== Boolean(saved.proxy) ||
        (proxyEnabled &&
          (proxyAddress.trim() !== saved.proxy?.address ||
            proxyAuth !== Boolean(saved.proxy?.authenticated) ||
            replaceCredentials));
      const proxy = !proxyChanged
        ? undefined
        : proxyEnabled
          ? normalizeProxyInput({
              address: proxyAddress,
              credentials: !proxyAuth
                ? null
                : !saved.proxy?.authenticated || replaceCredentials
                  ? { username: proxyUsername, password: proxyPassword }
                  : undefined,
            })
          : null;
      submitted = true;
      const response = await fetch("/api/sandbox/network", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          policy,
          expectedRevision: saved.revision,
          ...(proxy !== undefined ? { proxy } : {}),
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(
          result.error ??
            result.cause ??
            "Could not apply network settings. Reload and retry.",
        );
      }
      adopt({ ...result, proxyAvailable: saved.proxyAvailable });
      toast.success("Network settings updated.");
    } catch (e) {
      // Even a lost response may have persisted a new revision. Read it before
      // retrying, while keeping local validation errors editable.
      if (submitted) setSaved(null);
      setError(
        e instanceof Error ? e.message : "Could not apply network settings.",
      );
    } finally {
      if (submitted) {
        setProxyUsername("");
        setProxyPassword("");
      }
      setOperation(null);
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
        disabled={busy || !saved || updating}
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
            disabled={busy || !saved || updating}
            placeholder={"example.com\n*.example.com\n192.0.2.0/24"}
            rows={4}
          />
          <p className="text-xs text-muted-foreground">
            One domain, IP address, or IP range per line.
          </p>
        </div>
      )}
      {(saved?.proxyAvailable || saved?.proxy) && (
        <div className="space-y-3 pt-2 ph-no-capture ph-no-record">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="cloud-proxy-enabled">Use your own proxy</Label>
            <Switch
              id="cloud-proxy-enabled"
              checked={proxyEnabled}
              onCheckedChange={setProxyEnabled}
              disabled={
                busy ||
                !saved ||
                updating ||
                (!saved.proxyAvailable && !proxyEnabled)
              }
            />
          </div>
          {proxyEnabled && (
            <div className="space-y-3">
              <div className="space-y-2">
                <Label htmlFor="cloud-proxy-address">SOCKS5 address</Label>
                <Input
                  id="cloud-proxy-address"
                  value={proxyAddress}
                  onChange={(event) => setProxyAddress(event.target.value)}
                  placeholder="proxy.example.com:1080"
                  autoComplete="off"
                  disabled={busy || updating || !saved?.proxyAvailable}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Routes cloud TCP traffic through your proxy. DNS and UDP use the
                normal cloud connection. Your access rules still apply.
              </p>
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="cloud-proxy-auth">Proxy authentication</Label>
                <Switch
                  id="cloud-proxy-auth"
                  checked={proxyAuth}
                  onCheckedChange={setProxyAuth}
                  disabled={busy || updating || !saved?.proxyAvailable}
                />
              </div>
              {proxyAuth &&
                (saved?.proxy?.authenticated && !replaceCredentials ? (
                  <Button
                    variant="outline"
                    onClick={() => setReplaceCredentials(true)}
                    disabled={busy || updating || !saved?.proxyAvailable}
                  >
                    Change credentials
                  </Button>
                ) : (
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <Label htmlFor="cloud-proxy-username">Username</Label>
                      <Input
                        id="cloud-proxy-username"
                        value={proxyUsername}
                        onChange={(event) =>
                          setProxyUsername(event.target.value)
                        }
                        autoComplete="off"
                        data-ph-no-capture
                        disabled={busy || updating}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="cloud-proxy-password">Password</Label>
                      <Input
                        id="cloud-proxy-password"
                        type="password"
                        value={proxyPassword}
                        onChange={(event) =>
                          setProxyPassword(event.target.value)
                        }
                        autoComplete="new-password"
                        data-ph-no-capture
                        disabled={busy || updating}
                      />
                    </div>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
      {saved?.status === "failed" && (
        <p role="status" className="text-sm text-amber-600 dark:text-amber-400">
          The last update was not fully verified. Some workspaces may already
          use these rules. Retry Save. If an update is still in progress, wait
          up to two minutes.
        </p>
      )}
      {updating && (
        <p role="status" className="text-sm">
          A network update is in progress.
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button onClick={save} disabled={busy || !saved || updating}>
          {operation === "save" ? "Saving…" : "Save"}
        </Button>
        {showReload && (
          <Button variant="outline" onClick={reload} disabled={busy}>
            {operation === "reload" ? "Reloading…" : "Reload settings"}
          </Button>
        )}
      </div>
    </section>
  );
}
