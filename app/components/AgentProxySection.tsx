"use client";

import { useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { ChevronDown, Loader2, Network, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import { cn } from "@/lib/utils";
import type { AgentProxyProtocol, AgentProxyPublicConfig } from "@/types";

type ProxyFormState = {
  enabled: boolean;
  protocol: AgentProxyProtocol;
  host: string;
  port: string;
  username: string;
  password: string;
  proxyDns: boolean;
  bypassHosts: string;
};

const EMPTY_FORM: ProxyFormState = {
  enabled: false,
  protocol: "http",
  host: "",
  port: "8080",
  username: "",
  password: "",
  proxyDns: true,
  bypassHosts: "",
};

function formFromConfig(config: AgentProxyPublicConfig): ProxyFormState {
  return {
    enabled: config.enabled,
    protocol: config.protocol,
    host: config.host,
    port: String(config.port),
    username: config.username ?? "",
    password: "",
    proxyDns: config.proxyDns,
    bypassHosts: config.bypassHosts.join(", "),
  };
}

export function AgentProxySection() {
  const getProxyConfig = useAction(api.proxyConfigActions.getProxyConfig);
  const saveProxyConfig = useAction(api.proxyConfigActions.saveProxyConfig);
  const deleteProxyConfig = useAction(api.proxyConfigActions.deleteProxyConfig);
  const [form, setForm] = useState<ProxyFormState>(EMPTY_FORM);
  const [hasSavedConfig, setHasSavedConfig] = useState(false);
  const [hasSavedPassword, setHasSavedPassword] = useState(false);
  const [clearPassword, setClearPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false);
  const [isRemoveDialogOpen, setIsRemoveDialogOpen] = useState(false);
  const [testResult, setTestResult] = useState<{
    exitIp: string;
    durationMs: number;
  } | null>(null);
  const capturedExposureRef = useRef(false);
  const isBusy = isSaving || isTesting;

  useEffect(() => {
    if (!capturedExposureRef.current) {
      capturedExposureRef.current = true;
      captureAuthenticatedEvent("agent_proxy_settings_exposed", {
        surface: "agents_tab",
      });
    }

    let cancelled = false;
    void getProxyConfig()
      .then((config) => {
        if (cancelled || !config) return;
        setForm(formFromConfig(config));
        setHasSavedConfig(true);
        setHasSavedPassword(config.hasPassword);
        setIsAdvancedOpen(
          Boolean(
            config.username ||
            config.hasPassword ||
            config.bypassHosts.length > 0 ||
            (config.protocol === "socks5" && !config.proxyDns),
          ),
        );
      })
      .catch(() => {
        if (!cancelled) toast.error("Could not load proxy settings");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [getProxyConfig]);

  const updateForm = <K extends keyof ProxyFormState>(
    key: K,
    value: ProxyFormState[K],
  ) => {
    setForm((current) => ({ ...current, [key]: value }));
    setTestResult(null);
  };

  const persistConfig = async () => {
    const port = Number(form.port);
    if (!form.host.trim()) throw new Error("Enter a proxy host");
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("Enter a valid proxy port");
    }

    const config = await saveProxyConfig({
      enabled: form.enabled,
      protocol: form.protocol,
      host: form.host,
      port,
      ...(form.username.trim() ? { username: form.username } : {}),
      ...(form.password ? { password: form.password } : {}),
      ...(clearPassword ? { clearPassword: true } : {}),
      proxyDns: form.proxyDns,
      bypassHosts: form.bypassHosts
        .split(",")
        .map((host) => host.trim())
        .filter(Boolean),
    });

    setForm(formFromConfig(config));
    setHasSavedConfig(true);
    setHasSavedPassword(config.hasPassword);
    setClearPassword(false);
    return config;
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const config = await persistConfig();
      captureAuthenticatedEvent("agent_proxy_settings_saved", {
        surface: "agents_tab",
        enabled: config.enabled,
        protocol: config.protocol,
      });
      toast.success("Proxy settings saved");
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not save proxy settings",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleTest = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const config = await persistConfig();
      if (!config.enabled)
        throw new Error("Enable the proxy before testing it");

      const response = await fetch("/api/proxy-config/test", {
        method: "POST",
      });
      const result = (await response.json()) as {
        exitIp?: string;
        durationMs?: number;
        error?: string;
      };
      if (!response.ok || !result.exitIp || result.durationMs === undefined) {
        throw new Error(result.error || "Proxy connection test failed");
      }

      setTestResult({ exitIp: result.exitIp, durationMs: result.durationMs });
      captureAuthenticatedEvent("agent_proxy_connection_tested", {
        surface: "agents_tab",
        protocol: config.protocol,
        outcome: "success",
      });
      toast.success("Connected through proxy");
    } catch (error) {
      captureAuthenticatedEvent("agent_proxy_connection_tested", {
        surface: "agents_tab",
        protocol: form.protocol,
        outcome: "failure",
      });
      toast.error(
        error instanceof Error ? error.message : "Proxy connection test failed",
      );
    } finally {
      setIsTesting(false);
    }
  };

  const handleDelete = async () => {
    setIsSaving(true);
    try {
      await deleteProxyConfig();
      setForm(EMPTY_FORM);
      setHasSavedConfig(false);
      setHasSavedPassword(false);
      setClearPassword(false);
      setTestResult(null);
      setIsAdvancedOpen(false);
      setIsRemoveDialogOpen(false);
      captureAuthenticatedEvent("agent_proxy_settings_deleted", {
        surface: "agents_tab",
      });
      toast.success("Proxy settings removed");
    } catch {
      toast.error("Could not remove proxy settings");
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Loading proxy settings…
      </div>
    );
  }

  const showConfiguration = form.enabled || hasSavedConfig;

  return (
    <section
      className="space-y-4 border-b py-3"
      aria-labelledby="agent-proxy-heading"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Network
              className="size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <h3 id="agent-proxy-heading" className="font-medium">
              Cloud Agent Proxy
            </h3>
          </div>
          <p className="max-w-xl text-sm text-muted-foreground">
            Use your own HTTP or SOCKS5 proxy for Cloud Agent terminal and
            browser traffic.
          </p>
        </div>
        <Switch
          checked={form.enabled}
          onCheckedChange={(checked) => updateForm("enabled", checked)}
          disabled={isBusy}
          aria-label="Enable Cloud Agent proxy"
        />
      </div>

      {showConfiguration ? (
        <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
          <div className="space-y-2">
            <Label htmlFor="agent-proxy-host">Proxy Server</Label>
            <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2 sm:grid-cols-[8rem_minmax(0,1fr)_6rem]">
              <Select
                value={form.protocol}
                disabled={isBusy}
                onValueChange={(value) =>
                  updateForm("protocol", value as AgentProxyProtocol)
                }
              >
                <SelectTrigger
                  id="agent-proxy-protocol"
                  aria-label="Protocol"
                  className="col-span-2 sm:col-span-1"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="http">HTTP(S)</SelectItem>
                  <SelectItem value="socks5">SOCKS5</SelectItem>
                </SelectContent>
              </Select>
              <Input
                id="agent-proxy-host"
                name="agent-proxy-host"
                value={form.host}
                onChange={(event) => updateForm("host", event.target.value)}
                disabled={isBusy}
                placeholder="e.g. proxy.example.com…"
                autoComplete="off"
                spellCheck={false}
              />
              <Input
                id="agent-proxy-port"
                name="agent-proxy-port"
                aria-label="Port"
                type="number"
                min={1}
                max={65_535}
                value={form.port}
                onChange={(event) => updateForm("port", event.target.value)}
                disabled={isBusy}
                inputMode="numeric"
                autoComplete="off"
              />
            </div>
          </div>

          <Collapsible open={isAdvancedOpen} onOpenChange={setIsAdvancedOpen}>
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="-ml-2 text-muted-foreground"
                disabled={isBusy}
              >
                Authentication & Advanced
                <ChevronDown
                  className={cn(
                    "ml-2 size-4 transition-transform",
                    isAdvancedOpen && "rotate-180",
                  )}
                  aria-hidden="true"
                />
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 pt-2">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="agent-proxy-username">
                    Username{" "}
                    <span className="text-muted-foreground">(Optional)</span>
                  </Label>
                  <Input
                    id="agent-proxy-username"
                    name="agent-proxy-username"
                    value={form.username}
                    onChange={(event) =>
                      updateForm("username", event.target.value)
                    }
                    disabled={isBusy}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="agent-proxy-password">
                    Password{" "}
                    <span className="text-muted-foreground">(Optional)</span>
                  </Label>
                  <Input
                    id="agent-proxy-password"
                    name="agent-proxy-password"
                    type="password"
                    value={form.password}
                    disabled={isBusy}
                    onChange={(event) => {
                      updateForm("password", event.target.value);
                      if (event.target.value) setClearPassword(false);
                    }}
                    placeholder={
                      hasSavedPassword
                        ? "Saved securely — enter to replace…"
                        : undefined
                    }
                    autoComplete="new-password"
                  />
                  {hasSavedPassword ? (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto px-0 text-xs"
                      disabled={isBusy}
                      onClick={() => {
                        setClearPassword((current) => !current);
                        setForm((current) => ({ ...current, password: "" }));
                      }}
                    >
                      {clearPassword
                        ? "Keep Saved Password"
                        : "Remove Saved Password"}
                    </Button>
                  ) : null}
                </div>
              </div>

              {form.protocol === "socks5" ? (
                <div className="flex items-center justify-between gap-4 rounded-lg bg-muted/50 p-3">
                  <div>
                    <Label htmlFor="agent-proxy-dns">Proxy DNS Lookups</Label>
                    <p className="text-xs text-muted-foreground">
                      Resolve destination hostnames through the SOCKS5 proxy.
                    </p>
                  </div>
                  <Switch
                    id="agent-proxy-dns"
                    checked={form.proxyDns}
                    onCheckedChange={(checked) =>
                      updateForm("proxyDns", checked)
                    }
                    disabled={isBusy}
                  />
                </div>
              ) : null}

              <div className="space-y-2">
                <Label htmlFor="agent-proxy-bypass">
                  Bypass Hosts{" "}
                  <span className="text-muted-foreground">(Optional)</span>
                </Label>
                <Input
                  id="agent-proxy-bypass"
                  name="agent-proxy-bypass"
                  value={form.bypassHosts}
                  onChange={(event) =>
                    updateForm("bypassHosts", event.target.value)
                  }
                  disabled={isBusy}
                  placeholder="e.g. internal.example.com, *.corp.example.com…"
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="text-xs text-muted-foreground">
                  Separate hostnames with commas. Localhost always stays direct.
                </p>
              </div>

              <p className="text-xs text-muted-foreground">
                Credentials are stored in WorkOS Vault and exposed only inside
                your Cloud Agent sandbox.
              </p>
            </CollapsibleContent>
          </Collapsible>

          <p className="text-xs text-muted-foreground">
            Applies to terminal and browser traffic. Web Search and URL Reader
            stay direct.
          </p>
        </div>
      ) : null}

      {testResult ? (
        <div
          className="rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-sm text-green-800 dark:text-green-200"
          aria-live="polite"
        >
          Connected through {testResult.exitIp} · {testResult.durationMs} ms
        </div>
      ) : null}

      {showConfiguration ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={form.enabled ? handleTest : handleSave}
            disabled={isBusy}
          >
            {isBusy ? (
              <Loader2
                className="mr-2 size-4 animate-spin"
                aria-hidden="true"
              />
            ) : null}
            {isTesting
              ? "Testing…"
              : isSaving
                ? "Saving…"
                : form.enabled
                  ? "Save & Test"
                  : "Save Changes"}
          </Button>
          {hasSavedConfig ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setIsRemoveDialogOpen(true)}
              disabled={isBusy}
            >
              <Trash2 className="mr-2 size-4" aria-hidden="true" />
              Remove Proxy
            </Button>
          ) : null}
        </div>
      ) : null}

      <AlertDialog
        open={isRemoveDialogOpen}
        onOpenChange={(open) => {
          if (!isBusy) setIsRemoveDialogOpen(open);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Cloud Agent Proxy?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the saved proxy address and credentials. Cloud Agent
              traffic will connect directly.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isBusy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isBusy}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isSaving ? "Removing…" : "Remove Proxy"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
