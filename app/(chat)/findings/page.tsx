"use client";

import Link from "next/link";
import { Suspense, useDeferredValue, useEffect, useRef, useState } from "react";
import { useConvexAuth, usePaginatedQuery, useQuery } from "convex/react";
import {
  ArrowLeft,
  ChevronRight,
  MessageSquareText,
  PanelLeft,
  Search,
  ShieldAlert,
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
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold text-foreground">Findings</h1>
            <p className="hidden text-xs text-muted-foreground sm:block">
              Validated vulnerabilities with evidence and working PoCs
            </p>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          <div
            className={cn(
              "grid shrink-0 gap-2 border-b border-border bg-muted/10 p-4 sm:px-6",
              showSourceChatFilter
                ? "sm:grid-cols-[minmax(220px,1fr)_160px_220px]"
                : "sm:grid-cols-[minmax(220px,1fr)_160px]",
            )}
          >
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                name="finding-search"
                autoComplete="off"
                placeholder="Search title, target, endpoint, CVE, or CWE…"
                className="pl-9"
                aria-label="Search findings"
              />
            </div>
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
              <SelectTrigger aria-label="Filter by severity">
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
            {showSourceChatFilter ? (
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
                <SelectTrigger aria-label="Filter by source chat">
                  <SelectValue placeholder="All source chats" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All source chats</SelectItem>
                  {(sourceChats ?? []).map((chat) => (
                    <SelectItem key={chat.chat_id} value={chat.chat_id}>
                      {chat.chat_title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>

          {deferredSearch && (
            <div
              className="break-words border-b border-border px-4 py-2 text-xs text-muted-foreground sm:px-6"
              aria-live="polite"
            >
              Best matches for “{deferredSearch}”
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto">
            {findingsQuery.status === "LoadingFirstPage" ? (
              <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
                Loading findings…
              </div>
            ) : findings.length === 0 ? (
              <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 p-8 text-center">
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
              <div className="p-3 sm:p-6">
                <div className="overflow-hidden rounded-xl border border-border bg-card/30 shadow-sm">
                  <div
                    className="hidden grid-cols-[145px_minmax(220px,1.5fr)_minmax(210px,1fr)_minmax(140px,0.7fr)_110px_20px] items-center gap-4 border-b border-border bg-muted/30 px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground lg:grid"
                    aria-hidden="true"
                  >
                    <div>Risk</div>
                    <div>Finding</div>
                    <div>Affected Target</div>
                    <div>Source</div>
                    <div className="text-right">Found</div>
                    <div />
                  </div>
                  <ul className="divide-y divide-border" aria-label="Findings">
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
                            "group block min-w-0 p-4 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring lg:grid lg:grid-cols-[145px_minmax(220px,1.5fr)_minmax(210px,1fr)_minmax(140px,0.7fr)_110px_20px] lg:items-center lg:gap-4",
                            selectedFindingId === finding.finding_id &&
                              "bg-muted/40",
                          )}
                        >
                          <div className="flex items-center justify-between gap-3 lg:block">
                            <span
                              className={cn(
                                "inline-flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold uppercase",
                                getFindingSeverityClasses(finding.severity),
                              )}
                            >
                              {finding.severity}
                              <span className="opacity-50" aria-hidden="true">
                                ·
                              </span>
                              <span className="tabular-nums">
                                CVSS {finding.cvss_score.toFixed(1)}
                              </span>
                            </span>
                            <span className="text-xs tabular-nums text-muted-foreground lg:hidden">
                              <FindingRelativeTime
                                timestamp={finding.created_at}
                              />
                            </span>
                          </div>

                          <div className="mt-3 min-w-0 lg:mt-0">
                            <div className="line-clamp-2 text-sm font-medium leading-5 text-foreground lg:truncate">
                              {finding.title}
                            </div>
                            <div
                              className="mt-2 min-w-0 font-mono text-xs text-muted-foreground lg:hidden"
                              translate="no"
                            >
                              <div className="truncate">{finding.target}</div>
                              {finding.endpoint ? (
                                <div className="mt-1 truncate text-foreground/70">
                                  {finding.endpoint}
                                </div>
                              ) : null}
                            </div>
                          </div>

                          <div
                            className="hidden min-w-0 font-mono text-xs text-muted-foreground lg:block"
                            translate="no"
                          >
                            <div className="truncate">{finding.target}</div>
                            {finding.endpoint ? (
                              <div className="mt-1 truncate text-foreground/70">
                                {finding.endpoint}
                              </div>
                            ) : null}
                          </div>

                          <div className="mt-3 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground lg:mt-0">
                            <MessageSquareText
                              className="size-3.5 shrink-0"
                              aria-hidden="true"
                            />
                            <span className="truncate">
                              {finding.chat_title}
                            </span>
                          </div>

                          <div className="hidden text-right text-xs tabular-nums text-muted-foreground lg:block">
                            <FindingRelativeTime
                              timestamp={finding.created_at}
                            />
                          </div>

                          <ChevronRight
                            className="hidden size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground motion-reduce:transition-none lg:block"
                            aria-hidden="true"
                          />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
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
