import { useQuery } from "convex/react";
import {
  Keyboard,
  Maximize2,
  MousePointerClick,
  RefreshCw,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Dialog,
  DialogClose,
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
  | { kind: "down" | "up"; x: number; y: number }
  | { kind: "move"; x: number; y: number; buttons?: 0 | 1 }
  | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: "key"; key: string; code: string; modifiers: number }
  | { kind: "text"; text: string };

const FRAME_STALE_MS = 10_000;

class BrowserRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function AgentBrowserPreview({
  chatId,
  agentId,
  liveSelection,
  browserRequested = false,
  takeoverRequest,
  onTakeoverRequestConsumed,
  runActive = false,
  onJumpToLive,
  onContinue,
  onVisibilityChange,
}: {
  chatId: string;
  agentId: string;
  liveSelection: boolean;
  browserRequested?: boolean;
  takeoverRequest?: { requestId: string; sessionId: string };
  onTakeoverRequestConsumed?: (requestId: string) => void;
  onVisibilityChange?: (visible: boolean) => void;
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
  const keyboardRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const keyboardActiveRef = useRef(false);
  const keyboardBeforeInputRef = useRef<
    ((event: InputEvent, element: HTMLTextAreaElement) => void) | null
  >(null);
  const attachKeyboard = useCallback((element: HTMLTextAreaElement | null) => {
    keyboardRef.current = element;
    if (!element) return;
    const listener = (event: InputEvent) =>
      keyboardBeforeInputRef.current?.(event, element);
    element.addEventListener("beforeinput", listener);
    return () => {
      element.removeEventListener("beforeinput", listener);
      if (keyboardRef.current === element) keyboardRef.current = null;
    };
  }, []);
  const touchRef = useRef<{
    id: number;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const resizingRef = useRef(false);
  const [resizing, setResizing] = useState(false);
  const [touchDevice, setTouchDevice] = useState(false);
  const [visibleViewport, setVisibleViewport] = useState<{
    width: number;
    height: number;
    top: number;
    left: number;
  } | null>(null);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const [relayUrl, setRelayUrl] = useState<string | null>(null);
  const relaySequence = useRef(0);
  const [relayReconnect, setRelayReconnect] = useState(0);
  const [grant, setGrant] = useState<string | null>(null);
  const [renewalPending, setRenewalPending] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);
  const [note, setNote] = useState("");
  const [hasTakenControl, setHasTakenControl] = useState(false);
  const exitRequestId = useRef<string | null>(null);
  const [exitRetryAvailable, setExitRetryAvailable] = useState(false);
  const lastSession = useRef<{ scope: string; id: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [takingControl, setTakingControl] = useState(false);
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
  const mouseRef = useRef<{
    id: number;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const releaseMouseRef = useRef<(() => void) | null>(null);
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

  // A registered browser can outlive the tool that opened it. Only show it
  // for browser tools or a handoff that still needs the user's attention.
  const showPreview =
    browserRequested ||
    fullScreen ||
    hasTakenControl ||
    session?.state === "waiting" ||
    session?.state === "claiming" ||
    session?.state === "human" ||
    session?.state === "recovery" ||
    session?.state === "resuming";

  useLayoutEffect(() => {
    onVisibilityChange?.(showPreview);
    return () => onVisibilityChange?.(false);
  }, [showPreview, onVisibilityChange]);

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
    setExitRetryAvailable(false);
    setHasTakenControl(false);
    setBusy(false);
    setTakingControl(false);
    setError(null);
    setPasteError(null);
    setGrant(null);
    setRenewalPending(false);
    setRelayUrl(null);
    relaySequence.current = 0;
    grantRef.current = null;
    exposedRef.current = null;
    resumingRef.current = false;
    resizingRef.current = false;
    setResizing(false);
    keyboardActiveRef.current = false;
    composingRef.current = false;
    bufferedInputs.current = [];
    drainingInputs.current = false;
    mouseRef.current = null;
    touchRef.current = null;
  }, [sessionId, noteStorageKey]);

  const post = useCallback(
    async (
      body: Record<string, unknown>,
      keepalive = false,
      signal?: AbortSignal,
    ) => {
      if (!endpoint) throw new Error("Browser session expired");
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
        keepalive,
        signal,
      });
      const data = await response.json().catch(() => null);
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new BrowserRequestError("Browser unavailable", response.status);
      if (!response.ok)
        throw new BrowserRequestError(
          data.state ?? data.error ?? "Browser unavailable",
          response.status,
        );
      return data;
    },
    [endpoint],
  );

  useEffect(() => {
    if (!showPreview || !endpoint || !activeSessionId || (grant && relayUrl))
      return;
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
  }, [showPreview, endpoint, activeSessionId, grant, relayUrl]);

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
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    let inFlight = false;
    let failures = 0;
    let confirmedUntil = Date.now() + 20_000;
    const current = () =>
      !stopped &&
      !resumingRef.current &&
      mountedRef.current &&
      sessionIdRef.current === sessionId &&
      grantRef.current === grant;
    const renew = async () => {
      if (!current() || inFlight) return;
      clearTimeout(timer);
      inFlight = true;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 8_000);
      const startedAt = Date.now();
      try {
        const data = await post(
          { action: "heartbeat", grant },
          false,
          controller.signal,
        );
        if (!current()) return;
        const remaining = Number.isFinite(data.leaseValidForMs)
          ? Math.max(
              0,
              Math.min(25_000, data.leaseValidForMs) - (Date.now() - startedAt),
            )
          : 20_000 - (Date.now() - startedAt);
        if (remaining <= 0) throw new Error("Renewal arrived after its lease");
        confirmedUntil = Date.now() + remaining;
        failures = 0;
        setRenewalPending(false);
        setError((previous) =>
          previous === "Reconnecting browser control. Input is paused."
            ? null
            : previous,
        );
        timer = setTimeout(
          renew,
          Math.max(250, Math.min(8_000, remaining / 3)),
        );
      } catch (cause) {
        if (!current()) return;
        const status = cause instanceof BrowserRequestError ? cause.status : 0;
        const rejected =
          status >= 400 && status < 500 && status !== 408 && status !== 429;
        // A temporary transport failure is not proof that ownership expired.
        // Pause input while retrying, but never renew concurrently or forever.
        if (!rejected && ++failures < 3 && Date.now() < confirmedUntil) {
          setRenewalPending(true);
          setError("Reconnecting browser control. Input is paused.");
          timer = setTimeout(
            renew,
            Math.min(1_000, confirmedUntil - Date.now()),
          );
          return;
        }
        grantRef.current = null;
        setGrant(null);
        setRenewalPending(false);
        setPreviewState("recovery");
        setError(
          rejected
            ? "Control expired. Reconnect or choose Exit takeover to continue."
            : "Browser connection lost. Reconnect or choose Exit takeover to continue.",
        );
        // Relinquish only this grant, keeping the Agent paused. This avoids a
        // fresh 30-second wait when the database renewed but its relay failed.
        if (!rejected)
          void post({ action: "release", grant }, true).catch(() => undefined);
      } finally {
        clearTimeout(timeout);
        inFlight = false;
      }
    };
    const wake = () => {
      if (!document.hidden) void renew();
    };
    // Renew promptly after acquisition and after returning from a throttled tab.
    timer = setTimeout(renew, 1_000);
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
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
    renewalPending ||
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
  // Tool history does not change this live, owner-scoped browser session.
  const canTake =
    !frameStale &&
    !human &&
    (effectiveState === "agent" ||
      effectiveState === "waiting" ||
      effectiveState === "recovery");
  const canResume =
    (!!session && !frameStale && (human || effectiveState === "recovery")) ||
    (!session && hasTakenControl) ||
    (effectiveState === "agent" && exitRetryAvailable);

  useLayoutEffect(() => {
    if (grant && fullScreen) inputRef.current?.focus({ preventScroll: true });
  }, [grant, fullScreen]);

  const takeControl = useCallback(async () => {
    if (!canTake || !frame || busy) return;
    if (!liveSelection) onJumpToLive?.();
    setTakingControl(true);
    setFullScreen(true);
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
      setRenewalPending(false);
      setRelayUrl(data.relayUrl ?? null);
      relaySequence.current = 0;
      setFullScreen(true);
      setFrame(data.frame);
      setFrameSeenAt(Date.now());
      setPreviewState("ready");
      setExitOpen(false);
      if (!hasTakenControl) {
        exitRequestId.current = null;
        setExitRetryAvailable(false);
      }
      setHasTakenControl(true);
    } catch (cause) {
      if (!mountedRef.current || sessionIdRef.current !== sessionId) return;
      if (!hasTakenControl) setFullScreen(false);
      setError(
        cause instanceof Error ? cause.message : "Could not take control",
      );
    } finally {
      if (mountedRef.current && sessionIdRef.current === sessionId) {
        setBusy(false);
        setTakingControl(false);
      }
    }
  }, [
    canTake,
    frame,
    busy,
    liveSelection,
    onJumpToLive,
    post,
    sessionId,
    hasTakenControl,
  ]);

  const consumedTakeoverRequest = useRef<string | null>(null);
  useEffect(() => {
    if (
      !takeoverRequest ||
      consumedTakeoverRequest.current === takeoverRequest.requestId
    )
      return;
    if (session === undefined) return;
    if (
      takeoverRequest.sessionId !== activeSessionId ||
      human ||
      (effectiveState !== "waiting" && effectiveState !== "recovery")
    ) {
      consumedTakeoverRequest.current = takeoverRequest.requestId;
      onTakeoverRequestConsumed?.(takeoverRequest.requestId);
      return;
    }
    if (!canTake || busy) return;
    // A fresh frame and the same waiting session must still match the click.
    // Consume before posting: a failed request needs another explicit click.
    consumedTakeoverRequest.current = takeoverRequest.requestId;
    onTakeoverRequestConsumed?.(takeoverRequest.requestId);
    void takeControl();
  }, [
    takeoverRequest,
    onTakeoverRequestConsumed,
    session,
    activeSessionId,
    human,
    effectiveState,
    canTake,
    busy,
    takeControl,
  ]);

  const resumeAgent = async () => {
    if (!canResume || resumingRef.current) return;
    releaseMouseRef.current?.();
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
      setExitRetryAvailable(true);
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
      setExitRetryAvailable(false);
      setError(null);
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
    if (
      !activeGrant ||
      (frameStale && input.kind !== "up") ||
      resumingRef.current
    )
      return;
    if (resizingRef.current && ["move", "down", "wheel"].includes(input.kind))
      return;
    // Hover is advisory. Held movement must survive a slow request, or a drag
    // becomes a press/release without any displacement. Coalesce only adjacent
    // movement, never across a press, release, wheel event or keystroke.
    if (input.kind === "move" && !input.buttons && drainingInputs.current)
      return;
    const buffer = bufferedInputs.current;
    const previous = buffer.at(-1);
    if (
      input.kind === "move" &&
      previous?.kind === "move" &&
      previous.buttons === input.buttons
    )
      buffer[buffer.length - 1] = input;
    else buffer.push(input);
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

  const releaseMouse = () => {
    const mouse = mouseRef.current;
    mouseRef.current = null;
    if (!mouse) return;
    // Flush the final position before release, even if the last pointermove
    // was throttled or a request was still in flight.
    if (mouse.moved)
      sendInput({ kind: "move", x: mouse.x, y: mouse.y, buttons: 1 });
    sendInput({ kind: "up", x: mouse.x, y: mouse.y });
  };
  useLayoutEffect(() => {
    releaseMouseRef.current = releaseMouse;
  });
  useEffect(() => {
    const release = () => releaseMouseRef.current?.();
    const visibility = () => {
      if (document.hidden) release();
    };
    window.addEventListener("blur", release);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("blur", release);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  useLayoutEffect(() => {
    if (frameStale || !human || exitOpen || resizing)
      releaseMouseRef.current?.();
  }, [frameStale, human, exitOpen, resizing]);

  // Layout follows the visible area, including keyboard occlusion and rotation.
  useEffect(() => {
    if (!fullScreen && !exitOpen) return;
    setTouchDevice(
      window.matchMedia?.("(any-pointer: coarse)").matches ?? false,
    );
    const measure = () => {
      const viewport = window.visualViewport;
      setVisibleViewport({
        width: Math.round(viewport?.width ?? window.innerWidth),
        height: Math.round(viewport?.height ?? window.innerHeight),
        top: viewport?.offsetTop ?? 0,
        left: viewport?.offsetLeft ?? 0,
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("scroll", measure);
    return () => {
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("scroll", measure);
    };
  }, [fullScreen, exitOpen]);

  // Keep this viewport on resume: the Agent must inspect the layout the user
  // just edited, taking a fresh snapshot instead of reusing old coordinates.
  const viewportWidth = visibleViewport?.width;
  const viewportHeight = visibleViewport?.height;
  useEffect(() => {
    if (!fullScreen || !grant || !viewportWidth || !viewportHeight) return;
    const width = Math.max(240, Math.min(2560, viewportWidth));
    const height = Math.max(240, Math.min(2560, viewportHeight));
    let cancelled = false;
    resizingRef.current = true;
    setResizing(true);
    // Coalesce keyboard animation and rotation. Serialize with input so no click
    // can use coordinates from a frame captured before the resize.
    const timer = setTimeout(() => {
      inputQueue.current = inputQueue.current
        .catch(() => undefined)
        .then(async () => {
          if (cancelled || grantRef.current !== grant || resumingRef.current)
            return;
          try {
            const data = await post({
              action: "viewport",
              grant,
              width,
              height,
            });
            if (cancelled || grantRef.current !== grant) return;
            if (!data.frame) throw new Error("Browser resize unavailable");
            setFrame(data.frame);
            setFrameSeenAt(Date.now());
            setPreviewState("ready");
          } catch {
            if (cancelled || grantRef.current !== grant) return;
            grantRef.current = null;
            setGrant(null);
            setPreviewState("recovery");
            setError(
              "Browser resize disconnected. Reconnect before continuing.",
            );
          } finally {
            if (!cancelled) {
              resizingRef.current = false;
              setResizing(false);
            }
          }
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    fullScreen,
    grant,
    visibleViewport?.width,
    visibleViewport?.height,
    post,
  ]);

  const sendText = (text: string) => {
    const chars = [...text.replace(/\r\n?/g, "\n")];
    for (let i = 0; i < chars.length; i += 31)
      sendInput({ kind: "text", text: chars.slice(i, i + 31).join("") });
  };

  const commitKeyboard = (element: HTMLTextAreaElement, inputType?: string) => {
    const text = element.value;
    // Reset after commit, never while the IME is still composing.
    element.value = "";
    if (inputType === "deleteContentBackward")
      sendInput({
        kind: "key",
        key: "Backspace",
        code: "Backspace",
        modifiers: 0,
      });
    else if (inputType === "deleteContentForward")
      sendInput({ kind: "key", key: "Delete", code: "Delete", modifiers: 0 });
    else if (inputType === "insertLineBreak" || inputType === "insertParagraph")
      sendInput({ kind: "key", key: "Enter", code: "Enter", modifiers: 0 });
    else if (text) sendText(text);
  };

  useLayoutEffect(() => {
    keyboardBeforeInputRef.current = (event, element) => {
      // Empty editable elements may emit beforeinput but no input on deletion.
      // Handle those edits without inserting a sentinel into the user's text.
      if (!event.cancelable || event.isComposing || composingRef.current)
        return;
      if (
        [
          "deleteContentBackward",
          "deleteContentForward",
          "insertLineBreak",
          "insertParagraph",
        ].includes(event.inputType)
      ) {
        event.preventDefault();
        commitKeyboard(element, event.inputType);
      }
    };
  });

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

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (
      !human ||
      frameStale ||
      composingRef.current ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229 ||
      event.key === "Unidentified" ||
      event.key === "Process" ||
      event.key === "Dead"
    )
      return;
    if (event.key === "Escape") {
      event.preventDefault();
      resumeButtonRef.current?.focus();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v")
      return;
    if (
      event.target === keyboardRef.current &&
      event.key.length === 1 &&
      ((!event.metaKey && !event.ctrlKey && !event.altKey) ||
        event.getModifierState("AltGraph"))
    )
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

  if (!showPreview) return null;

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
                ? "Waiting for browser control…"
                : effectiveState === "waiting"
                  ? "Waiting for you"
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
            {human && (
              <textarea
                ref={attachKeyboard}
                aria-label="Type in remote browser"
                tabIndex={-1}
                onFocus={() => {
                  keyboardActiveRef.current = true;
                }}
                disabled={frameStale || busy}
                defaultValue=""
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="absolute left-0 top-0 h-px w-px resize-none overflow-hidden opacity-0 text-base"
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={(event) => {
                  composingRef.current = false;
                  commitKeyboard(event.currentTarget);
                }}
                onInput={(event) => {
                  const native = event.nativeEvent as InputEvent;
                  if (!composingRef.current && !native.isComposing)
                    commitKeyboard(event.currentTarget, native.inputType);
                }}
              />
            )}
            {/* Dynamic frames are authenticated data URLs from the server. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={frame.image}
              alt="Current Agent browser viewport"
              draggable={false}
              className={
                fullScreen
                  ? "block h-auto max-h-full w-auto max-w-full touch-none select-none"
                  : "block h-auto w-full touch-none select-none"
              }
              onLoad={() => {
                if (exposedRef.current === sessionId) return;
                exposedRef.current = sessionId ?? null;
                void post({ action: "exposure" }).catch(() => undefined);
              }}
              onPointerDown={(event) => {
                if (!human || frameStale || resizingRef.current) return;
                if (event.button !== 0) return;
                if (
                  (mouseRef.current &&
                    mouseRef.current.id !== event.pointerId) ||
                  (touchRef.current && touchRef.current.id !== event.pointerId)
                )
                  return;
                event.preventDefault();
                if (event.pointerType === "touch") {
                  setTouchDevice(true);
                  touchRef.current = {
                    id: event.pointerId,
                    x: event.clientX,
                    y: event.clientY,
                    moved: false,
                  };
                  event.currentTarget.setPointerCapture(event.pointerId);
                  return;
                }
                keyboardRef.current?.focus({ preventScroll: true });
                const xy = point(event);
                if (!xy) return;
                releaseMouse();
                mouseRef.current = { id: event.pointerId, ...xy, moved: false };
                event.currentTarget.setPointerCapture(event.pointerId);
                sendInput({ kind: "down", ...xy });
              }}
              onPointerUp={(event) => {
                if (!human || frameStale || resizingRef.current) return;
                if (event.button !== 0) return;
                const xy = point(event);
                const touch = touchRef.current;
                if (touch && touch.id === event.pointerId) {
                  if (!touch.moved && xy) {
                    sendInput({ kind: "down", ...xy });
                    sendInput({ kind: "up", ...xy });
                  }
                  touchRef.current = null;
                } else if (mouseRef.current?.id === event.pointerId) {
                  if (xy) {
                    const mouse = mouseRef.current;
                    mouse.moved ||= mouse.x !== xy.x || mouse.y !== xy.y;
                    Object.assign(mouse, xy);
                  }
                  releaseMouse();
                }
                if (event.currentTarget.hasPointerCapture?.(event.pointerId))
                  event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={(event) => {
                if (touchRef.current?.id === event.pointerId)
                  touchRef.current = null;
                if (mouseRef.current?.id === event.pointerId) releaseMouse();
              }}
              onLostPointerCapture={(event) => {
                if (touchRef.current?.id === event.pointerId)
                  touchRef.current = null;
                if (mouseRef.current?.id === event.pointerId) releaseMouse();
              }}
              onPointerMove={(event) => {
                const touch = touchRef.current;
                if (touch && touch.id !== event.pointerId) return;
                if (touch && touch.id === event.pointerId) {
                  const dx = touch.x - event.clientX,
                    dy = touch.y - event.clientY;
                  if (!touch.moved && Math.hypot(dx, dy) < 8) return;
                  touch.moved = true;
                  touch.x = event.clientX;
                  touch.y = event.clientY;
                  const xy = point(event);
                  if (xy)
                    sendInput({
                      kind: "wheel",
                      ...xy,
                      deltaX: Math.max(-2000, Math.min(2000, dx)),
                      deltaY: Math.max(-2000, Math.min(2000, dy)),
                    });
                  return;
                }
                const mouse = mouseRef.current;
                if (mouse && mouse.id !== event.pointerId) return;
                if (mouse && event.buttons === 0) {
                  releaseMouse();
                  return;
                }
                const xy = point(event);
                if (mouse && mouse.id === event.pointerId && xy) {
                  mouse.moved ||= mouse.x !== xy.x || mouse.y !== xy.y;
                  Object.assign(mouse, xy);
                }
                if (
                  !human ||
                  frameStale ||
                  Date.now() - lastMoveAt.current < (mouse ? 16 : 120)
                )
                  return;
                lastMoveAt.current = Date.now();
                if (xy)
                  sendInput({ kind: "move", ...xy, buttons: mouse ? 1 : 0 });
              }}
              ref={attachWheelListener}
            />
          </div>
        )}
        {resizing && human && !takingControl && (
          <div
            role="status"
            className="pointer-events-none absolute top-4 rounded-full bg-background/90 px-3 py-1 text-xs text-muted-foreground"
          >
            Adjusting browser…
          </div>
        )}
        {takingControl && (
          <div
            role="status"
            className="absolute inset-0 flex items-center justify-center bg-background/70 px-6 text-center text-sm text-foreground backdrop-blur-sm"
          >
            {effectiveState === "claiming"
              ? "Pausing Agent and connecting browser…"
              : "Requesting control…"}
          </div>
        )}
        {session && frameStale && !takingControl && (
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
        <div
          className={
            fullScreen ? "flex items-center justify-center gap-2" : "contents"
          }
        >
          {fullScreen &&
            human &&
            (touchDevice || (visibleViewport?.width ?? 1024) < 1024) && (
              <button
                type="button"
                aria-label="Show browser keyboard"
                onClick={() =>
                  keyboardRef.current?.focus({ preventScroll: true })
                }
                className="pointer-events-auto order-2 inline-flex min-h-11 items-center gap-2 rounded-full bg-background px-4 py-2 text-sm text-foreground shadow-lg border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Keyboard size={16} aria-hidden /> Keyboard
              </button>
            )}
          {takingControl ||
          human ||
          effectiveState === "recovery" ||
          hasTakenControl ? (
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
                : effectiveState === "human" && !human
                  ? "If you just reloaded, controls will recover shortly. Otherwise, continue in the window already controlling this browser. The Agent stays paused."
                  : !liveSelection
                    ? "This browser is live. Take control to pause the Agent; the tool history below is earlier."
                    : frameStale
                      ? "Take control will be available when the live browser preview connects."
                      : "Take control to click and type. The Agent’s browser actions pause until you resume."}
            </span>
          ) : null}
        </div>
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
          style={
            visibleViewport
              ? {
                  width: visibleViewport.width,
                  height: visibleViewport.height,
                  top: visibleViewport.top,
                  left: visibleViewport.left,
                }
              : undefined
          }
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
          showCloseButton={false}
          className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
          style={
            visibleViewport
              ? {
                  maxHeight: Math.max(0, visibleViewport.height - 32),
                  maxWidth: Math.min(
                    512,
                    Math.max(0, visibleViewport.width - 32),
                  ),
                  top: visibleViewport.top + visibleViewport.height / 2,
                  left: visibleViewport.left + visibleViewport.width / 2,
                }
              : undefined
          }
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            // This dialog has no Radix trigger. Restore remote keyboard input
            // on cancel, or the preview control after a successful handoff.
            const target = fullScreen
              ? human
                ? keyboardActiveRef.current
                  ? keyboardRef.current
                  : inputRef.current
                : resumeButtonRef.current
              : openButtonRef.current;
            target?.focus({ preventScroll: true });
          }}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (busy) event.preventDefault();
          }}
        >
          <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-2 sm:px-6">
            <DialogTitle className="text-xl">
              Tell HackerAI what you did
            </DialogTitle>
            <DialogClose asChild>
              <button
                type="button"
                aria-label="Close"
                disabled={busy}
                className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                <X size={18} aria-hidden />
              </button>
            </DialogClose>
          </div>
          <div className="min-h-0 overflow-y-auto px-4 pt-2 pb-4 sm:px-6 space-y-4">
            <DialogDescription>
              Add an optional note, such as “I signed in,” to help HackerAI
              continue. You can also continue without a note.
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
              disabled={busy || exitRetryAvailable}
              className="h-24 min-h-20 w-full resize-y rounded-xl border border-input bg-muted/40 p-3 text-base sm:text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            {!session && (
              <p className="text-sm text-muted-foreground">
                This run has ended. Continue will start a new Agent turn with
                your saved context.
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <div className="flex shrink-0 justify-end border-t px-4 py-3 sm:px-6">
            <button
              type="button"
              disabled={!canResume || busy}
              onClick={() => void resumeAgent()}
              className="justify-self-end rounded-xl bg-foreground px-5 py-3 font-medium text-background hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "Continuing…" : "Send and continue"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
