"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

interface ByokStatus {
  hasKey: boolean;
}

const ByokSection = () => {
  const [loading, setLoading] = useState(true);
  const [hasKey, setHasKey] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/byok", { method: "GET" });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = (await res.json()) as ByokStatus;
      setHasKey(!!data.hasKey);
    } catch {
      toast.error("Failed to load API key status");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const handleSave = async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      toast.error("Enter an API key");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/byok", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: trimmed }),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        toast.error(data.error || "Failed to save API key");
        return;
      }
      toast.success("API key saved");
      setApiKey("");
      await refresh();
    } catch {
      toast.error("Failed to save API key");
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      const res = await fetch("/api/byok", { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Failed to remove API key");
        return;
      }
      toast.success("API key removed");
      await refresh();
    } catch {
      toast.error("Failed to remove API key");
    } finally {
      setRemoving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h4 className="text-sm font-medium">OpenRouter API key</h4>
        <p className="text-sm text-muted-foreground">
          Use your own OpenRouter API key. LLM costs bill to your OpenRouter
          account; sandbox and tools still use your HackerAI plan.
        </p>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : hasKey ? (
        <div className="flex items-center justify-between gap-3 rounded-md border p-3">
          <div className="text-sm">
            <div className="font-medium">API key configured</div>
            <div className="text-muted-foreground">
              Active — LLM calls route to your OpenRouter account
            </div>
          </div>
          <Button
            variant="outline"
            onClick={handleRemove}
            disabled={removing}
            data-testid="byok-remove-button"
          >
            {removing ? "Removing…" : "Remove key"}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-or-..."
            autoComplete="off"
            spellCheck={false}
            disabled={saving}
            data-testid="byok-input"
          />
          <div className="flex justify-end">
            <Button
              onClick={handleSave}
              disabled={saving || !apiKey.trim()}
              data-testid="byok-save-button"
            >
              {saving ? "Validating…" : "Save & validate"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Create a key at{" "}
            <a
              href="https://openrouter.ai/keys"
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              openrouter.ai/keys
            </a>
            .
          </p>
        </div>
      )}
    </div>
  );
};

export { ByokSection };
