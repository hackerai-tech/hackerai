"use client";

import { formatDistanceToNow } from "date-fns";
import { useSyncExternalStore } from "react";

const subscribeToHydration = () => () => {};
const getHydratedSnapshot = () => true;
const getServerSnapshot = () => false;

const useClientLocale = () =>
  useSyncExternalStore(
    subscribeToHydration,
    getHydratedSnapshot,
    getServerSnapshot,
  );

const formatAbsoluteTime = (date: Date, clientLocale: boolean) =>
  new Intl.DateTimeFormat(clientLocale ? undefined : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    ...(clientLocale ? {} : { timeZone: "UTC" }),
  }).format(date);

export function FindingDiscoveredAt({ timestamp }: { timestamp: number }) {
  const clientLocale = useClientLocale();
  const date = new Date(timestamp);

  return (
    <time dateTime={date.toISOString()}>
      {formatAbsoluteTime(date, clientLocale)}
    </time>
  );
}

export function FindingRelativeTime({ timestamp }: { timestamp: number }) {
  const clientLocale = useClientLocale();
  const date = new Date(timestamp);
  const absoluteTime = formatAbsoluteTime(date, clientLocale);

  return (
    <time dateTime={date.toISOString()} title={absoluteTime}>
      {clientLocale
        ? formatDistanceToNow(date, { addSuffix: true })
        : absoluteTime}
    </time>
  );
}
