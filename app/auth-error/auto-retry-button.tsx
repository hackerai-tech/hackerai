"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

const STORAGE_KEY = "auth_retry_state";
const BASE_DELAY = 5;
const MAX_DELAY = 600;
const EXPIRY_HOURS = 4;

interface RetryState {
  count: number;
  expiresAt: number;
}

function getRetryState(): RetryState {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return { count: 0, expiresAt: 0 };

    const state: RetryState = JSON.parse(stored);
    if (Date.now() > state.expiresAt) {
      localStorage.removeItem(STORAGE_KEY);
      return { count: 0, expiresAt: 0 };
    }
    return state;
  } catch {
    return { count: 0, expiresAt: 0 };
  }
}

function setRetryState(count: number): void {
  try {
    const state: RetryState = {
      count,
      expiresAt: Date.now() + EXPIRY_HOURS * 60 * 60 * 1000,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable (private mode, quota exceeded, etc.)
    // Backoff won't persist but retry flow continues normally
  }
}

function calculateDelay(retryCount: number): number {
  // Exponential backoff: 5, 10, 20, 40, 80, 160, 320, 600 (capped)
  const delay = BASE_DELAY * Math.pow(2, retryCount);
  return Math.min(delay, MAX_DELAY);
}

interface AutoRetryButtonProps {
  loginUrl: string;
}

export function AutoRetryButton({ loginUrl }: AutoRetryButtonProps) {
  const [countdown, setCountdown] = useState<number | null>(null);
  const [cancelled, setCancelled] = useState(false);

  // Initialize countdown from localStorage on mount (intentional one-time sync from external store)
  useEffect(() => {
    const { count } = getRetryState();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCountdown(calculateDelay(count));
  }, []);

  useEffect(() => {
    if (cancelled) return;

    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev === null || prev <= 0) return prev;
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [cancelled]);

  useEffect(() => {
    if (countdown === 0 && !cancelled) {
      const { count } = getRetryState();
      setRetryState(count + 1);
      window.location.href = loginUrl;
    }
  }, [countdown, cancelled, loginUrl]);

  if (cancelled) {
    return (
      <Button asChild className="flex-1 min-w-0">
        <a href={loginUrl}>
          <RefreshCw className="h-4 w-4" />
          Try Again
        </a>
      </Button>
    );
  }

  if (countdown === null) {
    return (
      <Button className="flex-1 min-w-0" disabled>
        <RefreshCw className="h-4 w-4 animate-spin" />
        Retrying...
      </Button>
    );
  }

  return (
    <Button className="flex-1 min-w-0" onClick={() => setCancelled(true)}>
      <RefreshCw className="h-4 w-4 animate-spin" />
      Retrying in {countdown}s...
    </Button>
  );
}
