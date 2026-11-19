"use client";

import { useSyncExternalStore } from "react";
import { isMacPlatform } from "@/lib/keyboard-shortcuts";

const subscribe = () => () => {};
const getServerSnapshot = () => false;

export function useShortcutPlatform(): boolean {
  return useSyncExternalStore(subscribe, isMacPlatform, getServerSnapshot);
}
