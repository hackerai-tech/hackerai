"use client";

import { useSyncExternalStore } from "react";
import { hasAuthenticatedBefore } from "@/lib/utils/client-storage";

const subscribeToAuthHint = () => () => {};
const getServerAuthHint = () => false;

export function useHasAuthenticatedBefore(): boolean {
  return useSyncExternalStore(
    subscribeToAuthHint,
    hasAuthenticatedBefore,
    getServerAuthHint,
  );
}
