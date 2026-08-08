"use client";

import { useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { ChevronDown, Loader2, Network } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import { cn } from "@/lib/utils";
import type {
  AgentNetworkConfig,
  AgentNetworkInboundMode,
  AgentNetworkOutboundMode,
} from "@/types";

type NetworkForm = {
  inboundMode: AgentNetworkInboundMode;
  outboundMode: AgentNetworkOutboundMode;
  destinations: string;
};

const DEFAULT_FORM: NetworkForm = {
  inboundMode: "public",
  outboundMode: "unrestricted",
  destinations: "",
};

function formFromConfig(config: AgentNetworkConfig): NetworkForm {
  return {
    inboundMode: config.inboundMode,
    outboundMode: config.outboundMode,
    destinations: config.destinations.join("\n"),
  };
}

function parseDestinations(value: string): string[] {
  return value
    .split(/[\n,]/)
    .map((destination) => destination.trim())
    .filter(Boolean);
}

function getErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Could not save network controls";
  const match = error.message.match(/"message":"([^"]+)"/);
  return match?.[1] ?? error.message;
}

export function AgentNetworkSection() {
  const getConfig = useAction(api.e2bNetworkConfigActions.getE2BNetworkConfig);
  const saveConfig = useAction(
    api.e2bNetworkConfigActions.saveE2BNetworkConfig,
  );
  const [form, setForm] = useState<NetworkForm>(DEFAULT_FORM);
  const [savedInboundMode, setSavedInboundMode] =
    useState<AgentNetworkInboundMode>("public");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const capturedExposureRef = useRef(false);

  useEffect(() => {
    if (!capturedExposureRef.current) {
      capturedExposureRef.current = true;
      captureAuthenticatedEvent("agent_network_settings_exposed", {
        surface: "agents_tab",
      });
    }

    let cancelled = false;
    void getConfig()
      .then((config) => {
        if (cancelled || !config) return;
        setForm(formFromConfig(config));
        setSavedInboundMode(config.inboundMode);
      })
      .catch(() => {
        if (!cancelled) toast.error("Could not load network controls");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [getConfig]);

  const updateForm = <K extends keyof NetworkForm>(
    key: K,
    value: NetworkForm[K],
  ) => setForm((current) => ({ ...current, [key]: value }));

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const config = await saveConfig({
        inboundMode: form.inboundMode,
        outboundMode: form.outboundMode,
        destinations: parseDestinations(form.destinations),
      });
      const inboundChanged = savedInboundMode !== config.inboundMode;
      setForm(formFromConfig(config));
      setSavedInboundMode(config.inboundMode);
      captureAuthenticatedEvent("agent_network_settings_saved", {
        surface: "agents_tab",
        inbound_mode: config.inboundMode,
        outbound_mode: config.outboundMode,
        destination_count: config.destinations.length,
      });
      toast.success(
        inboundChanged
          ? "Saved. Inbound access changes when Cloud Agent next starts."
          : "Network controls saved",
      );
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  };

  const handleRestoreDefaults = async () => {
    setIsSaving(true);
    try {
      const inboundChanged = savedInboundMode !== "public";
      const config = await saveConfig({
        inboundMode: "public",
        outboundMode: "unrestricted",
        destinations: [],
      });
      setForm(formFromConfig(config));
      setSavedInboundMode(config.inboundMode);
      captureAuthenticatedEvent("agent_network_settings_saved", {
        surface: "agents_tab",
        inbound_mode: "public",
        outbound_mode: "unrestricted",
        destination_count: 0,
        restored_defaults: true,
      });
      toast.success(
        inboundChanged
          ? "Defaults restored. Inbound access changes when Cloud Agent next starts."
          : "Network defaults restored",
      );
    } catch (error) {
      toast.error(getErrorMessage(error));
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden="true" />
        Loading network controls…
      </div>
    );
  }

  const showDestinations = form.outboundMode !== "unrestricted";
  const isDefault =
    form.inboundMode === "public" &&
    form.outboundMode === "unrestricted" &&
    form.destinations.trim() === "";

  return (
    <section
      className="space-y-4 border-b py-3"
      aria-labelledby="network-title"
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-md bg-muted p-2">
          <Network className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 id="network-title" className="font-medium">
            Cloud Agent network
          </h3>
          <p className="text-sm text-muted-foreground">
            Control public URLs and outbound destinations for Cloud Agent. Local
            and desktop environments are unchanged.
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="agent-network-inbound">Inbound access</Label>
          <Select
            value={form.inboundMode}
            onValueChange={(value) =>
              updateForm("inboundMode", value as AgentNetworkInboundMode)
            }
            disabled={isSaving}
          >
            <SelectTrigger id="agent-network-inbound" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="public">Public URL</SelectItem>
              <SelectItem value="token_required">Token required</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {form.inboundMode === "public"
              ? "Anyone who knows a sandbox service URL can reach it."
              : "Public URL requests must include the sandbox access token."}
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="agent-network-outbound">Outbound access</Label>
          <Select
            value={form.outboundMode}
            onValueChange={(value) =>
              updateForm("outboundMode", value as AgentNetworkOutboundMode)
            }
            disabled={isSaving}
          >
            <SelectTrigger id="agent-network-outbound" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="unrestricted">Unrestricted</SelectItem>
              <SelectItem value="allow_only">
                Allow only listed destinations
              </SelectItem>
              <SelectItem value="block_list">
                Block listed destinations
              </SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {form.outboundMode === "unrestricted"
              ? "Cloud Agent can connect to any destination."
              : form.outboundMode === "allow_only"
                ? "Everything is blocked except the destinations below."
                : "All traffic is allowed except the IPs and CIDRs below."}
          </p>
        </div>
      </div>

      {showDestinations ? (
        <div className="space-y-2">
          <Label htmlFor="agent-network-destinations">
            {form.outboundMode === "allow_only"
              ? "Allowed destinations"
              : "Blocked destinations"}
          </Label>
          <Textarea
            id="agent-network-destinations"
            value={form.destinations}
            onChange={(event) => updateForm("destinations", event.target.value)}
            disabled={isSaving}
            rows={4}
            spellCheck={false}
            placeholder={
              form.outboundMode === "allow_only"
                ? "api.example.com\n*.github.com\n203.0.113.0/24"
                : "203.0.113.10\n198.51.100.0/24"
            }
          />
          <p className="text-xs text-muted-foreground">
            One per line or comma-separated.{" "}
            {form.outboundMode === "allow_only"
              ? "Domains, IP addresses, and CIDR blocks are supported."
              : "Block lists support IP addresses and CIDR blocks, not domains."}
          </p>
        </div>
      ) : null}

      <Collapsible open={isDetailsOpen} onOpenChange={setIsDetailsOpen}>
        <CollapsibleTrigger className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          How filtering works
          <ChevronDown
            className={cn(
              "size-4 transition-transform",
              isDetailsOpen ? "rotate-180" : "",
            )}
            aria-hidden="true"
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-2 space-y-1 text-xs text-muted-foreground">
          <p>
            Outbound changes apply live without restarting Cloud Agent. Inbound
            changes apply when Cloud Agent next starts; idle sandbox state is
            preserved during the switch.
          </p>
          <p>
            Domain filtering covers HTTP on port 80 and TLS on port 443. Use an
            IP or CIDR for other ports. These controls filter destinations and
            do not change the sandbox exit IP.
          </p>
        </CollapsibleContent>
      </Collapsible>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="ghost"
          onClick={handleRestoreDefaults}
          disabled={isSaving || isDefault}
        >
          Restore defaults
        </Button>
        <Button type="button" onClick={handleSave} disabled={isSaving}>
          {isSaving ? (
            <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
          ) : null}
          Save network controls
        </Button>
      </div>
    </section>
  );
}
