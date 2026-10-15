import { useQuery } from "convex/react";
import { MousePointerClick, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/convex/_generated/api";

type BrowserFrame = {
  image: string;
  width: number;
  height: number;
  capturedAt: number;
  browserSessionName: string;
};

type BrowserInput =
  | { kind: "move" | "down" | "up"; x: number; y: number }
  | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: "key"; key: string; code: string; modifiers: number }
  | { kind: "text"; text: string };

const FRAME_STALE_MS = 10_000;

export function AgentBrowserPreview({
  chatId,
  agentId,
  liveSelection,
}: {
  chatId: string;
  agentId: string;
  liveSelection: boolean;
}) {
  const session = useQuery(api.browserHandoffs.getForUser, { chatId, agentId });
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [frameSeenAt, setFrameSeenAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [previewState, setPreviewState] = useState("loading");
  const [grant, setGrant] = useState<string | null>(null);
  const [confirmedIdentity, setConfirmedIdentity] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const grantRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const exposedRef = useRef<string | null>(null);
  const inputQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingInputs = useRef(0);
  const lastMoveAt = useRef(0);
  const resumeButtonRef = useRef<HTMLButtonElement>(null);
  const sessionId = session?.sessionId;
  const endpoint = sessionId
    ? `/api/agent/browser/${encodeURIComponent(sessionId)}`
    : null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    sessionIdRef.current = sessionId ?? null;
    setFrame(null);
    setFrameSeenAt(0);
    setPreviewState("loading");
    setConfirmedIdentity(false);
    setGrant(null);
    grantRef.current = null;
    exposedRef.current = null;
  }, [sessionId]);

  const post = useCallback(
    async (body: Record<string, unknown>, keepalive = false) => {
      if (!endpoint) throw new Error("Browser session expired");
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        keepalive,
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.state ?? data.error ?? "Browser unavailable");
      return data;
    },
    [endpoint],
  );

  useEffect(() => {
    if (!endpoint) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const response = await fetch(endpoint, {
          cache: "no-store",
          credentials: "same-origin",
        });
        const data = await response.json();
        if (stopped) return;
        if (!response.ok || !data.frame) {
          setPreviewState(data.state ?? "disconnected");
        } else {
          setFrame(data.frame as BrowserFrame);
          setFrameSeenAt(Date.now());
          setPreviewState("ready");
          setError(null);
        }
      } catch {
        if (!stopped) setPreviewState("disconnected");
      } finally {
        if (!stopped) timer = setTimeout(poll, 1600);
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [endpoint]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!endpoint || !grant) return;
    const timer = setInterval(() => {
      void post({ action: "heartbeat", grant }).catch(() => {
        grantRef.current = null;
        setGrant(null);
        setPreviewState("recovery");
        setError("Control expired. Reconnect or resume the Agent explicitly.");
      });
    }, 10_000);
    return () => clearInterval(timer);
  }, [endpoint, grant, post]);

  // Closing the sidebar or changing runs releases input without resuming the
  // Agent. A lost network is covered by the short lease and paused gate.
  useEffect(() => {
    return () => {
      const activeGrant = grantRef.current;
      if (!activeGrant || !endpoint) return;
      grantRef.current = null;
      void fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "release", grant: activeGrant }),
        keepalive: true,
        cache: "no-store",
      }).catch(() => undefined);
    };
  }, [endpoint]);

  const frameStale =
    !frame || previewState !== "ready" || now - frameSeenAt > FRAME_STALE_MS;
  const human = !!grant;
  const effectiveState =
    session &&
    (((session.state === "human" || session.state === "claiming") &&
      (session.grantExpiresAt ?? 0) <= now) ||
      (session.state === "resuming" && session.updatedAt + 30_000 <= now))
      ? "recovery"
      : session?.state;
  const canTake =
    liveSelection &&
    !frameStale &&
    !human &&
    (effectiveState === "agent" || effectiveState === "recovery");
  const canResume =
    liveSelection &&
    !frameStale &&
    confirmedIdentity &&
    (human || effectiveState === "recovery");

  const takeControl = async () => {
    if (!canTake || !frame) return;
    setBusy(true);
    setError(null);
    try {
      const data = await post({
        action: "take",
        browserSessionName: frame.browserSessionName,
      });
      if (!mountedRef.current || sessionIdRef.current !== sessionId) {
        void post({ action: "release", grant: data.grant }, true).catch(
          () => undefined,
        );
        return;
      }
      grantRef.current = data.grant;
      setGrant(data.grant);
      setFrame(data.frame);
      setFrameSeenAt(Date.now());
      setPreviewState("ready");
      setConfirmedIdentity(false);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not take control",
      );
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const resumeAgent = async () => {
    if (!canResume || !frame) return;
    setBusy(true);
    setError(null);
    try {
      const data = await post({
        action: "resume",
        grant: grantRef.current,
        browserSessionName: frame.browserSessionName,
        confirmedIdentity: true,
      });
      grantRef.current = null;
      setGrant(null);
      setConfirmedIdentity(false);
      setFrame(data.frame);
      setFrameSeenAt(Date.now());
    } catch (cause) {
      grantRef.current = null;
      setGrant(null);
      setError(
        cause instanceof Error ? cause.message : "Could not resume Agent",
      );
      setPreviewState("recovery");
    } finally {
      setBusy(false);
    }
  };

  const sendInput = (input: BrowserInput) => {
    const activeGrant = grantRef.current;
    if (!activeGrant || frameStale) return;
    // Moves are advisory; do not let them delay clicks or keystrokes.
    if (input.kind === "move" && pendingInputs.current > 0) return;
    pendingInputs.current += 1;
    inputQueue.current = inputQueue.current
      .catch(() => undefined)
      .then(async () => {
        if (grantRef.current !== activeGrant) return;
        await post({ action: "input", grant: activeGrant, input });
      })
      .catch(() => {
        grantRef.current = null;
        setGrant(null);
        setPreviewState("recovery");
        setError("Browser input disconnected. Reconnect before continuing.");
      })
      .finally(() => {
        pendingInputs.current -= 1;
      });
  };

  const point = (
    event:
      React.PointerEvent<HTMLImageElement> | React.WheelEvent<HTMLImageElement>,
  ) => {
    if (!frame) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: Math.max(
        0,
        Math.min(
          frame.width,
          ((event.clientX - rect.left) * frame.width) / rect.width,
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          frame.height,
          ((event.clientY - rect.top) * frame.height) / rect.height,
        ),
      ),
    };
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!human || frameStale) return;
    if (event.key === "Escape") {
      resumeButtonRef.current?.focus();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v")
      return;
    event.preventDefault();
    if (
      event.key.length === 1 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      sendInput({ kind: "text", text: event.key });
    } else {
      sendInput({
        kind: "key",
        key: event.key,
        code: event.code,
        modifiers:
          (event.altKey ? 1 : 0) +
          (event.ctrlKey ? 2 : 0) +
          (event.metaKey ? 4 : 0) +
          (event.shiftKey ? 8 : 0),
      });
    }
  };

  if (!session) return null;

  return (
    <section
      className="mt-3 overflow-hidden rounded-xl border border-border bg-background"
      aria-label="Agent browser preview"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-2 text-xs">
        <span className="font-medium text-foreground">Agent browser</span>
        <span className="text-muted-foreground" role="status">
          {human
            ? "You control this browser"
            : frameStale
              ? previewState
              : effectiveState === "recovery"
                ? "Paused for handoff"
                : "Live preview"}
        </span>
      </div>
      <div className="relative max-h-[38vh] overflow-auto bg-muted/30">
        {frame && (
          <div
            role={human ? "application" : undefined}
            tabIndex={human ? 0 : -1}
            aria-label={
              human
                ? "Control Agent browser. Escape moves focus to Resume agent."
                : undefined
            }
            className={
              human
                ? "cursor-crosshair focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                : ""
            }
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              if (!human) return;
              event.preventDefault();
              const text = event.clipboardData.getData("text").slice(0, 2048);
              for (let i = 0; i < text.length; i += 32) {
                sendInput({ kind: "text", text: text.slice(i, i + 32) });
              }
            }}
          >
            {/* Dynamic frames are authenticated data URLs from the server. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={frame.image}
              alt="Current Agent browser viewport"
              draggable={false}
              className="block h-auto w-full select-none"
              onLoad={() => {
                if (exposedRef.current === sessionId) return;
                exposedRef.current = sessionId ?? null;
                void post({ action: "exposure" }).catch(() => undefined);
              }}
              onPointerDown={(event) => {
                if (!human || frameStale) return;
                const xy = point(event);
                if (!xy) return;
                event.currentTarget.setPointerCapture(event.pointerId);
                sendInput({ kind: "down", ...xy });
              }}
              onPointerUp={(event) => {
                if (!human || frameStale) return;
                const xy = point(event);
                if (xy) sendInput({ kind: "up", ...xy });
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                if (
                  !human ||
                  frameStale ||
                  Date.now() - lastMoveAt.current < 120
                )
                  return;
                lastMoveAt.current = Date.now();
                const xy = point(event);
                if (xy) sendInput({ kind: "move", ...xy });
              }}
              onWheel={(event) => {
                if (!human || frameStale) return;
                event.preventDefault();
                const xy = point(event);
                if (xy)
                  sendInput({
                    kind: "wheel",
                    ...xy,
                    deltaX: event.deltaX,
                    deltaY: event.deltaY,
                  });
              }}
            />
          </div>
        )}
        {frameStale && (
          <div className="absolute inset-0 flex min-h-24 items-center justify-center bg-background/80 px-4 text-center text-xs text-muted-foreground backdrop-blur-sm">
            {previewState === "loading"
              ? "Waiting for Agent browser…"
              : previewState === "closed"
                ? "Browser session closed"
                : previewState === "stale"
                  ? "Browser changed. Waiting for a current frame…"
                  : "Browser preview disconnected. Input is paused."}
          </div>
        )}
        {canTake && (
          <button
            type="button"
            onClick={() => void takeControl()}
            disabled={busy}
            aria-label="Take control of Agent browser"
            className="group absolute bottom-[10px] right-[10px] z-10 flex h-10 min-h-10 w-10 min-w-10 cursor-pointer items-center justify-center overflow-hidden rounded-full border border-border bg-popover text-foreground shadow-lg backdrop-blur transition-[width,background-color,color] duration-300 hover:w-[136px] hover:bg-blue-600 hover:text-white focus-visible:w-[136px] focus-visible:bg-blue-600 focus-visible:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed [@media(hover:none)]:w-[136px]"
          >
            <MousePointerClick className="h-4 w-4 shrink-0" aria-hidden />
            <span className="max-w-0 overflow-hidden whitespace-nowrap text-xs font-medium opacity-0 transition-[max-width,opacity] duration-300 group-hover:ml-2 group-hover:max-w-24 group-hover:opacity-100 group-focus-visible:ml-2 group-focus-visible:max-w-24 group-focus-visible:opacity-100 [@media(hover:none)]:ml-2 [@media(hover:none)]:max-w-24 [@media(hover:none)]:opacity-100">
              Take control
            </span>
          </button>
        )}
      </div>
      <div className="flex flex-col gap-2 px-3 py-2 text-xs text-muted-foreground">
        {human || effectiveState === "recovery" ? (
          <>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={confirmedIdentity}
                onChange={(event) => setConfirmedIdentity(event.target.checked)}
                className="mt-0.5"
              />
              <span>
                I verified the site and, if signed in, the account shown.
              </span>
            </label>
            <button
              ref={resumeButtonRef}
              type="button"
              onClick={() => void resumeAgent()}
              disabled={!canResume || busy}
              className="self-start rounded-md bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              Resume agent
            </button>
          </>
        ) : (
          <span>
            Open this sidebar to view. Take control to use the browser.
          </span>
        )}
        {!liveSelection && (
          <span>Return to the live tool to control this browser.</span>
        )}
        {error && (
          <span role="alert" className="text-destructive">
            {error}
          </span>
        )}
        {frameStale && (
          <button
            type="button"
            onClick={() => {
              setFrameSeenAt(0);
              setPreviewState("loading");
            }}
            className="inline-flex self-start items-center gap-1 text-foreground underline-offset-2 hover:underline"
          >
            <RefreshCw size={12} aria-hidden /> Reconnect preview
          </button>
        )}
      </div>
    </section>
  );
}
