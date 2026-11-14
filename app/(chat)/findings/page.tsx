"use client";

import Link from "next/link";
import {
  Suspense,
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import { useConvex, useConvexAuth, usePaginatedQuery } from "convex/react";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  Filter,
  Info,
  PanelLeft,
  Play,
  Search,
  ShieldAlert,
  ShieldCheck,
  X,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
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
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { FindingDetail } from "@/app/components/findings/FindingDetail";
import { getFindingSeverityDotClasses } from "@/app/components/findings/FindingCard";
import {
  FINDING_EVIDENCE_BASIS_NOTE,
  FindingEvidenceBadge,
} from "@/app/components/findings/FindingEvidenceBadge";
import {
  FindingExportMenu,
  FindingExportUnavailableError,
} from "@/app/components/findings/FindingExportMenu";
import { FindingRelativeTime } from "@/app/components/findings/FindingTime";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { useProjects } from "@/app/hooks/useProjects";
import { navigateToAuth } from "@/app/hooks/useTauri";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import {
  FINDING_CATEGORIES,
  FINDING_CATEGORY_LABELS,
} from "@/lib/findings/category";
import { captureFindingEvent } from "@/lib/findings/client-telemetry";
import { downloadFile } from "@/lib/utils/file-download";
import { cn } from "@/lib/utils";
import type {
  FindingCategory,
  FindingDetailRecord,
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

const MAX_SELECTED_FINDINGS = 50;
const SELECTED_EXPORT_CONCURRENCY = 4;
// Convex document IDs are lowercase alphanumerics. Anything else would fail
// the v.id("projects") validator, so it is treated as an unavailable filter.
const PROJECT_ID_PATTERN = /^[a-z0-9]{16,64}$/;
const NO_SELECTION: string[] = [];

const capitalize = (value: string) => value[0].toUpperCase() + value.slice(1);

type FilterOption<T extends string> = { value: T; label: string };

const SEVERITY_OPTIONS: FilterOption<"all" | FindingSeverity>[] = [
  { value: "all", label: "All severities" },
  ...SEVERITIES.map((value) => ({ value, label: capitalize(value) })),
];

const STATUS_OPTIONS: FilterOption<"all" | FindingStatus>[] = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "closed", label: "Closed" },
];

const CATEGORY_OPTIONS: FilterOption<"all" | FindingCategory>[] = [
  { value: "all", label: "All categories" },
  ...FINDING_CATEGORIES.map((value) => ({
    value,
    label: FINDING_CATEGORY_LABELS[value],
  })),
];

// Column template shared by the header row and every finding row. It follows
// the list's own width, so a collapsed or expanded sidebar reflows the lanes:
// stacked below 36rem, then severity | finding, then an evidence lane from
// 52rem, and the full status and found lanes from 70rem.
const FINDING_ROW_COLUMNS =
  "@min-[36rem]:grid-cols-[6.5rem_minmax(0,1fr)_1rem] @min-[52rem]:grid-cols-[6.5rem_minmax(0,1fr)_10.5rem_1rem] @min-[70rem]:grid-cols-[6.5rem_minmax(0,1fr)_11rem_5.5rem_11rem_1rem]";

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

const getProjectFilter = (value: string | null): string | null =>
  value ? value : null;

const escapeCsvCell = (value: string | number) => {
  const raw = String(value);
  const guarded = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;

  return `"${guarded.replaceAll('"', '""')}"`;
};

type FindingsUrlState = {
  search: string;
  severity: "all" | FindingSeverity;
  category: "all" | FindingCategory;
  status: "all" | FindingStatus;
  project: string | null;
  findingId: string | null;
};

const readFindingsUrlState = (params: URLSearchParams): FindingsUrlState => ({
  search: params.get("q") ?? "",
  severity: getSeverityFilter(params.get("severity")),
  category: getCategoryFilter(params.get("category")),
  status: getStatusFilter(params.get("status")),
  project: getProjectFilter(params.get("project")),
  findingId: params.get("finding"),
});

const getFindingsHref = ({
  search,
  severity,
  category,
  status,
  project,
  findingId,
}: FindingsUrlState) => {
  const params = new URLSearchParams();
  if (project) params.set("project", project);
  if (search) params.set("q", search);
  if (severity !== "all") params.set("severity", severity);
  if (category !== "all") params.set("category", category);
  if (status !== "all") params.set("status", status);
  if (findingId) params.set("finding", findingId);
  const query = params.toString();
  return query ? `/findings?${query}` : "/findings";
};

// Next or another URL writer can replace custom history state during reload.
// Keep only the ownership bit for this exact browser entry, scoped to the tab.
// Older browsers or blocked storage fall back to the classic history marker.
const findingEntryStorageKey = () => {
  const key = window.navigation?.currentEntry?.key;
  return key ? `hackerai:findings:entry:${key}` : null;
};

const ownsFindingEntry = () => {
  if (window.history.state?.hackeraiFindingEntry === true) return true;
  try {
    const key = findingEntryStorageKey();
    return key !== null && window.sessionStorage.getItem(key) === "1";
  } catch {
    return false;
  }
};

const updateFindingsHistory = (
  href: string,
  method: "push" | "replace" = "replace",
) => {
  const state = { ...window.history.state };
  // Let Next's patched history API copy its internal state and update URL
  // hooks. Passing its internal markers would bypass that synchronization.
  delete state.__NA;
  delete state._N;
  const owned =
    new URL(href, window.location.origin).searchParams.has("finding") &&
    (method === "push" || ownsFindingEntry());
  if (owned) state.hackeraiFindingEntry = true;
  else delete state.hackeraiFindingEntry;
  window.history[method === "push" ? "pushState" : "replaceState"](
    state,
    "",
    href,
  );
  try {
    const key = findingEntryStorageKey();
    if (key) {
      if (owned) window.sessionStorage.setItem(key, "1");
      else window.sessionStorage.removeItem(key);
    }
  } catch {
    // Storage is optional; normal history navigation still works without it.
  }
};

function FilterSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: FilterOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as T)}>
      <SelectTrigger className={className} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function FindingsPageContent() {
  const router = useRouter();
  const convex = useConvex();
  const searchParams = useSearchParams();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const { setChatSidebarOpen, closeSidebar, initializeNewChat, setChatMode } =
    useGlobalState();
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
  const [project, setProject] = useState<string | null>(() =>
    getProjectFilter(searchParams.get("project")),
  );
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(
    () => searchParams.get("finding"),
  );
  const selectedFindingTriggerRef = useRef<HTMLAnchorElement | null>(null);
  const closingFindingHistory = useRef(false);
  const findingsHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  const projectIdFilter =
    project && PROJECT_ID_PATTERN.test(project)
      ? (project as Id<"projects">)
      : undefined;
  const isProjectFilterInvalid = project !== null && !projectIdFilter;

  // Selection belongs to one exact filter scope; changing any filter or the
  // project drops it without an effect, while load-more keeps it.
  const selectionScope = JSON.stringify([
    deferredSearch,
    severity,
    category,
    status,
    project,
  ]);
  const [selection, setSelection] = useState<{
    scope: string;
    active: boolean;
    ids: string[];
  }>({ scope: selectionScope, active: false, ids: NO_SELECTION });
  // Discard the old scope, so returning to a previous filter cannot revive it.
  if (selection.scope !== selectionScope) {
    setSelection({ scope: selectionScope, active: false, ids: NO_SELECTION });
  }
  const isSelecting = selection.scope === selectionScope && selection.active;
  const selectedIds = isSelecting ? selection.ids : NO_SELECTION;
  const setSelectedIds = (ids: string[]) =>
    setSelection({ scope: selectionScope, active: true, ids });
  const setSelecting = (active: boolean) =>
    setSelection({ scope: selectionScope, active, ids: NO_SELECTION });

  const applyUrlState = useCallback((state: FindingsUrlState) => {
    setSearch(state.search);
    setSeverity(state.severity);
    setCategory(state.category);
    setStatus(state.status);
    setProject(state.project);
    setSelectedFindingId(state.findingId);
  }, []);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) navigateToAuth("/login");
  }, [isAuthenticated, isLoading]);

  useEffect(() => {
    if (!isAuthenticated) return;
    captureAuthenticatedEvent("findings_page_viewed");
  }, [isAuthenticated]);

  useEffect(() => {
    const syncFromBrowserHistory = () => {
      closingFindingHistory.current = false;
      const params = new URLSearchParams(window.location.search);
      if (params.has("chat")) {
        params.delete("chat");
        const query = params.toString();
        updateFindingsHistory(query ? `/findings?${query}` : "/findings");
      }
      applyUrlState(readFindingsUrlState(params));
    };

    syncFromBrowserHistory();
    window.addEventListener("popstate", syncFromBrowserHistory);
    return () => window.removeEventListener("popstate", syncFromBrowserHistory);
  }, [applyUrlState]);

  // In-app links (e.g. a project's "View findings") navigate to this already
  // mounted page; adopt their URL when it points at a different project.
  const projectRef = useRef(project);
  useEffect(() => {
    projectRef.current = project;
  }, [project]);
  const urlProject = getProjectFilter(searchParams.get("project"));
  useEffect(() => {
    if (urlProject === projectRef.current) return;
    projectRef.current = urlProject;
    applyUrlState(readFindingsUrlState(new URLSearchParams(searchParams)));
  }, [applyUrlState, searchParams, urlProject]);

  const getHref = (overrides: Partial<FindingsUrlState> = {}) =>
    getFindingsHref({
      search: deferredSearch,
      severity,
      category,
      status,
      project,
      findingId: selectedFindingId,
      ...overrides,
    });

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
        project,
        findingId: selectedFindingId,
      }),
    );
  }, [category, deferredSearch, project, selectedFindingId, severity, status]);

  useEffect(() => {
    if (!selectedFindingId) return;
    captureAuthenticatedEvent("finding_viewed", { surface: "findings_page" });
  }, [selectedFindingId]);

  const {
    results: projectResults,
    status: projectsStatus,
    loadMore: loadMoreProjects,
  } = useProjects(50, isAuthenticated);
  const projectOptions = projectResults ?? [];
  const selectedProject = projectIdFilter
    ? projectOptions.find((item) => item._id === projectIdFilter)
    : undefined;
  const isResolvingProject =
    Boolean(projectIdFilter) &&
    !selectedProject &&
    (projectResults === undefined ||
      projectsStatus === "CanLoadMore" ||
      projectsStatus === "LoadingMore");
  const isProjectUnavailable =
    project !== null && !selectedProject && !isResolvingProject;

  // A linked project may sit beyond the first page of the project list.
  useEffect(() => {
    if (!isResolvingProject || projectsStatus !== "CanLoadMore") return;
    loadMoreProjects(50);
  }, [isResolvingProject, loadMoreProjects, projectsStatus]);

  const queryFilters = {
    ...(deferredSearch ? { search: deferredSearch } : {}),
    ...(severity !== "all" ? { severity } : {}),
    ...(category !== "all" ? { category } : {}),
    ...(status !== "all" ? { status } : {}),
    ...(projectIdFilter ? { projectId: projectIdFilter } : {}),
  };

  const findingsQuery = usePaginatedQuery(
    api.findings.listFindings,
    isAuthenticated &&
      !isProjectFilterInvalid &&
      (project === null || Boolean(selectedProject))
      ? queryFilters
      : "skip",
    { initialNumItems: 25 },
  );
  const findings = (
    isProjectFilterInvalid || isProjectUnavailable || isResolvingProject
      ? []
      : (findingsQuery.results ?? [])
  ) as FindingSummary[];
  const lastObservedSearch = useRef<string | null>(null);
  useEffect(() => {
    if (!isAuthenticated || findingsQuery.status === "LoadingFirstPage") return;
    const key = JSON.stringify([
      deferredSearch,
      severity,
      category,
      status,
      project,
    ]);
    if (lastObservedSearch.current === key) return;
    lastObservedSearch.current = key;
    captureFindingEvent({
      operation: "search",
      outcome: "success",
      surface: "findings_page",
      has_search: Boolean(deferredSearch),
      result_count: findings.length,
    });
  }, [
    isAuthenticated,
    deferredSearch,
    severity,
    category,
    status,
    project,
    findingsQuery.status,
    findings.length,
  ]);
  const hasActiveFilters =
    Boolean(deferredSearch) ||
    severity !== "all" ||
    category !== "all" ||
    status !== "all" ||
    project !== null;
  // Search and project stay visible at every width; this counts only the
  // filters that move into the sheet when the toolbar is compact.
  const sheetFilterCount = [severity, status, category].filter(
    (value) => value !== "all",
  ).length;
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

  const selectedIdSet = new Set(selectedIds);
  const loadedIds = findings.map((finding) => finding.finding_id);
  const selectedLoadedCount = loadedIds.filter((id) =>
    selectedIdSet.has(id),
  ).length;
  const allLoadedSelected =
    loadedIds.length > 0 && selectedLoadedCount === loadedIds.length;

  const toggleFindingSelection = (findingId: string) => {
    if (selectedIdSet.has(findingId)) {
      setSelectedIds(selectedIds.filter((id) => id !== findingId));
      return;
    }
    if (selectedIds.length >= MAX_SELECTED_FINDINGS) {
      toast.warning(
        `You can select up to ${MAX_SELECTED_FINDINGS} findings at a time.`,
      );
      return;
    }
    setSelectedIds([...selectedIds, findingId]);
  };

  const toggleLoadedSelection = () => {
    if (allLoadedSelected) {
      const loadedIdSet = new Set(loadedIds);
      setSelectedIds(selectedIds.filter((id) => !loadedIdSet.has(id)));
      return;
    }
    const unselected = loadedIds.filter((id) => !selectedIdSet.has(id));
    const room = Math.max(0, MAX_SELECTED_FINDINGS - selectedIds.length);
    setSelectedIds([...selectedIds, ...unselected.slice(0, room)]);
    if (unselected.length > room) {
      toast.warning(
        `Selection is limited to ${MAX_SELECTED_FINDINGS} findings. The first ${MAX_SELECTED_FINDINGS} are selected.`,
      );
    }
  };

  const getSelectedFindings = async (): Promise<FindingDetailRecord[]> => {
    const ids = [...selectedIds];
    const records: FindingDetailRecord[] = [];
    const chunkSize = SELECTED_EXPORT_CONCURRENCY;
    for (let index = 0; index < ids.length; index += chunkSize) {
      const chunk = await Promise.all(
        ids
          .slice(index, index + chunkSize)
          .map((findingId) =>
            convex.query(api.findings.getFinding, { findingId }),
          ),
      );
      for (const record of chunk) {
        // Never export a partial report: one missing finding fails the export.
        if (!record) throw new FindingExportUnavailableError();
        records.push(record as FindingDetailRecord);
      }
    }
    return records;
  };

  const selectFinding = (findingId: string, trigger: HTMLAnchorElement) => {
    selectedFindingTriggerRef.current = trigger;
    setSelectedFindingId(findingId);
    updateFindingsHistory(
      getHref({ findingId }),
      selectedFindingId ? "replace" : "push",
    );
    closeSidebar();
  };

  const clearSelectedFinding = () => {
    if (closingFindingHistory.current) return;
    // Consume the entry opened from this list. A deep link has no owned list
    // entry behind it, so close it in place instead. State survives reload and
    // Forward, unlike an in-memory "opened here" flag.
    if (ownsFindingEntry()) {
      closingFindingHistory.current = true;
      window.history.back();
      return;
    }
    setSelectedFindingId(null);
    updateFindingsHistory(getHref({ findingId: null }));
  };

  const startNewScan = () => {
    closeSidebar();
    initializeNewChat();
    setChatMode("agent");
    router.push("/");
  };

  const changeSeverity = (nextSeverity: "all" | FindingSeverity) => {
    setSeverity(nextSeverity);
    updateFindingsHistory(getHref({ severity: nextSeverity }));
  };

  const changeStatus = (nextStatus: "all" | FindingStatus) => {
    setStatus(nextStatus);
    updateFindingsHistory(getHref({ status: nextStatus }));
  };

  const changeCategory = (nextCategory: "all" | FindingCategory) => {
    setCategory(nextCategory);
    updateFindingsHistory(getHref({ category: nextCategory }));
  };

  const clearFilters = () => {
    setSearch("");
    setSeverity("all");
    setCategory("all");
    setStatus("all");
    setProject(null);
    updateFindingsHistory(
      getFindingsHref({
        search: "",
        severity: "all",
        category: "all",
        status: "all",
        project: null,
        findingId: selectedFindingId,
      }),
    );
  };

  const handleExport = async () => {
    setIsExporting(true);
    try {
      const filters = queryFilters;
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

      const result = await downloadFile({
        filename: `findings-${new Date().toISOString().slice(0, 10)}.csv`,
        content: csv,
        mimeType: "text/csv;charset=utf-8",
      });
      captureFindingEvent({
        operation: "export",
        ...result,
        format: "csv",
        result_count: rows.length,
      });
      if (
        !isDone &&
        (result.outcome === "success" || result.outcome === "initiated")
      ) {
        toast.warning("Exported the first 5,000 matching findings.");
      }
    } catch {
      captureFindingEvent({
        operation: "export",
        outcome: "failed",
        format: "csv",
        reason: "general",
      });
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
        <header className="@container flex shrink-0 items-center gap-3 border-b border-border px-4 py-3 sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setChatSidebarOpen(true)}
            aria-label="Open navigation"
          >
            <PanelLeft className="size-5" aria-hidden="true" />
          </Button>
          <div className="hidden size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/30 text-muted-foreground md:flex">
            <ShieldCheck className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h1
              ref={findingsHeadingRef}
              tabIndex={-1}
              className="text-lg font-semibold text-foreground"
            >
              Findings
            </h1>
            <p className="hidden truncate text-xs text-muted-foreground @min-[48rem]:block">
              Vulnerability assessments, evidence, and remediation guidance
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={isExporting || findings.length === 0}
              onClick={() => void handleExport()}
              aria-label="Export all matching findings as CSV"
            >
              <Download className="size-4" aria-hidden="true" />
              <span className="hidden @min-[32rem]:inline">
                {isExporting ? "Exporting…" : "Export all as CSV"}
              </span>
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={startNewScan}
              aria-label="Start new scan"
            >
              <Play className="size-4" aria-hidden="true" />
              <span className="@min-[32rem]:hidden">New scan</span>
              <span className="hidden @min-[32rem]:inline">Start new scan</span>
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1440px] p-4 sm:p-6">
            {/* Every responsive step below follows this element's width, not
                the viewport, so the sidebar state is already accounted for. */}
            <div className="@container">
              <div
                role="group"
                aria-label="Filters"
                className="flex flex-wrap items-center gap-2"
              >
                <div className="relative min-w-0 grow basis-full @min-[36rem]:basis-48">
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

                <div className="min-w-0 grow basis-0 @min-[36rem]:grow-0 @min-[36rem]:basis-auto">
                  <Select
                    value={project ?? "all"}
                    onValueChange={(value) => {
                      const nextProject = value === "all" ? null : value;
                      setProject(nextProject);
                      updateFindingsHistory(getHref({ project: nextProject }));
                    }}
                  >
                    <SelectTrigger
                      className="w-full gap-2 @min-[36rem]:w-44 @min-[52rem]:w-auto @min-[52rem]:max-w-48"
                      aria-label="Filter by project"
                    >
                      <SelectValue placeholder="All projects" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All projects</SelectItem>
                      {project !== null && !selectedProject ? (
                        <SelectItem value={project}>
                          {isResolvingProject
                            ? "Loading project…"
                            : "Unavailable project"}
                        </SelectItem>
                      ) : null}
                      {projectOptions.map((item) => (
                        <SelectItem key={item._id} value={item._id}>
                          <span className="truncate">{item.name}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="hidden items-center gap-2 @min-[52rem]:flex">
                  <FilterSelect
                    label="Filter by severity"
                    value={severity}
                    options={SEVERITY_OPTIONS}
                    onChange={changeSeverity}
                    className="w-auto max-w-48 gap-2"
                  />
                  <FilterSelect
                    label="Filter by status"
                    value={status}
                    options={STATUS_OPTIONS}
                    onChange={changeStatus}
                    className="w-auto max-w-48 gap-2"
                  />
                  <FilterSelect
                    label="Filter by category"
                    value={category}
                    options={CATEGORY_OPTIONS}
                    onChange={changeCategory}
                    className="w-auto max-w-48 gap-2"
                  />
                  {hasActiveFilters ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground"
                      onClick={clearFilters}
                    >
                      Clear
                    </Button>
                  ) : null}
                </div>

                <Sheet>
                  <SheetTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      className="shrink-0 @min-[52rem]:hidden"
                    >
                      <Filter className="size-4" aria-hidden="true" />
                      Filters
                      {sheetFilterCount > 0 ? (
                        <span className="rounded-md bg-muted px-1.5 text-xs tabular-nums text-foreground">
                          {sheetFilterCount}
                          <span className="sr-only"> active</span>
                        </span>
                      ) : null}
                    </Button>
                  </SheetTrigger>
                  <SheetContent
                    side="bottom"
                    className="mx-auto max-h-[85dvh] w-full gap-0 overflow-y-auto rounded-t-xl sm:max-w-md sm:border-x"
                  >
                    <SheetHeader>
                      <SheetTitle>Filters</SheetTitle>
                      <SheetDescription className="sr-only">
                        Filter findings by severity, status, or category.
                      </SheetDescription>
                    </SheetHeader>
                    <div className="space-y-4 px-4">
                      <div className="space-y-1.5">
                        <span className="text-xs font-medium text-muted-foreground">
                          Severity
                        </span>
                        <FilterSelect
                          label="Filter by severity"
                          value={severity}
                          options={SEVERITY_OPTIONS}
                          onChange={changeSeverity}
                          className="h-10"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <span className="text-xs font-medium text-muted-foreground">
                          Status
                        </span>
                        <FilterSelect
                          label="Filter by status"
                          value={status}
                          options={STATUS_OPTIONS}
                          onChange={changeStatus}
                          className="h-10"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <span className="text-xs font-medium text-muted-foreground">
                          Category
                        </span>
                        <FilterSelect
                          label="Filter by category"
                          value={category}
                          options={CATEGORY_OPTIONS}
                          onChange={changeCategory}
                          className="h-10"
                        />
                      </div>
                    </div>
                    <SheetFooter className="flex-row pb-[max(1rem,env(safe-area-inset-bottom))]">
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!hasActiveFilters}
                        onClick={clearFilters}
                      >
                        Clear all filters
                      </Button>
                      <SheetClose asChild>
                        <Button type="button" className="min-w-0 flex-1">
                          Done
                        </Button>
                      </SheetClose>
                    </SheetFooter>
                  </SheetContent>
                </Sheet>
              </div>

              {isProjectUnavailable ? (
                <p
                  role="status"
                  className="mt-2 text-xs leading-5 text-muted-foreground"
                >
                  This project is unavailable. It may have been deleted.
                </p>
              ) : null}
              {projectsStatus === "CanLoadMore" && !isResolvingProject ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="mt-1 h-7 px-2 text-xs text-muted-foreground"
                  onClick={() => loadMoreProjects(50)}
                >
                  Load more projects
                </Button>
              ) : null}

              <section
                className="mt-5"
                aria-labelledby="findings-results-heading"
              >
                <div className="mb-2 flex min-h-9 flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-col @min-[36rem]:flex-row @min-[36rem]:items-baseline @min-[36rem]:gap-2.5">
                    <h2
                      id="findings-results-heading"
                      className="text-base font-semibold text-foreground"
                    >
                      {findingsQuery.status === "LoadingFirstPage" ||
                      isProjectFilterInvalid
                        ? "Findings"
                        : `${visibleFindingCount} ${
                            findings.length === 1 ? "finding" : "findings"
                          }`}
                    </h2>
                    <p
                      className="mt-0.5 break-words text-xs text-muted-foreground @min-[36rem]:mt-0"
                      aria-live="polite"
                    >
                      {deferredSearch
                        ? `Best matches for “${deferredSearch}”`
                        : "Newest findings first"}
                    </p>
                  </div>
                  {findings.length > 0 || isSelecting ? (
                    <div className="flex items-center gap-2">
                      {isSelecting && findings.length > 0 ? (
                        <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
                          <input
                            type="checkbox"
                            ref={(element) => {
                              if (element) {
                                element.indeterminate =
                                  selectedLoadedCount > 0 && !allLoadedSelected;
                              }
                            }}
                            checked={allLoadedSelected}
                            onChange={toggleLoadedSelection}
                            className="size-4 cursor-pointer accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                          />
                          Select loaded
                        </label>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-label={
                          isSelecting ? "Cancel selection" : "Select findings"
                        }
                        onClick={() => setSelecting(!isSelecting)}
                      >
                        {isSelecting ? "Cancel" : "Select findings"}
                      </Button>
                    </div>
                  ) : null}
                </div>

                {findings.length > 0 ? (
                  <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="@min-[36rem]:hidden">Loaded</span>
                    <span className="hidden @min-[36rem]:inline">
                      In loaded results
                    </span>
                    {SEVERITIES.filter(
                      (value) => visibleSeverityCounts[value] > 0,
                    ).map((value) => (
                      <span
                        key={value}
                        className="inline-flex items-center gap-1.5 tabular-nums text-foreground/90"
                      >
                        <span
                          className={cn(
                            "size-2 rounded-full",
                            getFindingSeverityDotClasses(value),
                          )}
                          aria-hidden="true"
                        />
                        {visibleSeverityCounts[value]} {capitalize(value)}
                      </span>
                    ))}
                    <span className="hidden border-l border-border pl-3 tabular-nums @min-[36rem]:inline">
                      {visibleStatusCounts.active} active ·{" "}
                      {visibleStatusCounts.closed} closed
                    </span>
                  </div>
                ) : null}

                {isProjectFilterInvalid || isProjectUnavailable ? (
                  <div className="flex min-h-80 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border p-8 text-center">
                    <div className="flex size-12 items-center justify-center rounded-xl border border-border bg-muted/30">
                      <ShieldAlert
                        className="size-6 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </div>
                    <div>
                      <p className="font-medium text-foreground">
                        Project filter unavailable
                      </p>
                      <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                        This project link is invalid or no longer available.
                        Clear your filters to see all findings.
                      </p>
                    </div>
                    <Button variant="outline" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  </div>
                ) : isResolvingProject ||
                  findingsQuery.status === "LoadingFirstPage" ? (
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
                    <div className="overflow-hidden rounded-xl border border-border bg-card/30 max-sm:-mx-4 max-sm:rounded-none max-sm:border-x-0">
                      <div
                        className="hidden items-center border-b border-border bg-muted/30 @min-[36rem]:flex"
                        aria-hidden="true"
                      >
                        {isSelecting ? <div className="w-10 shrink-0" /> : null}
                        <div
                          className={cn(
                            "grid min-w-0 flex-1 gap-x-4 py-2 pr-4 text-[11px] font-medium uppercase tracking-wide text-muted-foreground",
                            isSelecting ? "pl-2" : "pl-4",
                            FINDING_ROW_COLUMNS,
                          )}
                        >
                          <div>Severity</div>
                          <div>Finding</div>
                          <div className="hidden @min-[52rem]:block">
                            Evidence basis
                          </div>
                          <div className="hidden @min-[70rem]:block">
                            Status
                          </div>
                          <div className="hidden @min-[70rem]:block">Found</div>
                          <div />
                        </div>
                      </div>
                      <ul
                        className="divide-y divide-border/60"
                        aria-label="Findings"
                      >
                        {findings.map((finding) => {
                          const isChecked = selectedIdSet.has(
                            finding.finding_id,
                          );
                          return (
                            <li
                              key={finding.finding_id}
                              className={cn(
                                "flex items-stretch",
                                isChecked && "bg-muted/30",
                                selectedFindingId === finding.finding_id &&
                                  "bg-muted/40",
                              )}
                            >
                              {isSelecting ? (
                                <label className="flex w-10 shrink-0 cursor-pointer items-start justify-center pt-3.5 transition-colors hover:bg-muted/30 @min-[70rem]:items-center @min-[70rem]:pt-0">
                                  <input
                                    type="checkbox"
                                    checked={isChecked}
                                    onChange={() =>
                                      toggleFindingSelection(finding.finding_id)
                                    }
                                    aria-label={`Select finding: ${finding.title}`}
                                    className="size-4 cursor-pointer accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                                  />
                                </label>
                              ) : null}
                              <Link
                                href={getHref({
                                  findingId: finding.finding_id,
                                })}
                                prefetch={false}
                                ref={(element) => {
                                  if (
                                    element &&
                                    selectedFindingId === finding.finding_id
                                  ) {
                                    selectedFindingTriggerRef.current = element;
                                  }
                                }}
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
                                  "group grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-1 py-3 pr-4 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring @min-[36rem]:gap-x-4 @min-[70rem]:items-center",
                                  isSelecting ? "pl-2" : "pl-4",
                                  FINDING_ROW_COLUMNS,
                                )}
                              >
                                <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-2 text-[13px] font-medium leading-5 text-foreground">
                                  <span
                                    className={cn(
                                      "size-2 shrink-0 rounded-full",
                                      getFindingSeverityDotClasses(
                                        finding.severity,
                                      ),
                                    )}
                                    aria-hidden="true"
                                    data-testid={`finding-severity-dot-${finding.finding_id}`}
                                  />
                                  <span className="capitalize">
                                    {finding.severity}
                                  </span>
                                  <span className="font-normal tabular-nums text-muted-foreground">
                                    {finding.cvss_score.toFixed(1)}
                                  </span>
                                </div>

                                <div className="col-span-2 col-start-1 row-start-2 min-w-0 @min-[36rem]:col-span-1 @min-[36rem]:col-start-2 @min-[36rem]:row-start-1">
                                  <div
                                    className="line-clamp-2 break-words text-[15px] font-medium leading-5 text-foreground @min-[36rem]:text-sm"
                                    title={finding.title}
                                  >
                                    {finding.title}
                                  </div>
                                  <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                                    <span className="max-w-[60%] shrink-0 truncate text-foreground/70">
                                      {
                                        FINDING_CATEGORY_LABELS[
                                          finding.category
                                        ]
                                      }
                                    </span>
                                    <span
                                      className="text-muted-foreground/50"
                                      aria-hidden="true"
                                    >
                                      ·
                                    </span>
                                    <span
                                      className="min-w-0 truncate font-mono"
                                      translate="no"
                                    >
                                      {finding.target}
                                    </span>
                                  </div>
                                </div>

                                {/* These wrappers only exist to regroup the
                                    same nodes per width: `contents` hands
                                    their children to the row grid, `flex`
                                    keeps them on one metadata line. */}
                                <div className="contents @min-[36rem]:col-start-2 @min-[36rem]:row-start-2 @min-[36rem]:flex @min-[36rem]:min-w-0 @min-[36rem]:items-center @min-[36rem]:gap-x-3 @min-[52rem]:contents">
                                  <div className="col-start-1 row-start-3 mt-1 flex min-w-0 @min-[36rem]:mt-0 @min-[36rem]:shrink-0 @min-[52rem]:col-start-3 @min-[52rem]:row-start-1">
                                    <FindingEvidenceBadge
                                      status={finding.evidence_status}
                                    />
                                  </div>
                                  <div className="contents @min-[36rem]:flex @min-[36rem]:min-w-0 @min-[36rem]:items-center @min-[36rem]:gap-x-2 @min-[52rem]:col-start-2 @min-[52rem]:row-start-2 @min-[70rem]:contents">
                                    <span className="col-start-2 row-start-3 mt-1 inline-flex items-center gap-1.5 self-center justify-self-start whitespace-nowrap text-xs font-medium text-foreground @min-[36rem]:mt-0 @min-[36rem]:shrink-0 @min-[70rem]:col-start-4 @min-[70rem]:row-start-1">
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
                                    <span
                                      className="hidden text-xs text-muted-foreground/50 @min-[36rem]:inline @min-[70rem]:hidden"
                                      aria-hidden="true"
                                    >
                                      ·
                                    </span>
                                    <span className="contents @min-[70rem]:col-start-5 @min-[70rem]:row-start-1 @min-[70rem]:flex @min-[70rem]:min-w-0 @min-[70rem]:flex-col @min-[70rem]:gap-0.5">
                                      <span className="col-start-2 row-start-1 self-center justify-self-end whitespace-nowrap text-xs tabular-nums text-muted-foreground @min-[36rem]:shrink-0 @min-[70rem]:self-start @min-[70rem]:text-foreground/80">
                                        <FindingRelativeTime
                                          timestamp={finding.created_at}
                                        />
                                      </span>
                                      {finding.chat_title ? (
                                        <>
                                          <span
                                            className="hidden text-xs text-muted-foreground/50 @min-[36rem]:inline @min-[70rem]:hidden"
                                            aria-hidden="true"
                                          >
                                            ·
                                          </span>
                                          <span className="hidden min-w-0 truncate text-xs text-muted-foreground @min-[36rem]:block">
                                            in {finding.chat_title}
                                          </span>
                                        </>
                                      ) : null}
                                    </span>
                                  </div>
                                </div>

                                <ChevronRight
                                  className="hidden size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground motion-reduce:transition-none @min-[36rem]:col-start-3 @min-[36rem]:row-start-1 @min-[36rem]:mt-0.5 @min-[36rem]:block @min-[52rem]:col-start-4 @min-[70rem]:col-start-6 @min-[70rem]:mt-0"
                                  aria-hidden="true"
                                />
                              </Link>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                    <p className="mt-3 flex items-start gap-1.5 text-xs leading-4 text-muted-foreground">
                      <Info
                        className="size-3.5 shrink-0 translate-y-px"
                        aria-hidden="true"
                      />
                      {FINDING_EVIDENCE_BASIS_NOTE}
                    </p>
                  </>
                )}

                {!isProjectFilterInvalid &&
                  findingsQuery.status === "CanLoadMore" && (
                    <div className="flex justify-center p-4">
                      <Button
                        variant="outline"
                        onClick={() => findingsQuery.loadMore(25)}
                      >
                        Load more
                      </Button>
                    </div>
                  )}
                {!isProjectFilterInvalid &&
                  findingsQuery.status === "LoadingMore" && (
                    <div className="p-4 text-center text-sm text-muted-foreground">
                      Loading more…
                    </div>
                  )}
              </section>
            </div>
          </div>
        </div>

        {/* Kept outside the scrolling body so the export action stays
            reachable however far the list is scrolled. */}
        {isSelecting ? (
          <div
            role="region"
            aria-label="Selected findings"
            className="shrink-0 border-t border-border bg-background"
          >
            <div className="mx-auto flex w-full max-w-[1440px] items-center gap-2 px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-6">
              <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                <p
                  className="whitespace-nowrap text-sm font-medium tabular-nums text-foreground"
                  aria-live="polite"
                >
                  {selectedIds.length} selected
                </p>
                <p className="text-xs tabular-nums text-muted-foreground">
                  <span className="hidden sm:inline">
                    of {findings.length} loaded ·{" "}
                  </span>
                  up to {MAX_SELECTED_FINDINGS} per export
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={selectedIds.length === 0}
                onClick={() => setSelectedIds(NO_SELECTION)}
                aria-label="Clear selection"
              >
                <X className="size-4" aria-hidden="true" />
                <span className="hidden min-[360px]:inline">Clear</span>
              </Button>
              <FindingExportMenu
                getFindings={getSelectedFindings}
                label="Export"
                variant="default"
                align="end"
                disabled={selectedIds.length === 0}
              />
            </div>
          </div>
        ) : null}
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
              const target = selectedFindingTriggerRef.current?.isConnected
                ? selectedFindingTriggerRef.current
                : findingsHeadingRef.current;
              if (target?.isConnected) {
                event.preventDefault();
                target.focus();
              }
            }}
            className="inset-0 flex h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 p-0 shadow-none sm:inset-auto sm:top-1/2 sm:left-1/2 sm:h-[calc(100dvh-3rem)] sm:w-[calc(100vw-3rem)] sm:max-w-6xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:shadow-2xl"
          >
            <DialogTitle className="sr-only">Vulnerability Report</DialogTitle>
            <div className="flex shrink-0 items-center justify-between border-b border-border bg-background px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:contents">
              <DialogClose asChild>
                <Button
                  variant="ghost"
                  className="-ml-3 h-11 text-muted-foreground sm:hidden"
                  aria-label="Return to findings"
                >
                  <ArrowLeft className="size-4" aria-hidden="true" />
                  Findings
                </Button>
              </DialogClose>
              <DialogClose asChild>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="Close vulnerability report"
                  className="size-11 bg-background/90 shadow-sm backdrop-blur-sm sm:absolute sm:top-4 sm:right-4 sm:z-20 sm:size-9"
                >
                  <X className="size-4" aria-hidden="true" />
                </Button>
              </DialogClose>
            </div>
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
