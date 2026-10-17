import { useQuery } from "convex/react";
import { Maximize2, MousePointerClick, RefreshCw } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/convex/_generated/api";
import { normalizeBrowserInputBatch } from "@/lib/ai/browser-handoff/input";
import {
  readBrowserRelay,
  sendBrowserRelayInput,
} from "@/lib/ai/browser-handoff/relay-client";

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
  browserRequested = false,
  runActive = false,
  onJumpToLive,
  onContinue,
}: {
  chatId: string;
  agentId: string;
  liveSelection: boolean;
  browserRequested?: boolean;
  runActive?: boolean;
  onJumpToLive?: () => void;
  onContinue?: (message: { id: string; text: string }) => Promise<void>;
}) {
  const session = useQuery(api.browserHandoffs.getForUser, { chatId, agentId });
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [frameSeenAt, setFrameSeenAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [previewState, setPreviewState] = useState("loading");
  const [fullScreen, setFullScreen] = useState(false);
  const inputRef = useRef<HTMLDivElement>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const [relayUrl, setRelayUrl] = useState<string | null>(null);
  const relaySequence = useRef(0);
  const [relayReconnect, setRelayReconnect] = useState(0);
  const [grant, setGrant] = useState<string | null>(null);
  const [exitOpen, setExitOpen] = useState(false);
  const [note, setNote] = useState("");
  const [hasTakenControl, setHasTakenControl] = useState(false);
  const exitRequestId = useRef<string | null>(null);
  const lastSession = useRef<{ scope: string; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasteError, setPasteError] = useState<string | null>(null);
  const grantRef = useRef<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const exposedRef = useRef<string | null>(null);
  const inputQueue = useRef<Promise<void>>(Promise.resolve());
  const bufferedInputs = useRef<BrowserInput[]>([]);
  const drainingInputs = useRef(false);
  const lastMoveAt = useRef(0);
  const wheelHandlerRef = useRef<
    ((event: WheelEvent, element: HTMLImageElement) => void) | null
  >(null);
  const attachWheelListener = useCallback(
    (element: HTMLImageElement | null) => {
      if (!element) return;
      const listener = (event: WheelEvent) =>
        wheelHandlerRef.current?.(event, element);
      element.addEventListener("wheel", listener, { passive: false });
      return () => element.removeEventListener("wheel", listener);
    },
    [],
  );
  const resumeButtonRef = useRef<HTMLButtonElement>(null);
  const resumingRef = useRef(false);
  const scope = `${chatId}:${agentId}`;
  if (session?.sessionId)
    lastSession.current = { scope, id: session.sessionId };
  const sessionId =
    session?.sessionId ??
    (lastSession.current?.scope === scope ? lastSession.current.id : undefined);
  const activeSessionId = session?.sessionId;
  const noteStorageKey = sessionId
    ? `hackerai:browser-handoff-note:${scope}:${sessionId}`
    : null;
  const endpoint = sessionId
    ? `/api/agent/browser/${encodeURIComponent(sessionId)}`
    : null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    sessionIdRef.current = sessionId ?? null;
  }, [sessionId]);

  useEffect(() => {
    setFullScreen(false);
    setFrame(null);
    setFrameSeenAt(0);
    setPreviewState("loading");
    setExitOpen(false);
    try {
      const saved = noteStorageKey
        ? sessionStorage.getItem(noteStorageKey)
        : null;
      setNote(saved?.slice(0, 4000) ?? "");
    } catch {
      setNote("");
    }
    exitRequestId.current = null;
    setHasTakenControl(false);
    setBusy(false);
    setError(null);
    setPasteError(null);
    setGrant(null);
    setRelayUrl(null);
    relaySequence.current = 0;
    grantRef.current = null;
    exposedRef.current = null;
    resumingRef.current = false;
    bufferedInputs.current = [];
    drainingInputs.current = false;
  }, [sessionId, noteStorageKey]);

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
    if (!endpoint || !activeSessionId || (grant && relayUrl)) return;
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
        }
      } catch {
        if (!stopped) setPreviewState("disconnected");
      } finally {
        if (!stopped) timer = setTimeout(poll, grantRef.current ? 200 : 1600);
      }
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [endpoint, activeSessionId, grant, relayUrl]);

  useEffect(() => {
    if (!relayUrl || !grant || !activeSessionId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stream = async () => {
      try {
        await readBrowserRelay(
          relayUrl,
          grant,
          controller.signal,
          (nextFrame) => {
            if (controller.signal.aborted) return;
            setFrame(nextFrame);
            setFrameSeenAt(Date.now());
            setPreviewState("ready");
          },
          () => {
            if (controller.signal.aborted) return;
            setFrameSeenAt(Date.now());
            setPreviewState("ready");
          },
        );
      } catch {
        if (controller.signal.aborted) return;
        setPreviewState("disconnected");
        timer = setTimeout(stream, 500);
      }
    };
    void stream();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [relayUrl, grant, activeSessionId, relayReconnect]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!endpoint || !grant || !activeSessionId) return;
    let stopped = false;
    const timer = setInterval(() => {
      void post({ action: "heartbeat", grant }).catch(() => {
        if (
          stopped ||
          !mountedRef.current ||
          sessionIdRef.current !== sessionId ||
          grantRef.current !== grant
        )
          return;
        grantRef.current = null;
        setGrant(null);
        setPreviewState("recovery");
        setError(
          "Control expired. Reconnect or choose Exit takeover to continue.",
        );
      });
    }, 10_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [endpoint, grant, post, sessionId, activeSessionId]);

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
    !session ||
    !frame ||
    previewState !== "ready" ||
    now - frameSeenAt > FRAME_STALE_MS;
  const human = !!grant && !!session;
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
    ((!!session && !frameStale && (human || effectiveState === "recovery")) ||
      (!session && hasTakenControl) ||
      (effectiveState === "agent" && !!exitRequestId.current));

  useLayoutEffect(() => {
    if (grant && fullScreen) inputRef.current?.focus({ preventScroll: true });
  }, [grant, fullScreen]);

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
      setRelayUrl(data.relayUrl ?? null);
      relaySequence.current = 0;
      setFullScreen(true);
      setFrame(data.frame);
      setFrameSeenAt(Date.now());
      setPreviewState("ready");
      setExitOpen(false);
      if (!hasTakenControl) exitRequestId.current = null;
      setHasTakenControl(true);
    } catch (cause) {
      if (!mountedRef.current || sessionIdRef.current !== sessionId) return;
      setError(
        cause instanceof Error ? cause.message : "Could not take control",
      );
    } finally {
      if (mountedRef.current && sessionIdRef.current === sessionId)
        setBusy(false);
    }
  };

  const resumeAgent = async () => {
    if (!canResume || resumingRef.current) return;
    resumingRef.current = true;
    const activeGrant = grantRef.current;
    setBusy(true);
    setError(null);
    try {
      // Finish accepted keystrokes before revoking control. Once resume starts,
      // new input is ignored so the queue cannot grow while it drains.
      await inputQueue.current;
      if (
        !mountedRef.current ||
        sessionIdRef.current !== sessionId ||
        grantRef.current !== activeGrant
      )
        return;
      const data = await post({
        action: "resume",
        grant: activeGrant,
        browserSessionName: frame?.browserSessionName,
        requestId: (exitRequestId.current ??= crypto.randomUUID()),
        note,
      });
      if (!mountedRef.current || sessionIdRef.current !== sessionId) return;
      grantRef.current = null;
      setGrant(null);
      if (data.restart) {
        if (!onContinue)
          throw new Error(
            "Your note is saved. Reopen this chat to continue the Agent.",
          );
        await onContinue(data.continuation);
      }
      // Starting a run can register a new browser before admission resolves.
      // A completion from the old session must not close or clear its takeover.
      if (!mountedRef.current || sessionIdRef.current !== sessionId) return;
      setFullScreen(false);
      setExitOpen(false);
      setNote("");
      try {
        if (noteStorageKey) sessionStorage.removeItem(noteStorageKey);
      } catch {
        // Storage may be unavailable; the submitted context is already saved.
      }
      exitRequestId.current = null;
      setHasTakenControl(false);
      if (data.frame) {
        setFrame(data.frame);
        setFrameSeenAt(Date.now());
      }
    } catch (cause) {
      if (!mountedRef.current || sessionIdRef.current !== sessionId) return;
      grantRef.current = null;
      setGrant(null);
      setError(
        cause instanceof Error ? cause.message : "Could not resume Agent",
      );
      setPreviewState("recovery");
    } finally {
      if (mountedRef.current && sessionIdRef.current === sessionId) {
        resumingRef.current = false;
        setBusy(false);
      }
    }
  };

  const sendInput = (input: BrowserInput) => {
    const activeGrant = grantRef.current;
    if (!activeGrant || frameStale || resumingRef.current) return;
    // Moves are advisory; do not let them delay clicks or keystrokes.
    if (input.kind === "move" && drainingInputs.current) return;
    const buffer = bufferedInputs.current;
    buffer.push(input);
    if (drainingInputs.current) return;
    drainingInputs.current = true;
    // Keep one ordered request in flight. Input arriving during its round trip
    // is sent together next, rather than adding a round trip per character.
    inputQueue.current = inputQueue.current
      .catch(() => undefined)
      .then(async () => {
        while (buffer.length && grantRef.current === activeGrant) {
          const inputs: BrowserInput[] = [];
          while (buffer.length && inputs.length < 16) {
            // Share the server's event AND serialized-size bounds. Newline key
            // pairs are larger than ordinary text and can hit the byte limit first.
            if (!normalizeBrowserInputBatch([...inputs, buffer[0]])) {
              if (!inputs.length) throw new Error("Unsupported browser input");
              break;
            }
            inputs.push(buffer.shift()!);
          }
          if (relayUrl) {
            await sendBrowserRelayInput(
              relayUrl,
              activeGrant,
              ++relaySequence.current,
              inputs,
            );
          } else {
            await post({ action: "input", grant: activeGrant, inputs });
          }
        }
      })
      .catch(() => {
        if (
          !mountedRef.current ||
          sessionIdRef.current !== sessionId ||
          grantRef.current !== activeGrant
        )
          return;
        grantRef.current = null;
        setGrant(null);
        setPreviewState("recovery");
        setError("Browser input disconnected. Reconnect before continuing.");
      })
      .finally(() => {
        if (bufferedInputs.current === buffer) {
          bufferedInputs.current = [];
          drainingInputs.current = false;
        }
      });
  };

  const point = (event: {
    currentTarget: HTMLImageElement;
    clientX: number;
    clientY: number;
  }) => {
    if (!frame) return null;
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    // CDP's screencast metadata can report a taller device viewport than the
    // encoded frame. Input coordinates must follow the pixels the user sees.
    const width = event.currentTarget.naturalWidth || frame.width;
    const height = event.currentTarget.naturalHeight || frame.height;
    return {
      x: Math.max(
        0,
        Math.min(width, ((event.clientX - rect.left) * width) / rect.width),
      ),
      y: Math.max(
        0,
        Math.min(height, ((event.clientY - rect.top) * height) / rect.height),
      ),
    };
  };

  useLayoutEffect(() => {
    // Keep the native non-passive listener stable while using the latest grant,
    // frame and input queue. React's delegated wheel listener is passive.
    wheelHandlerRef.current = (event, element) => {
      if (!human) return;
      event.preventDefault();
      if (frameStale || !frame) return;
      const xy = point({
        currentTarget: element,
        clientX: event.clientX,
        clientY: event.clientY,
      });
      if (!xy) return;
      const unit =
        event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.height : 1;
      sendInput({
        kind: "wheel",
        ...xy,
        deltaX: Math.max(-2000, Math.min(2000, event.deltaX * unit)),
        deltaY: Math.max(-2000, Math.min(2000, event.deltaY * unit)),
      });
    };
  });

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!human || frameStale) return;
    if (event.key === "Escape") {
      event.preventDefault();
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
          // The Cloud browser runs on Linux, so Cmd shortcuts use Ctrl.
          (event.ctrlKey || event.metaKey ? 2 : 0) +
          (event.shiftKey ? 8 : 0),
      });
    }
  };

  if (!session && !browserRequested && !hasTakenControl) return null;

  const statusLabel = !session
    ? session === undefined
      ? "Checking browser…"
      : runActive
        ? "Browser unavailable"
        : "Session ended"
    : human
      ? "You control this browser"
      : effectiveState === "claiming"
        ? "Pausing Agent…"
        : effectiveState === "resuming"
          ? "Resuming Agent…"
          : frameStale
            ? previewState === "loading"
              ? "Connecting browser…"
              : "Preview unavailable"
            : effectiveState === "recovery"
              ? "Paused for handoff"
              : effectiveState === "human"
                ? "Controlled in another window"
                : "Live preview";

  const browserContent = (
    <section
      className={
        fullScreen
          ? "flex h-full min-h-0 flex-col bg-background"
          : "mt-3 overflow-hidden rounded-xl border border-border bg-background"
      }
      aria-label="Agent browser preview"
    >
      {!fullScreen && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/30 px-3 py-2 text-xs">
          <span className="font-medium text-foreground">Agent browser</span>
          <span className="text-muted-foreground" role="status">
            {statusLabel}
          </span>
          {human && !fullScreen && (
            <button
              ref={openButtonRef}
              type="button"
              onClick={() => setFullScreen(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Maximize2 size={14} aria-hidden /> Open browser
            </button>
          )}
          {!human && (
            <button
              type="button"
              ref={openButtonRef}
              onClick={() => void takeControl()}
              disabled={!canTake || busy}
              aria-label="Take control of Agent browser"
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1.5 font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              <MousePointerClick className="h-3.5 w-3.5" aria-hidden />
              {busy ? "Taking control…" : "Take control"}
            </button>
          )}
        </div>
      )}
      <div
        className={`relative bg-muted/30 ${fullScreen ? "flex min-h-0 flex-1 items-center justify-center overflow-hidden" : "max-h-[38vh] overflow-auto"} ${session && !frame ? "min-h-24" : ""}`}
      >
        {frame && (
          <div
            ref={inputRef}
            role={human ? "application" : undefined}
            tabIndex={human ? 0 : -1}
            aria-label={
              human
                ? "Control Agent browser. Escape moves focus to Exit takeover."
                : undefined
            }
            className={`${fullScreen ? "flex h-full w-full min-h-0 items-center justify-center" : ""} ${human ? "cursor-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring" : ""}`}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              if (!human) return;
              event.preventDefault();
              if (frameStale || resumingRef.current) return;
              const text = event.clipboardData
                .getData("text")
                .replace(/\r\n?/g, "\n");
              if (text.length > 2048) {
                setPasteError(
                  "Nothing was pasted. Paste a smaller section (up to 2,048 characters) at a time.",
                );
                return;
              }
              setPasteError(null);
              const chars = [...text];
              for (let i = 0; i < chars.length; i += 31) {
                sendInput({
                  kind: "text",
                  text: chars.slice(i, i + 31).join(""),
                });
              }
            }}
          >
            {/* Dynamic frames are authenticated data URLs from the server. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={frame.image}
              alt="Current Agent browser viewport"
              draggable={false}
              className={
                fullScreen
                  ? "block h-auto max-h-full w-auto max-w-full select-none"
                  : "block h-auto w-full select-none"
              }
              onLoad={() => {
                if (exposedRef.current === sessionId) return;
                exposedRef.current = sessionId ?? null;
                void post({ action: "exposure" }).catch(() => undefined);
              }}
              onPointerDown={(event) => {
                if (!human || frameStale) return;
                event.preventDefault();
                inputRef.current?.focus({ preventScroll: true });
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
              ref={attachWheelListener}
            />
          </div>
        )}
        {session && frameStale && (
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
      </div>
      <div
        className={
          fullScreen
            ? "pointer-events-none absolute inset-x-0 bottom-[calc(2rem+env(safe-area-inset-bottom))] z-20 flex flex-col-reverse items-center gap-2 px-4"
            : "flex shrink-0 flex-col gap-2 px-3 py-2 text-xs text-muted-foreground"
        }
      >
        {human || effectiveState === "recovery" || hasTakenControl ? (
          <button
            ref={resumeButtonRef}
            type="button"
            onClick={() => {
              setExitOpen(true);
              setError(null);
            }}
            disabled={busy}
            className={`${fullScreen ? "pointer-events-auto min-h-11 shadow-lg" : "self-start"} rounded-full bg-foreground px-5 py-2.5 text-sm font-medium text-background hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50`}
          >
            Exit takeover
          </button>
        ) : !fullScreen ? (
          <span>
            {!session
              ? session === undefined
                ? "Checking whether this Agent has an active browser session."
                : runActive
                  ? "Take control is available after an eligible Cloud Agent opens its browser."
                  : "This Agent run has ended, so browser control is unavailable. Ask the Agent to reopen the page and wait for you to take control."
              : !liveSelection
                ? "You’re viewing an earlier tool. Return to the live tool to take control."
                : frameStale
                  ? "Take control will be available when the live browser preview connects."
                  : "Take control to click and type. The Agent’s browser actions pause until you resume."}
          </span>
        ) : null}
        {session && !liveSelection && onJumpToLive && (
          <button
            type="button"
            onClick={onJumpToLive}
            className="self-start font-medium text-foreground underline underline-offset-2"
          >
            Return to live browser
          </button>
        )}
        {fullScreen && session && !human && hasTakenControl && (
          <div className="pointer-events-auto flex max-w-sm flex-col items-center gap-2 rounded-xl border border-border bg-background px-4 py-3 text-center text-sm shadow-lg">
            <p role="status" className="text-muted-foreground">
              {effectiveState === "human" || effectiveState === "claiming"
                ? "Waiting for the previous control session to release…"
                : "Browser control disconnected. Reconnect to click and type."}
            </p>
            <button
              type="button"
              onClick={() => void takeControl()}
              disabled={!canTake || busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw size={14} aria-hidden />
              {busy ? "Reconnecting…" : "Reconnect control"}
            </button>
          </div>
        )}
        {(error || pasteError) && (
          <span
            role="alert"
            className={`text-sm text-destructive ${fullScreen ? "max-w-sm rounded-xl border border-border bg-background px-4 py-3 text-center shadow-lg" : ""}`}
          >
            {error || pasteError}
          </span>
        )}
        {session && frameStale && (
          <button
            type="button"
            onClick={() => {
              setFrameSeenAt(0);
              setPreviewState("loading");
              setRelayReconnect((value) => value + 1);
            }}
            className={`pointer-events-auto inline-flex items-center gap-1 text-foreground underline-offset-2 hover:underline ${fullScreen ? "rounded-lg border border-border bg-background px-3 py-2 text-sm shadow-lg" : "self-start"}`}
          >
            <RefreshCw size={12} aria-hidden /> Reconnect preview
          </button>
        )}
      </div>
    </section>
  );

  // Keep the controller mounted while switching views. A route navigation
  // would release the grant and interrupt queued input and the Agent pause.
  return (
    <>
      <Dialog open={fullScreen} onOpenChange={setFullScreen}>
        {!fullScreen && browserContent}
        <DialogContent
          showCloseButton={false}
          className="inset-0 top-0 left-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 p-0 duration-0 sm:max-w-none"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            inputRef.current?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            openButtonRef.current?.focus({ preventScroll: true });
          }}
          onEscapeKeyDown={(event) => {
            // Escape leaves remote keyboard control, rather than silently
            // dismissing the workspace or resuming the Agent.
            event.preventDefault();
            resumeButtonRef.current?.focus();
          }}
        >
          <DialogTitle className="sr-only">Browser control</DialogTitle>
          <DialogDescription className="sr-only">
            Interact with the Agent browser while the Agent is paused. Choose
            Exit takeover to continue the Agent.
          </DialogDescription>
          {fullScreen && browserContent}
        </DialogContent>
      </Dialog>
      <Dialog
        open={exitOpen}
        onOpenChange={(open) => {
          if (!busy) setExitOpen(open);
        }}
      >
        <DialogContent
          className="grid max-h-[calc(100dvh-2rem)] gap-4 overflow-y-auto sm:max-w-lg"
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <DialogTitle className="pr-6 text-xl">
            Tell HackerAI what you did
          </DialogTitle>
          <DialogDescription>
            Briefly describe what you did, such as signing in or filling in
            details, so HackerAI can continue from here. This is optional.
          </DialogDescription>
          <textarea
            aria-label="What did you do? (optional)"
            placeholder="e.g. I've signed in…"
            value={note}
            onChange={(event) => {
              const value = event.target.value;
              setNote(value);
              // Keep unsent context through reconnect/remount, scoped to this
              // browser session and tab. Never persist the control grant.
              try {
                if (noteStorageKey) {
                  if (value) sessionStorage.setItem(noteStorageKey, value);
                  else sessionStorage.removeItem(noteStorageKey);
                }
              } catch {
                // Typing and continuing still work when browser storage is blocked.
              }
            }}
            maxLength={4000}
            disabled={busy || !!exitRequestId.current}
            className="min-h-32 w-full resize-y rounded-xl border border-input bg-muted/40 p-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          {!session && (
            <p className="text-sm text-muted-foreground">
              This run has ended. Continue will start a new Agent turn with your
              saved context.
            </p>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <button
            type="button"
            disabled={!canResume || busy}
            onClick={() => void resumeAgent()}
            className="justify-self-end rounded-xl bg-foreground px-5 py-3 font-medium text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {busy ? "Continuing…" : "Send and continue"}
          </button>
        </DialogContent>
      </Dialog>
    </>
  );
}
