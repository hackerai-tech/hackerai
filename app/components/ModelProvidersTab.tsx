"use client";

import { useState, type FormEvent } from "react";
import { ExternalLink, KeyRound, LoaderCircle, LogIn } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ORCAROUTER_AUTHORIZED_APPS_URL,
  ORCAROUTER_KEYS_URL,
} from "@/lib/ai/orcarouter/config";
import {
  useOrcaRouterConnect,
  useOrcaRouterConnection,
} from "@/app/hooks/useOrcaRouter";

const SOURCE_LABELS = {
  api_key: "API key",
  pkce: "OrcaRouter sign-in",
} as const;

/**
 * OrcaRouter offers two equal ways to connect: paste an existing API key, or
 * sign in with an OrcaRouter account (OAuth 2.0 + PKCE). Both store the same
 * kind of key, encrypted server-side; it is never sent back to the browser.
 */
const ModelProvidersTab = () => {
  const { connection, isLoading, saveApiKey, clear } =
    useOrcaRouterConnection();
  const { connect, isConnecting } = useOrcaRouterConnect();
  const [apiKey, setApiKey] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  const enabled = connection?.enabled ?? false;
  const busy = isSaving || isClearing || isConnecting;

  const handleSave = async (event: FormEvent) => {
    event.preventDefault();
    setIsSaving(true);
    try {
      await saveApiKey(apiKey);
      setApiKey("");
      toast.success("OrcaRouter API key saved");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to save API key",
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleConnect = async () => {
    try {
      await connect();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to start sign-in",
      );
    }
  };

  const handleClear = async () => {
    setIsClearing(true);
    try {
      await clear();
      toast.success("OrcaRouter disconnected");
    } catch {
      toast.error("Failed to disconnect OrcaRouter");
    } finally {
      setIsClearing(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="model-providers-tab">
      <div className="overflow-hidden rounded-lg border bg-card text-card-foreground">
        <div className="flex items-start gap-4 border-b p-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/orcarouter-logo.png"
            alt=""
            width={32}
            height={32}
            className="size-8 shrink-0 rounded-md"
          />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">OrcaRouter</div>
            <p className="mt-1 text-sm text-muted-foreground">
              Use models from your own{" "}
              <a
                href="https://www.orcarouter.ai"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2"
              >
                OrcaRouter
              </a>{" "}
              account in Ask mode. Tokens are billed by OrcaRouter to your
              account, not to your HackerAI usage.
            </p>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            Loading…
          </div>
        ) : !enabled ? (
          <div className="p-4 text-sm text-muted-foreground">
            OrcaRouter is not enabled on this HackerAI deployment.
          </div>
        ) : (
          <>
            {connection?.connected && (
              <div
                className="flex flex-wrap items-center gap-3 border-b p-4 text-sm"
                data-testid="orcarouter-status"
              >
                <div className="min-w-0 flex-1">
                  {connection.status === "needs_reauth" ? (
                    <span className="text-destructive">
                      OrcaRouter rejected the saved key. Reconnect below.
                    </span>
                  ) : (
                    <span>
                      Connected with {SOURCE_LABELS[connection.source]}{" "}
                      <span className="font-mono text-muted-foreground">
                        {connection.keyHint}
                      </span>
                    </span>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleClear}
                  disabled={busy}
                >
                  Disconnect
                </Button>
              </div>
            )}

            <div className="grid gap-4 p-4 md:grid-cols-2">
              <form
                onSubmit={handleSave}
                className="space-y-3 rounded-md border p-4"
                data-testid="orcarouter-api-key-option"
              >
                <div className="flex items-center gap-2 text-sm font-medium">
                  <KeyRound className="size-4" />
                  Paste an API key
                </div>
                <label className="sr-only" htmlFor="orcarouter-api-key">
                  OrcaRouter API key
                </label>
                <Input
                  id="orcarouter-api-key"
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="sk-orca-…"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  disabled={busy}
                />
                <div className="flex items-center justify-between gap-2">
                  <a
                    href={ORCAROUTER_KEYS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2"
                  >
                    Get a key
                    <ExternalLink className="size-3" />
                  </a>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={busy || apiKey.trim().length === 0}
                  >
                    {isSaving ? "Saving…" : "Save key"}
                  </Button>
                </div>
              </form>

              <div
                className="flex flex-col justify-between gap-3 rounded-md border p-4"
                data-testid="orcarouter-pkce-option"
              >
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <LogIn className="size-4" />
                    Sign in with OrcaRouter
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Approve HackerAI in your browser and a key is created for
                    you. Revoke it anytime from{" "}
                    <a
                      href={ORCAROUTER_AUTHORIZED_APPS_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-2"
                    >
                      authorized apps
                    </a>
                    .
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="self-end"
                  onClick={handleConnect}
                  disabled={busy}
                >
                  {isConnecting ? "Opening OrcaRouter…" : "Connect OrcaRouter"}
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export { ModelProvidersTab };
