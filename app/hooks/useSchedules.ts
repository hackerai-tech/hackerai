"use client";
import useSWR from "swr";
import type { SchedulesResponse } from "@/lib/schedules/types";

export async function schedulesRequest(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.message ?? "Could not update schedules. Try again.");
  return data;
}
export function useSchedules() {
  const { data, error, isLoading, mutate } = useSWR<SchedulesResponse>(
    "/api/schedules",
    schedulesRequest,
    {
      refreshInterval: 10000,
      refreshWhenHidden: false,
      revalidateOnFocus: true,
    },
  );
  return {
    data,
    error,
    isLoading,
    reload: () => mutate(),
    perform: async (method: string, body?: unknown, id?: string) => {
      const result = await schedulesRequest(
        `/api/schedules${id ? `?id=${encodeURIComponent(id)}` : ""}`,
        { method, ...(body ? { body: JSON.stringify(body) } : {}) },
      );
      await mutate();
      return result;
    },
  };
}
