"use client";

import { useDeferredValue, useEffect, useRef, useState } from "react";
import { useConvexAuth, usePaginatedQuery, useQuery } from "convex/react";
import { formatDistanceToNow } from "date-fns";
import { ArrowLeft, PanelLeft, Search, ShieldAlert } from "lucide-react";
import { useRouter } from "next/navigation";
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
import { useGlobalState } from "@/app/contexts/GlobalState";
import { useIsMobile } from "@/hooks/use-mobile";
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

export default function FindingsPage() {
  const router = useRouter();
  const { isLoading, isAuthenticated } = useConvexAuth();
  const {
    setChatSidebarOpen,
    closeSidebar,
    initializeNewChat,
    setChatMode,
    setTemporaryChatsEnabled,
  } = useGlobalState();
  const isMobile = useIsMobile();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search.trim());
  const [severity, setSeverity] = useState<"all" | FindingSeverity>("all");
  const [chatId, setChatId] = useState("all");
  const [selectedFindingId, setSelectedFindingId] = useState<string | null>(
    null,
  );
  const selectedFindingTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!isLoading && !isAuthenticated) navigateToAuth("/login");
  }, [isAuthenticated, isLoading]);

  useEffect(() => {
    if (!isAuthenticated) return;
    captureAuthenticatedEvent("findings_page_viewed");
  }, [isAuthenticated]);

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
  const hasActiveFilters =
    Boolean(deferredSearch) || severity !== "all" || chatId !== "all";

  const selectFinding = (findingId: string, trigger: HTMLButtonElement) => {
    selectedFindingTriggerRef.current = trigger;
    setSelectedFindingId(findingId);
    closeSidebar();
    captureAuthenticatedEvent("finding_viewed", { surface: "findings_page" });
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
      <main
        className={cn(
          "flex min-w-0 flex-1 flex-col",
          selectedFindingId && isMobile === false && "border-r border-border",
        )}
      >
        <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3 sm:px-6">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setChatSidebarOpen(true)}
            aria-label="Open navigation"
          >
            <PanelLeft className="size-5" />
          </Button>
          <div className="min-w-0 flex-1">
            <h1 className="text-lg font-semibold text-foreground">Findings</h1>
            <p className="hidden text-xs text-muted-foreground sm:block">
              Confirmed vulnerabilities saved by Agent
            </p>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="grid shrink-0 gap-2 border-b border-border p-4 sm:grid-cols-[minmax(220px,1fr)_160px_220px] sm:px-6">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search title, target, endpoint, CVE, or CWE"
                className="pl-9"
                aria-label="Search findings"
              />
            </div>
            <Select
              value={severity}
              onValueChange={(value) =>
                setSeverity(value as "all" | FindingSeverity)
              }
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
            <Select value={chatId} onValueChange={setChatId}>
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
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {findingsQuery.status === "LoadingFirstPage" ? (
              <div className="flex h-48 items-center justify-center text-sm text-muted-foreground">
                Loading findings…
              </div>
            ) : findings.length === 0 ? (
              <div className="flex h-full min-h-64 flex-col items-center justify-center gap-3 p-8 text-center">
                <div className="flex size-12 items-center justify-center rounded-xl border border-border bg-muted/30">
                  <ShieldAlert className="size-6 text-muted-foreground" />
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
              <div className="divide-y divide-border">
                {findings.map((finding) => (
                  <button
                    type="button"
                    key={finding.finding_id}
                    onClick={(event) =>
                      selectFinding(finding.finding_id, event.currentTarget)
                    }
                    className={cn(
                      "grid w-full gap-2 px-4 py-4 text-left transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:grid-cols-[100px_minmax(180px,1.5fr)_minmax(160px,1fr)_minmax(130px,0.8fr)_100px] sm:items-center sm:px-6",
                      selectedFindingId === finding.finding_id && "bg-muted/40",
                    )}
                  >
                    <div className="flex items-center gap-2 sm:block">
                      <span
                        className={cn(
                          "inline-flex rounded-md border px-2 py-1 text-[11px] font-semibold uppercase",
                          getFindingSeverityClasses(finding.severity),
                        )}
                      >
                        {finding.severity}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground sm:mt-1 sm:block">
                        CVSS {finding.cvss_score.toFixed(1)}
                      </span>
                    </div>
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-foreground">
                        {finding.title}
                      </div>
                    </div>
                    <div className="min-w-0 font-mono text-xs text-muted-foreground">
                      <div className="truncate">{finding.target}</div>
                      {finding.endpoint && (
                        <div className="mt-0.5 truncate">
                          {finding.endpoint}
                        </div>
                      )}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {finding.chat_title}
                    </div>
                    <div className="text-xs text-muted-foreground sm:text-right">
                      {formatDistanceToNow(new Date(finding.created_at), {
                        addSuffix: true,
                      })}
                    </div>
                  </button>
                ))}
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

      {selectedFindingId && isMobile === false && (
        <aside className="h-full min-w-0 flex-[1.15] bg-background">
          <FindingDetail
            findingId={selectedFindingId}
            surface="findings_page"
            onDeleted={() => setSelectedFindingId(null)}
          />
        </aside>
      )}

      {selectedFindingId && isMobile && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setSelectedFindingId(null);
          }}
        >
          <DialogContent
            showCloseButton={false}
            aria-describedby={undefined}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (selectedFindingTriggerRef.current?.isConnected) {
                selectedFindingTriggerRef.current.focus();
              }
            }}
            className="inset-0 h-dvh w-screen max-w-none translate-x-0 translate-y-0 gap-0 rounded-none border-0 p-0 shadow-none duration-0 sm:max-w-none"
          >
            <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
              <DialogClose asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Back to findings"
                >
                  <ArrowLeft className="size-5" />
                </Button>
              </DialogClose>
              <DialogTitle className="text-base">Finding</DialogTitle>
            </div>
            <div className="min-h-0 flex-1">
              <FindingDetail
                findingId={selectedFindingId}
                surface="findings_page"
                onDeleted={() => setSelectedFindingId(null)}
              />
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
