"use client";

import { useCallback, useEffect, useState } from "react";
import type { QueueBehavior } from "@/types/chat";

type LegacyQueueBehavior = Exclude<QueueBehavior, "steer">;

// The legacy key was written on every load, so it cannot tell an explicit
// "queue" choice from the old default. Explicit choices use the new key.
const LEGACY_KEY = "queue-behavior";
const FOLLOW_UP_KEY = "follow-up-behavior";

const read = (key: string) => {
  try {
    return typeof window === "undefined" ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
};

const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage is a convenience; the in-memory choice still applies.
  }
};

/**
 * What Enter does while an Agent run is working. With mid-run steering
 * available, the default is to steer; an explicit choice always wins, and an
 * existing "Stop & send" choice is kept.
 */
export function useFollowUpBehavior(userId: string | undefined) {
  const [legacy, setLegacy] = useState<LegacyQueueBehavior>(() =>
    read(LEGACY_KEY) === "stop-and-send" ? "stop-and-send" : "queue",
  );
  const [explicit, setExplicit] = useState<QueueBehavior | null>(() => {
    const saved = read(FOLLOW_UP_KEY);
    return saved === "steer" || saved === "queue" || saved === "stop-and-send"
      ? saved
      : null;
  });
  const [availability, setAvailability] = useState<{
    userId: string;
    enabled: boolean;
  } | null>(null);
  const agentSteeringEnabled =
    !!userId && availability?.userId === userId && availability.enabled;

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    fetch("/api/experiments/agent-steering", {
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (response) =>
        response.ok
          ? ((await response.json()) as { enabled?: unknown }).enabled === true
          : false,
      )
      .catch(() => false)
      .then((enabled) => {
        if (!cancelled) setAvailability({ userId, enabled });
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const queueBehavior: QueueBehavior = agentSteeringEnabled
    ? (explicit ?? (legacy === "stop-and-send" ? "stop-and-send" : "steer"))
    : legacy;

  const setQueueBehavior = useCallback(
    (behavior: QueueBehavior) => {
      // Every explicit choice is newer than one saved during another rollout
      // state; only steer itself needs steering to be available.
      if (agentSteeringEnabled || behavior !== "steer") {
        setExplicit(behavior);
        write(FOLLOW_UP_KEY, behavior);
      }
      if (behavior !== "steer") {
        setLegacy(behavior);
        write(LEGACY_KEY, behavior);
      }
    },
    [agentSteeringEnabled],
  );

  return { queueBehavior, setQueueBehavior, agentSteeringEnabled };
}
