import { Centrifuge, type Subscription } from "centrifuge";
import { generateCentrifugoToken } from "./jwt";
import { sandboxConnectionChannel } from "./types";
import {
  getConnectionIdFromPresenceClient,
  presenceHasConnectionId,
} from "./presence";
import {
  DESKTOP_SESSION_CHALLENGE,
  MAX_RECONCILED_COMMANDS,
  newDesktopSessionNonce,
  parseDesktopSessionProof,
  readPublisherConnectionId,
  sameDesktopSession,
  type DesktopDispatchGate,
  type DesktopSessionIdentity,
  type PublishedDesktopCommand,
} from "./desktop-session";
import {
  LocalConnectionLostError,
  readCallbackCode,
  readClientState,
  readSocketClose,
  type LocalStopClientState,
  type LocalStopReason,
} from "@/lib/chat/local-connection-stop";

// This lease belongs to one run and one connection incarnation. A new Desktop
// session may restore availability, but must never revive the interrupted run.
const PRESENCE_INTERVAL_MS = 5_000;
const PRESENCE_TIMEOUT_MS = 10_000;
// Once the selected host is verified, an outage may recover. The window is
// fixed at its first interruption: neither SDK retries, failed lookups nor
// failed proofs extend it, and only fresh verification ends it.
const OBSERVER_RECOVERY_MS = 15_000;
// The SDK owns every reconnect and resubscribe; cap its jittered backoff so
// several attempts fit in the window.
const MAX_RETRY_DELAY_MS = 3_000;
// Only after a proven Desktop baseline: look up and challenge again quickly.
const SESSION_RECOVERY_CHECK_MS = 1_000;
const SESSION_PROOF_TIMEOUT_MS = 3_000;
const MAX_BASELINE_ATTEMPTS = 3;

function readClock(read: () => number): number | undefined {
  try {
    const now = read();
    return Number.isFinite(now) ? now : undefined;
  } catch {
    return undefined;
  }
}

/** Optional diagnostic clock; a fault must never become or block a stop. */
const monotonicNow = () => readClock(() => performance.now());
/** Also advances while suspended, when the monotonic clock may not. */
const wallNow = () => readClock(() => Date.now());

/** The runtime's WebSocket; when unreadable the SDK keeps its default path. */
function nativeWebSocket(): typeof WebSocket | undefined {
  try {
    const native = globalThis.WebSocket;
    return typeof native === "function" ? native : undefined;
  } catch {
    return undefined;
  }
}

type SocketWatch = {
  socket: WebSocket;
  listener: (event: Event) => void;
  /** Set once it carries the subscription; a setup close is not the run's. */
  armed: boolean;
};

type SocketClose = ReturnType<typeof readSocketClose>;

type Recovery = {
  timer: ReturnType<typeof setTimeout>;
  wallDeadline?: number;
  monotonicDeadline?: number;
  /** The interrupting close, kept past the SDK's own new sockets. */
  close: SocketClose;
  /** The selected host itself was seen leaving, not just this observer. */
  hostDeparted: boolean;
};

type Challenge = {
  nonce: string;
  /** The interruption epoch it was issued in; a later one supersedes it. */
  epoch: number;
  /** Commands published before it was issued; empty for the baseline. */
  commands: readonly PublishedDesktopCommand[];
  timer: ReturnType<typeof setTimeout>;
};

export type LocalRunConnectionWatch = DesktopDispatchGate & {
  /** Normal completion, or the owner's own stop with its cause. Idempotent. */
  stop(cause?: Error): void;
  /**
   * Settles only after a verification that starts now: a fresh presence
   * lookup, plus a fresh session proof once a Desktop baseline exists. A
   * cached ready state never satisfies it. Shares the fixed recovery window;
   * rejects with the loss, a monitoring stop, or the signal's reason.
   */
  confirmReady(signal?: AbortSignal): Promise<void>;
};

/** Desktop hosts only: the run's published commands, read when reconciling. */
export type DesktopSessionReconciliation = {
  publishedCommands(): readonly PublishedDesktopCommand[];
};

export function watchLocalRunConnection({
  userId,
  connectionId,
  onLost,
  desktopSession,
}: {
  userId: string;
  connectionId: string;
  onLost: (error: LocalConnectionLostError) => void;
  /**
   * Omitted for CLI hosts: they never answer a session challenge, so any
   * departure of the selected host stops the run as before.
   */
  desktopSession?: DesktopSessionReconciliation;
}): LocalRunConnectionWatch {
  let stopped = false;
  let client: Centrifuge | undefined;
  let subscription: Subscription | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let recovery: Recovery | undefined;
  // Bumped by every subscription change and lookup: only the current lookup
  // of the current subscription may report, and its timers die with it.
  let generation = 0;
  // Bumped only by interruptions: a session proof answers one epoch.
  let epoch = 0;
  let subscribed = false;
  let everSubscribed = false;
  let hadPositivePresence = false;
  let lastPositivePresenceAt: number | undefined;
  let clientStateAtStop: LocalStopClientState | undefined;
  // Readiness is live state: any interruption clears it before its handler
  // returns, so a dispatch can never pass on an earlier verification.
  let ready = false;
  let terminal: unknown;
  const waiters = new Set<{
    resolve: () => void;
    reject: (error: unknown) => void;
  }>();
  // Host grace exists only once the native session proved its identity while
  // positively present; without it, a departure stops the run.
  let baseline: DesktopSessionIdentity | undefined;
  let baselineAttempts = 0;
  let baselineUnsupported = false;
  let challenge: Challenge | undefined;
  // Only the current socket attempt's own close listener, and its pair if the
  // native close preceded the first stop. Never the reason, URL or frames.
  let socketWatch: SocketWatch | undefined;
  let socketClose: SocketClose;
  const unwatchSocket = () => {
    const owned = socketWatch;
    socketWatch = undefined;
    try {
      owned?.socket.removeEventListener("close", owned.listener);
    } catch {
      // A listener left attached is no longer current, so it records nothing.
    }
  };
  const watchSocket = (socket: WebSocket) => {
    if (stopped) return;
    const owned: SocketWatch = {
      socket,
      armed: false,
      listener: (event) => {
        if (stopped || socketWatch !== owned || !owned.armed) return;
        const close = readSocketClose(event);
        if (!stopped && socketWatch === owned) socketClose = close;
      },
    };
    try {
      socket.addEventListener("close", owned.listener, { once: true });
      socketWatch = owned;
    } catch {
      // Without its EventTarget API the socket is simply not observed.
    }
  };
  const markReady = () => {
    ready = true;
    for (const waiter of [...waiters]) waiter.resolve();
  };
  const clearChallenge = () => {
    clearTimeout(challenge?.timer);
    challenge = undefined;
  };
  const dispose = () => {
    if (stopped) return false;
    stopped = true;
    ready = false;
    unwatchSocket();
    clearTimeout(timer);
    clearTimeout(deadline);
    clearTimeout(recovery?.timer);
    clearChallenge();
    subscription?.removeAllListeners();
    client?.removeAllListeners();
    // Before our own disconnect, which would always report "disconnected".
    clientStateAtStop = readClientState(client);
    client?.disconnect();
    return true;
  };
  const rejectWaiters = (error: unknown) => {
    terminal = error;
    for (const waiter of [...waiters]) waiter.reject(error);
  };
  const stop = (cause?: Error) => {
    if (!dispose()) return;
    rejectWaiters(
      cause ?? new Error("Local run connection monitoring has stopped."),
    );
  };
  // The first cause wins; dispose() makes every later trigger a no-op.
  const lost = (
    reason: LocalStopReason,
    observed?: { context?: unknown; close: SocketClose },
  ) => {
    if (!dispose()) return;
    const now = monotonicNow();
    const error = new LocalConnectionLostError(reason, {
      connectionId,
      hadPositivePresence,
      lastPositivePresenceAgeMs:
        now === undefined || lastPositivePresenceAt === undefined
          ? undefined
          : now - lastPositivePresenceAt,
      // Only the observer's own state; never a callback reason or channel.
      ...(observed && {
        callbackCode: readCallbackCode(observed.context),
        clientState: clientStateAtStop,
        ...observed.close,
      }),
    });
    rejectWaiters(error);
    onLost(error);
  };
  const callbackLost = (reason: LocalStopReason, context: unknown) =>
    lost(reason, { context, close: socketClose });
  const expire = () => {
    if (recovery)
      lost(
        recovery.hostDeparted
          ? "selected_host_recovery_expired"
          : "observer_recovery_expired",
        { close: recovery.close },
      );
  };
  // Either clock passing the deadline ends it, even if its timer is late.
  const recoveryExpired = ({ wallDeadline, monotonicDeadline }: Recovery) => {
    const wall = wallNow();
    const monotonic = monotonicNow();
    return (
      (wallDeadline !== undefined &&
        wall !== undefined &&
        wall >= wallDeadline) ||
      (monotonicDeadline !== undefined &&
        monotonic !== undefined &&
        monotonic >= monotonicDeadline)
    );
  };
  const scheduleCheck = (delay: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => void check(), delay);
  };
  // Invalidates the current lookup, proof and readiness. Only the first
  // interruption of an outage starts its window.
  const interrupt = () => {
    generation++;
    epoch++;
    ready = false;
    clearTimeout(deadline);
    clearChallenge();
    if (!recovery) {
      const wall = wallNow();
      const monotonic = monotonicNow();
      recovery = {
        timer: setTimeout(expire, OBSERVER_RECOVERY_MS),
        wallDeadline:
          wall === undefined ? undefined : wall + OBSERVER_RECOVERY_MS,
        monotonicDeadline:
          monotonic === undefined
            ? undefined
            : monotonic + OBSERVER_RECOVERY_MS,
        close: socketClose,
        hostDeparted: false,
      };
    }
    clearTimeout(timer);
    // A subscription that is still current is looked up again.
    if (subscribed)
      scheduleCheck(
        baseline ? SESSION_RECOVERY_CHECK_MS : PRESENCE_INTERVAL_MS,
      );
  };
  // Before verification any observer failure still stops the run.
  const unconfirmed = (reason: LocalStopReason) => {
    if (hadPositivePresence) interrupt();
    else lost(reason);
  };
  // A socket or presence return is never proof of the same native session:
  // only a proven baseline lets the host itself return within the window.
  const hostDeparted = (
    reason: "selected_host_left" | "selected_presence_absent",
  ) => {
    if (!baseline) {
      lost(reason);
      return;
    }
    interrupt();
    recovery!.hostDeparted = true;
  };
  const challengeSession = () => {
    if (stopped || challenge || !subscription || !desktopSession) return;
    let commands: readonly PublishedDesktopCommand[] = [];
    if (baseline) {
      try {
        commands = [...desktopSession.publishedCommands()];
      } catch {
        lost("desktop_command_unreconciled");
        return;
      }
      if (commands.length > MAX_RECONCILED_COMMANDS) {
        lost("desktop_command_unreconciled");
        return;
      }
    } else {
      baselineAttempts++;
    }
    const issued: Challenge = {
      nonce: newDesktopSessionNonce(),
      epoch,
      commands,
      // An unanswered challenge only frees the slot; the next lookup retries
      // within the same fixed window.
      timer: setTimeout(() => {
        if (challenge === issued) challenge = undefined;
      }, SESSION_PROOF_TIMEOUT_MS),
    };
    challenge = issued;
    subscription
      .publish({
        type: DESKTOP_SESSION_CHALLENGE,
        nonce: issued.nonce,
        targetConnectionId: connectionId,
        commandIds: commands.map((command) => command.commandId),
      })
      .catch(() => {
        if (challenge === issued) clearChallenge();
      });
  };
  const acceptProof = (data: unknown, info: unknown) => {
    const answered = challenge;
    if (stopped || !answered || answered.epoch !== epoch) return;
    const proof = parseDesktopSessionProof(data);
    if (
      !proof ||
      proof.nonce !== answered.nonce ||
      proof.connectionId !== connectionId ||
      // Only the relay's own record of the publisher, from its signed
      // connection token, is authority; a payload field never is.
      readPublisherConnectionId(info) !== connectionId
    )
      return;
    clearChallenge();
    if (!baseline) {
      if (recovery) return;
      if (proof.unavailable) baselineUnsupported = true;
      else
        baseline = Object.freeze({
          launchId: proof.launchId,
          pageGeneration: proof.pageGeneration,
        });
      return;
    }
    if (!recovery) return;
    if (recoveryExpired(recovery)) {
      expire();
      return;
    }
    if (proof.unavailable) {
      lost("desktop_session_unverified");
      return;
    }
    if (!sameDesktopSession(proof, baseline)) {
      lost("desktop_session_replaced");
      return;
    }
    // Every command published before the challenge must still have its
    // output owned by this session, or have already delivered all of it.
    // Execution is never requested again.
    const retained = new Set(proof.retainedCommandIds);
    let current: readonly PublishedDesktopCommand[];
    try {
      current = [...desktopSession!.publishedCommands()];
    } catch {
      lost("desktop_command_unreconciled");
      return;
    }
    const named = new Set(answered.commands.map((each) => each.commandId));
    for (const command of current) {
      let complete = false;
      try {
        complete = command.outputComplete();
      } catch {
        complete = false;
      }
      if (complete) continue;
      if (!named.has(command.commandId) || !retained.has(command.commandId)) {
        lost("desktop_command_unreconciled");
        return;
      }
    }
    clearTimeout(recovery.timer);
    recovery = undefined;
    hadPositivePresence = true;
    lastPositivePresenceAt = monotonicNow();
    // The host's subscription may have changed while this receiver's did
    // not: request replay explicitly rather than wait for a gap.
    for (const command of current) {
      if (!retained.has(command.commandId)) continue;
      try {
        command.resumeOutput();
      } catch {
        // The command's own deadline still bounds a failed request.
      }
    }
    // Supersede any lookup in flight; monitoring resumes at its cadence.
    generation++;
    clearTimeout(deadline);
    scheduleCheck(PRESENCE_INTERVAL_MS);
    markReady();
  };
  const check = async () => {
    if (stopped || !subscribed) return;
    const current = ++generation;
    clearTimeout(timer);
    clearTimeout(deadline);
    deadline = setTimeout(() => {
      if (current === generation) unconfirmed("presence_timeout");
    }, PRESENCE_TIMEOUT_MS);
    let presence: Awaited<ReturnType<Subscription["presence"]>>;
    try {
      presence = await subscription!.presence();
    } catch {
      if (!stopped && current === generation) unconfirmed("presence_error");
      return;
    }
    if (stopped || current !== generation) return;
    clearTimeout(deadline);
    if (!presenceHasConnectionId(presence, connectionId)) {
      hostDeparted("selected_presence_absent");
      return;
    }
    if (recovery && recoveryExpired(recovery)) {
      expire();
      return;
    }
    if (recovery && baseline) {
      // Present again, but unproven: readiness waits for the session proof.
      challengeSession();
      scheduleCheck(SESSION_RECOVERY_CHECK_MS);
      return;
    }
    if (recovery) {
      clearTimeout(recovery.timer);
      recovery = undefined;
    }
    hadPositivePresence = true;
    // Unavailable now: omit the age rather than report a stale timestamp.
    lastPositivePresenceAt = monotonicNow();
    markReady();
    if (
      desktopSession &&
      !baseline &&
      !baselineUnsupported &&
      baselineAttempts < MAX_BASELINE_ATTEMPTS
    )
      challengeSession();
    scheduleCheck(PRESENCE_INTERVAL_MS);
  };
  // The SDK's own reconnect or resubscribe: during setup its retries are
  // bounded by the setup deadline, and before verification they still stop.
  const reconnecting = (reason: LocalStopReason, context: unknown) => {
    subscribed = false;
    if (hadPositivePresence) interrupt();
    else if (everSubscribed) callbackLost(reason, context);
  };

  const waitUntilReady = (signal?: AbortSignal): Promise<void> => {
    if (terminal !== undefined) return Promise.reject(terminal);
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (ready) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => settle(() => reject(signal!.reason));
      const settle = (finish: () => void) => {
        waiters.delete(waiter);
        signal?.removeEventListener("abort", onAbort);
        finish();
      };
      const waiter = {
        resolve: () => settle(resolve),
        reject: (error: unknown) => settle(() => reject(error)),
      };
      waiters.add(waiter);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  // Also bound initial token/subscription setup and a relay that goes silent.
  deadline = setTimeout(() => lost("setup_timeout"), PRESENCE_TIMEOUT_MS);
  void (async () => {
    const token = await generateCentrifugoToken(userId, 3600);
    if (stopped) return;
    const wsUrl = process.env.CENTRIFUGO_WS_URL;
    if (!wsUrl) throw new Error("Missing relay configuration");
    const NativeWebSocket = nativeWebSocket();
    client = new Centrifuge(wsUrl, {
      token,
      getToken: () => generateCentrifugoToken(userId, 3600),
      maxReconnectDelay: MAX_RETRY_DELAY_MS,
      // The SDK's public constructor option: the same native socket, built
      // with the SDK's exact arguments, plus one listener of our own. A
      // construction failure reaches the SDK unchanged.
      ...(NativeWebSocket && {
        websocket: function (...args: ConstructorParameters<typeof WebSocket>) {
          unwatchSocket();
          socketClose = undefined;
          const socket = new NativeWebSocket(...args);
          watchSocket(socket);
          return socket;
        },
      }),
    });
    subscription = client.newSubscription(
      sandboxConnectionChannel(userId, connectionId),
      { joinLeave: true, maxResubscribeDelay: MAX_RETRY_DELAY_MS },
    );
    subscription.on("subscribed", () => {
      if (stopped) return;
      subscribed = true;
      everSubscribed = true;
      if (socketWatch) socketWatch.armed = true;
      void check();
    });
    subscription.on("leave", (event) => {
      if (getConnectionIdFromPresenceClient(event.info) === connectionId)
        hostDeparted("selected_host_left");
    });
    if (desktopSession) {
      subscription.on("join", (event) => {
        if (
          recovery &&
          baseline &&
          subscribed &&
          getConnectionIdFromPresenceClient(event.info) === connectionId
        )
          void check();
      });
      subscription.on("publication", (context) =>
        acceptProof(context.data, context.info),
      );
    }
    subscription.on("subscribing", (context) =>
      reconnecting("subscription_reconnecting", context),
    );
    subscription.on("unsubscribed", (context) =>
      callbackLost("subscription_unsubscribed", context),
    );
    // A failed resubscribe the SDK retries; a permanent one unsubscribes.
    subscription.on("error", () => unconfirmed("subscription_error"));
    client.on("disconnected", (context) =>
      callbackLost("observer_disconnected", context),
    );
    client.on("connecting", (context) =>
      reconnecting("observer_reconnecting", context),
    );
    subscription.subscribe();
    client.connect();
  })().catch(() => lost("setup_error"));
  return {
    stop,
    isReady: () => ready,
    waitUntilReady,
    confirmReady: (signal?: AbortSignal) => {
      if (terminal !== undefined) return Promise.reject(terminal);
      if (signal?.aborted) return Promise.reject(signal.reason);
      // Already unverified: the next readiness is itself a fresh one.
      if (ready) {
        // With a proven session, require a new proof inside the same fixed
        // window as any interruption; a departure meanwhile keeps it. Without
        // one, a fresh lookup only, never host grace.
        if (baseline) interrupt();
        else {
          ready = false;
          clearTimeout(timer);
        }
        void check();
      }
      return waitUntilReady(signal);
    },
    // Only a Desktop host can recover; a forgotten uncertain execution must
    // never let it, or later dispatch, proceed.
    ...(desktopSession && {
      failUncertainExecution: () => lost("desktop_command_unreconciled"),
    }),
  };
}
