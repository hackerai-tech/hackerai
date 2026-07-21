"use client";

import Link from "next/link";
import { Suspense, useDeferredValue, useEffect, useRef, useState } from "react";
import { useConvexAuth, usePaginatedQuery, useQuery } from "convex/react";
import {
  ArrowLeft,
  ChevronRight,
  Filter,
  MessageSquareText,
  PanelLeft,
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
import { getFindingSeverityClasses } from "@/app/components/findings/FindingCard";
import { FindingRelativeTime } from "@/app/components/findings/FindingTime";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { navigateToAuth } from "@/app/hooks/useTauri";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import { cn } from "@/lib/utils";
import type {
  FindingSeverity,
  FindingSourceChat,
  FindingSummary,
} from "@/types/finding";

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

const getFindingsHref = ({
  search,
  severity,
  chatId,
  findingId,
}: {
  search: string;
  severity: "all" | FindingSeverity;
  chatId: string;
  findingId: string | null;
}) => {
  const params = new URLSearchParams();
  if (search) params.set("q", search);
  if (severity !== "all") params.set("severity", severity);
  if (chatId !== "all") params.set("chat", chatId);
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
  const [chatId, setChatId] = useState(() => searchParams.get("chat") ?? "all");
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(
    () => searchParams.get("finding"),
  );
  const selectedFindingTriggerRef = useRef<HTMLAnchorElement | null>(null);

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
      setSearch(params.get("q") ?? "");
      setSeverity(getSeverityFilter(params.get("severity")));
      setChatId(params.get("chat") ?? "all");
      setSelectedFindingId(params.get("finding"));
    };

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
        chatId,
        findingId: selectedFindingId,
      }),
    );
  }, [chatId, deferredSearch, selectedFindingId, severity]);

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
          ...(chatId !== "all" ? { chatId } : {}),
        }
      : "skip",
    { initialNumItems: 25 },
  );
  const sourceChats = useQuery(
    api.findings.getFindingSourceChats,
    isAuthenticated ? {} : "skip",
  ) as FindingSourceChat[] | undefined;
  const findings = (findingsQuery.results ?? []) as FindingSummary[];
  const showSourceChatFilter =
    chatId !== "all" || (sourceChats?.length ?? 0) >= 2;
  const hasActiveFilters =
    Boolean(deferredSearch) || severity !== "all" || chatId !== "all";
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

  const selectFinding = (findingId: string, trigger: HTMLAnchorElement) => {
    selectedFindingTriggerRef.current = trigger;
    setSelectedFindingId(findingId);
    updateFindingsHistory(
      getFindingsHref({
        search: deferredSearch,
        severity,
        chatId,
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
        chatId,
        findingId: null,
      }),
    );
  };

  const startFirstTest = () => {
    closeSidebar();
    initializeNewChat();
    setTemporaryChatsEnabled(false);
    setChatMode("agent");
    router.push("/");
  };

  const clearFilters = () => {
    setSearch("");
    setSeverity("all");
    setChatId("all");
    updateFindingsHistory(
      getFindingsHref({
        search: "",
        severity: "all",
        chatId: "all",
        findingId: selectedFindingId,
      }),
    );
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
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1440px]">
            {findings.length > 0 ? (
              <section
                aria-label="Findings overview"
                className="border-b border-border px-4 py-5 sm:px-6"
              >
                <dl className="grid grid-cols-2 gap-5 xl:grid-cols-[0.7fr_1.6fr_0.7fr_1fr] xl:gap-8">
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
                      Source Chats
                    </dt>
                    <dd className="mt-1 text-xl font-semibold tabular-nums text-foreground">
                      {sourceChats?.length ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      Validation Standard
                    </dt>
                    <dd className="mt-1 flex items-center gap-2 text-sm font-medium text-foreground">
                      <ShieldCheck
                        className="size-4 text-emerald-500"
                        aria-hidden="true"
                      />
                      Evidence + working PoC
                    </dd>
                  </div>
                </dl>
              </section>
            ) : null}

            <div className="grid min-h-0 gap-6 p-4 sm:p-6 lg:grid-cols-[240px_minmax(0,1fr)] lg:gap-8">
              <aside aria-labelledby="finding-filters-heading">
                <div className="rounded-xl border border-border bg-muted/10 p-4 lg:sticky lg:top-6">
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
                          placeholder="Title, target, CVE, or CWE…"
                          className="pl-9"
                          aria-label="Search findings"
                        />
                      </div>
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
                              chatId,
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

                    {showSourceChatFilter ? (
                      <div className="space-y-1.5">
                        <span className="text-xs font-medium text-muted-foreground">
                          Source Chat
                        </span>
                        <Select
                          value={chatId}
                          onValueChange={(value) => {
                            setChatId(value);
                            updateFindingsHistory(
                              getFindingsHref({
                                search: deferredSearch,
                                severity,
                                chatId: value,
                                findingId: selectedFindingId,
                              }),
                            );
                          }}
                        >
                          <SelectTrigger
                            className="w-full"
                            aria-label="Filter by source chat"
                          >
                            <SelectValue placeholder="All source chats" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">
                              All source chats
                            </SelectItem>
                            {(sourceChats ?? []).map((chat) => (
                              <SelectItem
                                key={chat.chat_id}
                                value={chat.chat_id}
                              >
                                {chat.chat_title}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ) : null}
                  </div>
                </div>
              </aside>

              <section
                className="min-w-0"
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
                      <Button onClick={startFirstTest}>
                        Start your first security test
                      </Button>
                    )}
                  </div>
                ) : (
                  <>
                    <div
                      className="hidden grid-cols-[minmax(260px,1.5fr)_minmax(170px,0.8fr)_minmax(130px,0.7fr)_130px_90px_20px] items-center gap-4 px-4 pb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground xl:grid"
                      aria-hidden="true"
                    >
                      <div>Finding</div>
                      <div>Endpoint</div>
                      <div>Source Chat</div>
                      <div>Risk</div>
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
                              chatId,
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
                              "group block min-w-0 rounded-xl border border-border bg-card/30 p-4 text-left shadow-sm transition-[background-color,border-color] hover:border-foreground/15 hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring xl:grid xl:grid-cols-[minmax(260px,1.5fr)_minmax(170px,0.8fr)_minmax(130px,0.7fr)_130px_90px_20px] xl:items-center xl:gap-4",
                              selectedFindingId === finding.finding_id &&
                                "border-foreground/20 bg-muted/40",
                            )}
                          >
                            <div className="min-w-0">
                              <div className="line-clamp-2 text-sm font-medium leading-5 text-foreground xl:truncate">
                                {finding.title}
                              </div>
                              <div
                                className="mt-1 truncate font-mono text-xs text-muted-foreground"
                                translate="no"
                              >
                                {finding.target}
                              </div>
                              {finding.endpoint &&
                              finding.endpoint !== finding.target ? (
                                <div
                                  className="mt-1 flex min-w-0 items-center gap-1.5 font-mono text-xs text-foreground/70 xl:hidden"
                                  translate="no"
                                >
                                  <span className="truncate">
                                    {finding.endpoint}
                                  </span>
                                </div>
                              ) : null}
                            </div>

                            <div
                              className="hidden min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground xl:flex"
                              translate="no"
                            >
                              <span className="truncate">
                                {finding.endpoint === finding.target
                                  ? "Same as target"
                                  : (finding.endpoint ?? "Target-wide")}
                              </span>
                            </div>

                            <div className="mt-3 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground xl:mt-0">
                              <MessageSquareText
                                className="size-3.5 shrink-0"
                                aria-hidden="true"
                              />
                              <span className="truncate">
                                {finding.chat_title}
                              </span>
                            </div>

                            <div className="mt-3 flex items-center justify-between gap-3 xl:mt-0 xl:block">
                              <span
                                className={cn(
                                  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-1 text-[11px] font-semibold uppercase",
                                  getFindingSeverityClasses(finding.severity),
                                )}
                              >
                                {finding.severity}
                                <span className="opacity-50" aria-hidden="true">
                                  ·
                                </span>
                                <span className="tabular-nums">
                                  {finding.cvss_score.toFixed(1)}
                                </span>
                              </span>
                              <span className="text-xs tabular-nums text-muted-foreground xl:hidden">
                                <FindingRelativeTime
                                  timestamp={finding.created_at}
                                />
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
            <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3 sm:px-5">
              <DialogClose asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Back to findings"
                  className="sm:hidden"
                >
                  <ArrowLeft className="size-5" aria-hidden="true" />
                </Button>
              </DialogClose>
              <DialogTitle className="flex-1 text-base">
                Vulnerability Report
              </DialogTitle>
              <DialogClose asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Close finding"
                  className="hidden sm:inline-flex"
                >
                  <X className="size-5" aria-hidden="true" />
                </Button>
              </DialogClose>
            </div>
            <div className="min-h-0 flex-1">
              <FindingDetail
                findingId={selectedFindingId}
                surface="findings_page"
                onDeleted={clearSelectedFinding}
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
