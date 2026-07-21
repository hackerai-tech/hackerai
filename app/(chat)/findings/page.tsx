"use client";

import Link from "next/link";
import { Suspense, useDeferredValue, useEffect, useRef, useState } from "react";
import { useConvex, useConvexAuth, usePaginatedQuery } from "convex/react";
import {
  ChevronRight,
  Download,
  Filter,
  PanelLeft,
  Play,
  Search,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FindingDetail } from "@/app/components/findings/FindingDetail";
import {
  getFindingSeverityClasses,
  getFindingSeverityDotClasses,
} from "@/app/components/findings/FindingCard";
import { FindingRelativeTime } from "@/app/components/findings/FindingTime";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { navigateToAuth } from "@/app/hooks/useTauri";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import {
  FINDING_CATEGORIES,
  FINDING_CATEGORY_LABELS,
} from "@/lib/findings/category";
import { downloadFile } from "@/lib/utils/file-download";
import { cn } from "@/lib/utils";
import type {
  FindingCategory,
  FindingSeverity,
  FindingStatus,
  FindingSummary,
} from "@/types/finding";
import { toast } from "sonner";

const SEVERITIES: FindingSeverity[] = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
];

const getSeverityFilter = (value: string | null): "all" | FindingSeverity =>
  SEVERITIES.includes(value as FindingSeverity)
    ? (value as FindingSeverity)
    : "all";

const getCategoryFilter = (value: string | null): "all" | FindingCategory =>
  FINDING_CATEGORIES.includes(value as FindingCategory)
    ? (value as FindingCategory)
    : "all";

const getStatusFilter = (value: string | null): "all" | FindingStatus =>
  value === "active" || value === "closed" ? value : "all";

const escapeCsvCell = (value: string | number) => {
  const raw = String(value);
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;

  return `"${guarded.replaceAll('"', '""')}"`;
};

const getFindingsHref = ({
  search,
  severity,
  category,
  status,
  findingId,
}: {
  search: string;
  severity: "all" | FindingSeverity;
  category: "all" | FindingCategory;
  status: "all" | FindingStatus;
  findingId: string | null;
}) => {
  const params = new URLSearchParams();
  if (search) params.set("q", search);
  if (severity !== "all") params.set("severity", severity);
  if (category !== "all") params.set("category", category);
  if (status !== "all") params.set("status", status);
  if (findingId) params.set("finding", findingId);
  const query = params.toString();
  return query ? `/findings?${query}` : "/findings";
};

const updateFindingsHistory = (
  href: string,
  method: "push" | "replace" = "replace",
) => {
  window.history[method === "push" ? "pushState" : "replaceState"](
    null,
    "",
    href,
  );
};

function FindingsPageContent() {
  const router = useRouter();
  const convex = useConvex();
  const searchParams = useSearchParams();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const {
    setChatSidebarOpen,
    closeSidebar,
    initializeNewChat,
    setChatMode,
    setTemporaryChatsEnabled,
  } = useGlobalState();
  const [search, setSearch] = useState(() => searchParams.get("q") ?? "");
  const deferredSearch = useDeferredValue(search.trim());
  const [severity, setSeverity] = useState<"all" | FindingSeverity>(() =>
    getSeverityFilter(searchParams.get("severity")),
  );
  const [category, setCategory] = useState<"all" | FindingCategory>(() =>
    getCategoryFilter(searchParams.get("category")),
  );
  const [status, setStatus] = useState<"all" | FindingStatus>(() =>
    getStatusFilter(searchParams.get("status")),
  );
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(
    () => searchParams.get("finding"),
  );
  const selectedFindingTriggerRef = useRef<HTMLAnchorElement | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) navigateToAuth("/login");
  }, [isAuthenticated, isLoading]);

  useEffect(() => {
    if (!isAuthenticated) return;
    captureAuthenticatedEvent("findings_page_viewed");
  }, [isAuthenticated]);

  useEffect(() => {
    const syncFromBrowserHistory = () => {
      const params = new URLSearchParams(window.location.search);
      if (params.has("chat")) {
        params.delete("chat");
        const query = params.toString();
        updateFindingsHistory(query ? `/findings?${query}` : "/findings");
      }
      setSearch(params.get("q") ?? "");
      setSeverity(getSeverityFilter(params.get("severity")));
      setCategory(getCategoryFilter(params.get("category")));
      setStatus(getStatusFilter(params.get("status")));
      setSelectedFindingId(params.get("finding"));
    };

    syncFromBrowserHistory();
    window.addEventListener("popstate", syncFromBrowserHistory);
    return () => window.removeEventListener("popstate", syncFromBrowserHistory);
  }, []);

  useEffect(() => {
    const currentSearch =
      new URLSearchParams(window.location.search).get("q") ?? "";
    if (currentSearch === deferredSearch) return;
    updateFindingsHistory(
      getFindingsHref({
        search: deferredSearch,
        severity,
        category,
        status,
        findingId: selectedFindingId,
      }),
    );
  }, [category, deferredSearch, selectedFindingId, severity, status]);

  useEffect(() => {
    if (!selectedFindingId) return;
    captureAuthenticatedEvent("finding_viewed", { surface: "findings_page" });
  }, [selectedFindingId]);

  const findingsQuery = usePaginatedQuery(
    api.findings.listFindings,
    isAuthenticated
      ? {
          ...(deferredSearch ? { search: deferredSearch } : {}),
          ...(severity !== "all" ? { severity } : {}),
          ...(category !== "all" ? { category } : {}),
          ...(status !== "all" ? { status } : {}),
        }
      : "skip",
    { initialNumItems: 25 },
  );
  const findings = (findingsQuery.results ?? []) as FindingSummary[];
  const hasActiveFilters =
    Boolean(deferredSearch) ||
    severity !== "all" ||
    category !== "all" ||
    status !== "all";
  const visibleSeverityCounts = findings.reduce<
    Record<FindingSeverity, number>
  >(
    (counts, finding) => {
      counts[finding.severity] += 1;
      return counts;
    },
    { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
  );
  const visibleFindingCount =
    findingsQuery.status === "Exhausted"
      ? String(findings.length)
      : `${findings.length}+`;
  const visibleStatusCounts = findings.reduce<Record<FindingStatus, number>>(
    (counts, finding) => {
      counts[finding.status] += 1;
      return counts;
    },
    { active: 0, closed: 0 },
  );

  const selectFinding = (findingId: string, trigger: HTMLAnchorElement) => {
    selectedFindingTriggerRef.current = trigger;
    setSelectedFindingId(findingId);
    updateFindingsHistory(
      getFindingsHref({
        search: deferredSearch,
        severity,
        category,
        status,
        findingId,
      }),
      selectedFindingId ? "replace" : "push",
    );
    closeSidebar();
  };

  const clearSelectedFinding = () => {
    setSelectedFindingId(null);
    updateFindingsHistory(
      getFindingsHref({
        search: deferredSearch,
        severity,
        category,
        status,
        findingId: null,
      }),
    );
  };

  const startNewScan = () => {
    closeSidebar();
    initializeNewChat();
    setTemporaryChatsEnabled(false);
    setChatMode("agent");
    router.push("/");
  };

  const clearFilters = () => {
    setSearch("");
    setSeverity("all");
    setCategory("all");
    setStatus("all");
    updateFindingsHistory(
      getFindingsHref({
        search: "",
        severity: "all",
        category: "all",
        status: "all",
        findingId: selectedFindingId,
      }),
    );
  };

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const filters = {
        ...(deferredSearch ? { search: deferredSearch } : {}),
        ...(severity !== "all" ? { severity } : {}),
        ...(category !== "all" ? { category } : {}),
        ...(status !== "all" ? { status } : {}),
      };
      const exportedFindings: FindingSummary[] = [];
      let cursor: string | null = null;
      let isDone = false;

      while (!isDone && exportedFindings.length < 5_000) {
        const result: {
          page: FindingSummary[];
          isDone: boolean;
          continueCursor: string;
        } = await convex.query(api.findings.listFindings, {
          ...filters,
          paginationOpts: { cursor, numItems: 25 },
        });
        exportedFindings.push(...result.page);
        isDone = result.isDone || !result.continueCursor;
        cursor = result.continueCursor || null;
      }

      const rows = exportedFindings
        .slice(0, 5_000)
        .map((finding) => [
          finding.title,
          finding.target,
          FINDING_CATEGORY_LABELS[finding.category],
          finding.severity,
          finding.cvss_score.toFixed(1),
          finding.status,
          new Date(finding.created_at).toISOString(),
        ]);
      const csv = [
        ["Title", "Target", "Category", "Severity", "CVSS", "Status", "Found"],
        ...rows,
      ]
        .map((row) => row.map(escapeCsvCell).join(","))
        .join("\n");

      await downloadFile({
        filename: `findings-${new Date().toISOString().slice(0, 10)}.csv`,
        content: csv,
        mimeType: "text/csv;charset=utf-8",
      });
      if (!isDone) {
        toast.warning("Exported the first 5,000 matching findings.");
      }
    } catch {
      toast.error("Could not export findings. Try again.");
    } finally {
      setIsExporting(false);
    }
  };

  if (isLoading || !isAuthenticated) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Loading findings…
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 bg-background">
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3 sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setChatSidebarOpen(true)}
            aria-label="Open navigation"
          >
            <PanelLeft className="size-5" aria-hidden="true" />
          </Button>
          <div className="hidden size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/30 text-muted-foreground sm:flex">
            <ShieldCheck className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold text-foreground">Findings</h1>
            <p className="hidden text-xs text-muted-foreground sm:block">
              Confirmed vulnerabilities, evidence, and remediation guidance
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isExporting || findings.length === 0}
              onClick={() => void handleExport()}
              aria-label="Export findings as CSV"
            >
              <Download className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">
                {isExporting ? "Exporting…" : "Export"}
              </span>
            </Button>
            <Button type="button" size="sm" onClick={startNewScan}>
              <Play className="size-4" aria-hidden="true" />
              Start new scan
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1440px]">
            {findings.length > 0 ? (
              <section
                aria-label="Findings overview"
                className="border-b border-border px-4 py-5 sm:px-6"
              >
                <dl className="grid grid-cols-2 gap-5 xl:grid-cols-[0.7fr_0.7fr_0.7fr_1.6fr] xl:gap-8">
                  <div>
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Current Results
                    </dt>
                    <dd className="mt-1 text-xl font-semibold tabular-nums text-foreground">
                      {visibleFindingCount}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      By Severity
                    </dt>
                    <dd className="mt-1.5 flex flex-wrap gap-1.5">
                      {SEVERITIES.filter(
                        (value) => visibleSeverityCounts[value] > 0,
                      ).map((value) => (
                        <span
                          key={value}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] font-medium",
                            getFindingSeverityClasses(value),
                          )}
                        >
                          <span>{value[0].toUpperCase() + value.slice(1)}</span>
                          <span className="tabular-nums">
                            {visibleSeverityCounts[value]}
                          </span>
                        </span>
                      ))}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Active
                    </dt>
                    <dd className="mt-1 flex items-center gap-2 text-xl font-semibold tabular-nums text-foreground">
                      <span
                        className="size-2 rounded-full bg-emerald-500"
                        aria-hidden="true"
                      />
                      {visibleStatusCounts.active}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Closed
                    </dt>
                    <dd className="mt-1 flex items-center gap-2 text-xl font-semibold tabular-nums text-foreground">
                      <span
                        className="size-2 rounded-full bg-muted-foreground/50"
                        aria-hidden="true"
                      />
                      {visibleStatusCounts.closed}
                    </dd>
                  </div>
                </dl>
              </section>
            ) : null}

            <div className="grid min-h-0 p-4 sm:p-6 lg:grid-cols-[240px_minmax(0,1fr)] lg:p-0">
              <aside
                aria-labelledby="finding-filters-heading"
                className="border-b border-border pb-6 lg:border-r lg:border-b-0 lg:px-6 lg:py-6"
              >
                <div className="lg:sticky lg:top-6">
                  <div className="mb-4 flex items-center justify-between gap-3">
                    <h2
                      id="finding-filters-heading"
                      className="flex items-center gap-2 text-sm font-semibold text-foreground"
                    >
                      <Filter className="size-4" aria-hidden="true" />
                      Filters
                    </h2>
                    {hasActiveFilters ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-muted-foreground"
                        onClick={clearFilters}
                      >
                        Clear
                      </Button>
                    ) : null}
                  </div>

                  <div className="space-y-4">
                    <div className="space-y-1.5">
                      <label
                        htmlFor="finding-search"
                        className="text-xs font-medium text-muted-foreground"
                      >
                        Search
                      </label>
                      <div className="relative">
                        <Search
                          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <Input
                          id="finding-search"
                          value={search}
                          onChange={(event) => setSearch(event.target.value)}
                          name="finding-search"
                          autoComplete="off"
                          placeholder="Search findings…"
                          className="pl-9"
                          aria-label="Search findings"
                        />
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <span className="text-xs font-medium text-muted-foreground">
                        Category
                      </span>
                      <Select
                        value={category}
                        onValueChange={(value) => {
                          const nextCategory = value as "all" | FindingCategory;
                          setCategory(nextCategory);
                          updateFindingsHistory(
                            getFindingsHref({
                              search: deferredSearch,
                              severity,
                              category: nextCategory,
                              status,
                              findingId: selectedFindingId,
                            }),
                          );
                        }}
                      >
                        <SelectTrigger
                          className="w-full"
                          aria-label="Filter by category"
                        >
                          <SelectValue placeholder="All categories" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All categories</SelectItem>
                          {FINDING_CATEGORIES.map((value) => (
                            <SelectItem key={value} value={value}>
                              {FINDING_CATEGORY_LABELS[value]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1.5">
                      <span className="text-xs font-medium text-muted-foreground">
                        Status
                      </span>
                      <Select
                        value={status}
                        onValueChange={(value) => {
                          const nextStatus = value as "all" | FindingStatus;
                          setStatus(nextStatus);
                          updateFindingsHistory(
                            getFindingsHref({
                              search: deferredSearch,
                              severity,
                              category,
                              status: nextStatus,
                              findingId: selectedFindingId,
                            }),
                          );
                        }}
                      >
                        <SelectTrigger
                          className="w-full"
                          aria-label="Filter by status"
                        >
                          <SelectValue placeholder="All statuses" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All statuses</SelectItem>
                          <SelectItem value="active">Active</SelectItem>
                          <SelectItem value="closed">Closed</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1.5">
                      <span className="text-xs font-medium text-muted-foreground">
                        Severity
                      </span>
                      <Select
                        value={severity}
                        onValueChange={(value) => {
                          const nextSeverity = value as "all" | FindingSeverity;
                          setSeverity(nextSeverity);
                          updateFindingsHistory(
                            getFindingsHref({
                              search: deferredSearch,
                              severity: nextSeverity,
                              category,
                              status,
                              findingId: selectedFindingId,
                            }),
                          );
                        }}
                      >
                        <SelectTrigger
                          className="w-full"
                          aria-label="Filter by severity"
                        >
                          <SelectValue placeholder="All severities" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All severities</SelectItem>
                          {SEVERITIES.map((value) => (
                            <SelectItem key={value} value={value}>
                              {value[0].toUpperCase() + value.slice(1)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              </aside>

              <section
                className="min-w-0 pt-6 lg:px-8 lg:py-6"
                aria-labelledby="findings-results-heading"
              >
                <div className="mb-4 flex min-h-9 flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <h2
                      id="findings-results-heading"
                      className="text-base font-semibold text-foreground"
                    >
                      {findingsQuery.status === "LoadingFirstPage"
                        ? "Findings"
                        : `${visibleFindingCount} ${
                            findings.length === 1 ? "finding" : "findings"
                          }`}
                    </h2>
                    <p
                      className="mt-0.5 break-words text-xs text-muted-foreground"
                      aria-live="polite"
                    >
                      {deferredSearch
                        ? `Best matches for “${deferredSearch}”`
                        : "Newest confirmed findings first"}
                    </p>
                  </div>
                </div>

                {findingsQuery.status === "LoadingFirstPage" ? (
                  <div className="flex min-h-64 items-center justify-center rounded-xl border border-border text-sm text-muted-foreground">
                    Loading findings…
                  </div>
                ) : findings.length === 0 ? (
                  <div className="flex min-h-80 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border p-8 text-center">
                    <div className="flex size-12 items-center justify-center rounded-xl border border-border bg-muted/30">
                      <ShieldAlert
                        className="size-6 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">
                        {hasActiveFilters
                          ? "No matching findings"
                          : "No findings yet"}
                      </p>
                      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                        {hasActiveFilters
                          ? "Try a different search or clear your filters to see all findings."
                          : "Use Agent to test a target. Once it confirms a vulnerability with solid evidence and a working proof of concept, you’ll find it here."}
                      </p>
                    </div>
                    {hasActiveFilters ? (
                      <Button variant="outline" onClick={clearFilters}>
                        Clear filters
                      </Button>
                    ) : (
                      <Button onClick={startNewScan}>
                        Start your first scan
                      </Button>
                    )}
                  </div>
                ) : (
                  <>
                    <div
                      className="hidden grid-cols-[minmax(300px,1.6fr)_minmax(170px,0.8fr)_120px_100px_90px_20px] items-center gap-4 px-4 pb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground xl:grid"
                      aria-hidden="true"
                    >
                      <div>Finding</div>
                      <div>Category</div>
                      <div>Severity</div>
                      <div>Status</div>
                      <div className="text-right">Found</div>
                      <div />
                    </div>
                    <ul className="space-y-2" aria-label="Findings">
                      {findings.map((finding) => (
                        <li key={finding.finding_id}>
                          <Link
                            href={getFindingsHref({
                              search: deferredSearch,
                              severity,
                              category,
                              status,
                              findingId: finding.finding_id,
                            })}
                            prefetch={false}
                            onClick={(event) => {
                              if (
                                event.button !== 0 ||
                                event.metaKey ||
                                event.ctrlKey ||
                                event.shiftKey ||
                                event.altKey
                              ) {
                                return;
                              }
                              event.preventDefault();
                              selectFinding(
                                finding.finding_id,
                                event.currentTarget,
                              );
                            }}
                            className={cn(
                              "group block min-w-0 rounded-xl border border-border bg-card/30 p-4 text-left shadow-sm transition-[background-color,border-color] hover:border-foreground/15 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:grid xl:grid-cols-[minmax(300px,1.6fr)_minmax(170px,0.8fr)_120px_100px_90px_20px] xl:items-center xl:gap-4",
                              selectedFindingId === finding.finding_id &&
                                "border-foreground/20 bg-muted/40",
                            )}
                          >
                            <div className="flex min-w-0 items-start gap-3">
                              <span
                                className={cn(
                                  "mt-1.5 size-2.5 shrink-0 rounded-full",
                                  getFindingSeverityDotClasses(
                                    finding.severity,
                                  ),
                                )}
                                aria-hidden="true"
                              />
                              <div className="min-w-0 flex-1">
                                <div className="line-clamp-2 text-sm font-medium leading-5 text-foreground xl:truncate">
                                  {finding.title}
                                </div>
                                <div
                                  className="mt-1 truncate font-mono text-xs text-muted-foreground"
                                  translate="no"
                                >
                                  {finding.target}
                                </div>
                              </div>
                            </div>

                            <div className="mt-3 text-xs text-muted-foreground xl:mt-0">
                              {FINDING_CATEGORY_LABELS[finding.category]}
                            </div>

                            <div className="mt-3 flex items-center justify-between gap-3 xl:mt-0 xl:block">
                              <span className="inline-flex items-center gap-1.5 text-xs font-medium capitalize text-foreground">
                                <span
                                  className={cn(
                                    "size-2 rounded-full",
                                    getFindingSeverityDotClasses(
                                      finding.severity,
                                    ),
                                  )}
                                  aria-hidden="true"
                                  data-testid={`finding-severity-dot-${finding.finding_id}`}
                                />
                                {finding.severity}
                                <span className="tabular-nums text-muted-foreground">
                                  {finding.cvss_score.toFixed(1)}
                                </span>
                              </span>
                              <span className="text-xs tabular-nums text-muted-foreground xl:hidden">
                                <FindingRelativeTime
                                  timestamp={finding.created_at}
                                />
                              </span>
                            </div>

                            <div className="mt-2 xl:mt-0">
                              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground">
                                <span
                                  className={cn(
                                    "size-2 rounded-full",
                                    finding.status === "active"
                                      ? "bg-emerald-500"
                                      : "bg-muted-foreground/50",
                                  )}
                                  aria-hidden="true"
                                />
                                {finding.status === "active"
                                  ? "Active"
                                  : "Closed"}
                              </span>
                            </div>

                            <div className="hidden text-right text-xs tabular-nums text-muted-foreground xl:block">
                              <FindingRelativeTime
                                timestamp={finding.created_at}
                              />
                            </div>

                            <ChevronRight
                              className="hidden size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground motion-reduce:transition-none xl:block"
                              aria-hidden="true"
                            />
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                {findingsQuery.status === "CanLoadMore" && (
                  <div className="flex justify-center p-4">
                    <Button
                      variant="outline"
                      onClick={() => findingsQuery.loadMore(25)}
                    >
                      Load more
                    </Button>
                  </div>
                )}
                {findingsQuery.status === "LoadingMore" && (
                  <div className="p-4 text-center text-sm text-muted-foreground">
                    Loading more…
                  </div>
                )}
              </section>
            </div>
          </div>
        </div>
      </main>

      {selectedFindingId && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) clearSelectedFinding();
          }}
        >
          <DialogContent
            showCloseButton={false}
            overlayClassName="bg-black/60 backdrop-blur-sm"
            aria-describedby={undefined}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (selectedFindingTriggerRef.current?.isConnected) {
                selectedFindingTriggerRef.current.focus();
              }
            }}
            className="inset-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 shadow-none sm:inset-auto sm:top-1/2 sm:left-1/2 sm:h-[calc(100dvh-3rem)] sm:w-[calc(100vw-3rem)] sm:max-w-6xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:shadow-2xl"
          >
            <DialogTitle className="sr-only">Vulnerability Report</DialogTitle>
            <DialogClose asChild>
              <Button
                variant="outline"
                size="icon"
                aria-label="Close vulnerability report"
                className="absolute top-[max(0.75rem,env(safe-area-inset-top))] right-[max(0.75rem,env(safe-area-inset-right))] z-20 size-9 bg-background/90 shadow-sm backdrop-blur-sm sm:top-4 sm:right-4"
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </DialogClose>
            <div className="min-h-0 flex-1">
              <FindingDetail
                findingId={selectedFindingId}
                surface="findings_page"
                onRequestClose={clearSelectedFinding}
              />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

export default function FindingsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          Loading findings…
        </div>
      }
    >
      <FindingsPageContent />
    </Suspense>
  );
}
