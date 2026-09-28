"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import {
  getOrcaRouterAuthErrorMessage,
  isOrcaRouterAuthErrorKind,
} from "@/lib/ai/orcarouter/auth-errors";
import {
  ORCAROUTER_CONNECT_RESULT_PARAM,
  type OrcaRouterModel,
} from "@/lib/ai/orcarouter/models";

export const MODEL_PROVIDERS_SETTINGS_TAB = "Model providers";

export type OrcaRouterConnection =
  | { enabled: boolean; connected: false }
  | {
      enabled: true;
      connected: true;
      source: "api_key" | "pkce";
      status: "active" | "needs_reauth";
      keyHint: string;
      updatedAt: number;
    };

export type OrcaRouterCatalogResponse =
  | { status: "live"; models: OrcaRouterModel[] }
  | { status: "fallback"; reason: string; models: OrcaRouterModel[] }
  | { status: "unauthorized" | "not_connected"; models: [] };

export const ORCAROUTER_CONNECTION_KEY = "/api/orcarouter/credential";
export const ORCAROUTER_MODELS_KEY = "/api/orcarouter/models";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as {
    error?: unknown;
  };
  if (!response.ok) {
    throw new Error(
      typeof body.error === "string" ? body.error : "Request failed",
    );
  }
  return body as T;
}

/** Connection status for the signed-in user. Never contains the key. */
export function useOrcaRouterConnection(enabled = true) {
  const { data, error, isLoading, mutate } = useSWR<OrcaRouterConnection>(
    enabled ? ORCAROUTER_CONNECTION_KEY : null,
    (url: string) => requestJson<OrcaRouterConnection>(url),
    { revalidateOnFocus: false },
  );

  const saveApiKey = useCallback(
    async (apiKey: string) => {
      const next = await requestJson<OrcaRouterConnection>(
        ORCAROUTER_CONNECTION_KEY,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey }),
        },
      );
      await mutate(next, { revalidate: false });
      return next;
    },
    [mutate],
  );

  const clear = useCallback(async () => {
    const next = await requestJson<OrcaRouterConnection>(
      ORCAROUTER_CONNECTION_KEY,
      { method: "DELETE" },
    );
    await mutate(next, { revalidate: false });
  }, [mutate]);

  return { connection: data, error, isLoading, saveApiKey, clear, mutate };
}

/**
 * Starts OAuth 2.0 + PKCE. The server creates the verifier and returns the
 * consent URL; the browser then leaves for OrcaRouter and comes back to the
 * app's callback. Busy state is released on failure and on `pagehide`, so a
 * back-forward-cache restore never leaves the button stuck.
 */
const navigateTo = (url: string) => window.location.assign(url);

export function useOrcaRouterConnect(
  navigate: (url: string) => void = navigateTo,
) {
  const [isConnecting, setIsConnecting] = useState(false);
  const attemptRef = useRef(0);

  useEffect(() => {
    const release = () => {
      attemptRef.current += 1;
      setIsConnecting(false);
    };
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      attemptRef.current += 1;
    };
  }, []);

  const connect = useCallback(async () => {
    const attempt = ++attemptRef.current;
    setIsConnecting(true);
    try {
      const { authorizeUrl } = await requestJson<{ authorizeUrl: string }>(
        "/api/orcarouter/connect",
        { method: "POST" },
      );
      if (attempt !== attemptRef.current) return;
      navigate(authorizeUrl);
    } catch (error) {
      if (attempt === attemptRef.current) setIsConnecting(false);
      throw error;
    }
  }, [navigate]);

  return { connect, isConnecting };
}

/** Live OrcaRouter chat catalog for the model selector (server holds the key). */
export function useOrcaRouterModels(enabled: boolean) {
  const { data, error, isLoading, mutate } = useSWR<OrcaRouterCatalogResponse>(
    enabled ? ORCAROUTER_MODELS_KEY : null,
    (url: string) => requestJson<OrcaRouterCatalogResponse>(url),
    { revalidateOnFocus: false, dedupingInterval: 5 * 60 * 1000 },
  );
  return { catalog: data, error, isLoading, refresh: () => mutate() };
}

/**
 * The Connect callback returns to `/?orcarouter_connect=<result>`. Report the
 * result once, reopen the Model providers tab, and drop the parameter so a
 * reload does not repeat the message.
 */
export function reportOrcaRouterConnectResult(
  openSettings: (tab?: string) => void,
) {
  const url = new URL(window.location.href);
  const result = url.searchParams.get(ORCAROUTER_CONNECT_RESULT_PARAM);
  if (!result) return;
  url.searchParams.delete(ORCAROUTER_CONNECT_RESULT_PARAM);
  window.history.replaceState(window.history.state, "", url);

  if (result === "connected") {
    toast.success("OrcaRouter connected");
  } else {
    toast.error(
      isOrcaRouterAuthErrorKind(result)
        ? getOrcaRouterAuthErrorMessage(result)
        : "OrcaRouter sign-in did not complete.",
    );
  }
  openSettings(MODEL_PROVIDERS_SETTINGS_TAB);
}
