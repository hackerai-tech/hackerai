"use client";

import { useState, useMemo } from "react";
import { usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { RefreshCw, Download, ChevronDown } from "lucide-react";
import { TokenBreakdownTooltip } from "@/app/components/usage/TokenBreakdownTooltip";
import type { DateRange } from "react-day-picker";

type Preset = "1d" | "7d" | "30d" | "custom";

const PRESET_OPTIONS: { value: Exclude<Preset, "custom">; label: string }[] = [
  { value: "1d", label: "1d" },
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
];

const INITIAL_NUM_ITEMS = 100;

const daysAgo = (n: number): Date => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(0, 0, 0, 0);
  return d;
};

const startOfDay = (d: Date): Date => {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

const endOfDay = (d: Date): Date => {
  const copy = new Date(d);
  copy.setHours(23, 59, 59, 999);
  return copy;
};

const fmtShort = (d: Date): string =>
  d.toLocaleDateString("en-US", { month: "short", day: "numeric" });

const formatCost = (dollars: number): string => {
  if (dollars === 0) return "$0.00";
  if (dollars < 0.01) return `$${dollars.toFixed(4)}`;
  return `$${dollars.toFixed(2)}`;
};

const formatTimestamp = (ms: number): string => {
  const date = new Date(ms);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

const UsageLogsTable = () => {
  const [preset, setPreset] = useState<Preset>("30d");
  const [customRange, setCustomRange] = useState<DateRange | undefined>();
  const [calendarOpen, setCalendarOpen] = useState(false);

  const { start, end } = useMemo(() => {
    if (preset === "custom" && customRange?.from) {
      return {
        start: startOfDay(customRange.from),
        end: customRange.to
          ? endOfDay(customRange.to)
          : endOfDay(customRange.from),
      };
    }
    const days = preset === "1d" ? 1 : preset === "7d" ? 7 : 30;
    return { start: daysAgo(days), end: new Date() };
  }, [preset, customRange]);

  const dateLabel = `${fmtShort(start)} - ${fmtShort(end)}`;

  const handlePresetClick = (value: Exclude<Preset, "custom">) => {
    setPreset(value);
    setCustomRange(undefined);
  };

  const handleCalendarSelect = (range: DateRange | undefined) => {
    setCustomRange(range);
    if (range?.from) {
      setPreset("custom");
    }
  };

  const handleCalendarApply = () => {
    setCalendarOpen(false);
  };

  const { results, status, loadMore } = usePaginatedQuery(
    api.usageLogs.getUserUsageLogs,
    { startDate: start.getTime(), endDate: end.getTime() },
    { initialNumItems: INITIAL_NUM_ITEMS },
  );

  const isLoadingFirst = status === "LoadingFirstPage";
  const isLoadingMore = status === "LoadingMore";
  const canLoadMore = status === "CanLoadMore";

  const handleExportCsv = () => {
    if (results.length === 0) return;

    const headers = [
      "Date",
      "Type",
      "Model",
      "Cache Read",
      "Cache Write",
      "Input",
      "Output",
      "Total Tokens",
      "Cost",
    ];
    const rows = results.map((log) => [
      new Date(log._creationTime).toISOString(),
      log.byok ? "BYOK" : log.type === "included" ? "Included" : "Extra Usage",
      log.model,
      (log.cache_read_tokens ?? 0).toString(),
      (log.cache_write_tokens ?? 0).toString(),
      log.input_tokens.toString(),
      log.output_tokens.toString(),
      log.total_tokens.toString(),
      formatCost(log.cost_dollars),
    ]);

    const csvContent = [headers, ...rows]
      .map((row) => row.join(","))
      .join("\n");
    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `usage-${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3">
      {/* Controls */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Popover open={calendarOpen} onOpenChange={setCalendarOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs gap-1.5"
                aria-label="Pick custom date range"
              >
                {dateLabel}
                <ChevronDown className="h-3 w-3 text-muted-foreground" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="range"
                selected={customRange}
                onSelect={handleCalendarSelect}
                numberOfMonths={1}
                disabled={{ after: new Date() }}
                defaultMonth={start}
              />
              <div className="flex items-center justify-end gap-2 border-t px-3 py-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 text-xs"
                  onClick={() => setCalendarOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="h-7 text-xs"
                  disabled={!customRange?.from}
                  onClick={handleCalendarApply}
                >
                  Apply
                </Button>
              </div>
            </PopoverContent>
          </Popover>

          <div className="flex items-center rounded-md border bg-background">
            {PRESET_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => handlePresetClick(option.value)}
                className={`px-2.5 py-1 text-xs font-medium transition-colors ${
                  preset === option.value
                    ? "bg-muted text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                } ${option.value === "1d" ? "rounded-l-md" : ""} ${option.value === "30d" ? "rounded-r-md" : ""}`}
                aria-label={`Show ${option.label} range`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCsv}
            disabled={results.length === 0}
            className="h-8 text-xs gap-1.5"
            aria-label="Export usage data as CSV"
          >
            <Download className="h-3.5 w-3.5" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="px-3 py-2.5 text-left font-medium text-muted-foreground">
                Date
              </th>
              <th className="px-3 py-2.5 text-left font-medium text-muted-foreground">
                Type
              </th>
              <th className="px-3 py-2.5 text-left font-medium text-muted-foreground">
                Model
              </th>
              <th className="px-3 py-2.5 text-right font-medium text-muted-foreground">
                Tokens
              </th>
              <th className="px-3 py-2.5 text-right font-medium text-muted-foreground">
                Cost
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoadingFirst ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center">
                  <div className="flex items-center justify-center gap-2 text-muted-foreground">
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    <span>Loading usage history...</span>
                  </div>
                </td>
              </tr>
            ) : results.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-3 py-8 text-center text-muted-foreground"
                >
                  No usage data for this period.
                </td>
              </tr>
            ) : (
              results.map((log) => (
                <tr
                  key={log._id}
                  className="border-b last:border-b-0 hover:bg-muted/30 transition-colors"
                >
                  <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">
                    {formatTimestamp(log._creationTime)}
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">
                    {log.byok
                      ? "BYOK"
                      : log.type === "included"
                        ? "Included"
                        : "Extra"}
                  </td>
                  <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">
                    {log.model}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                    <TokenBreakdownTooltip
                      totalTokens={log.total_tokens}
                      inputTokens={log.input_tokens}
                      outputTokens={log.output_tokens}
                      cacheReadTokens={log.cache_read_tokens}
                      cacheWriteTokens={log.cache_write_tokens}
                    />
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                    {formatCost(log.cost_dollars)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Load more */}
      {(canLoadMore || isLoadingMore) && (
        <div className="flex items-center justify-between pt-1">
          <p className="text-xs text-muted-foreground">
            {results.length} results loaded
          </p>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => loadMore(100)}
              disabled={isLoadingMore}
              className="h-7 px-2.5 text-xs"
              aria-label="Load 100 more results"
            >
              {isLoadingMore ? (
                <RefreshCw className="h-3 w-3 animate-spin mr-1" />
              ) : null}
              +100
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => loadMore(400)}
              disabled={isLoadingMore}
              className="h-7 px-2.5 text-xs"
              aria-label="Load 400 more results"
            >
              +400
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};

export { UsageLogsTable };
