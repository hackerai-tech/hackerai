"use client";

import React, { useState, useMemo } from "react";
import { ComputerCodeBlock } from "./ComputerCodeBlock";

type ViewMode = "diff" | "original" | "modified";

interface DiffViewProps {
  originalContent: string;
  modifiedContent: string;
  language: string;
  wrap?: boolean;
}

interface DiffLine {
  type: "unchanged" | "added" | "removed";
  content: string;
}

/**
 * Compute a simple line-based diff between two strings using LCS algorithm
 */
const computeDiff = (original: string, modified: string): DiffLine[] => {
  const originalLines = original.split("\n");
  const modifiedLines = modified.split("\n");
  const lcs = computeLCS(originalLines, modifiedLines);

  const result: DiffLine[] = [];
  let origIdx = 0;
  let modIdx = 0;
  let lcsIdx = 0;

  while (origIdx < originalLines.length || modIdx < modifiedLines.length) {
    if (lcsIdx < lcs.length) {
      // Output removed lines (in original but not in LCS at this point)
      while (
        origIdx < originalLines.length &&
        originalLines[origIdx] !== lcs[lcsIdx]
      ) {
        result.push({ type: "removed", content: originalLines[origIdx] });
        origIdx++;
      }

      // Output added lines (in modified but not in LCS at this point)
      while (
        modIdx < modifiedLines.length &&
        modifiedLines[modIdx] !== lcs[lcsIdx]
      ) {
        result.push({ type: "added", content: modifiedLines[modIdx] });
        modIdx++;
      }

      // Output unchanged line (in LCS)
      if (origIdx < originalLines.length && modIdx < modifiedLines.length) {
        result.push({ type: "unchanged", content: originalLines[origIdx] });
        origIdx++;
        modIdx++;
        lcsIdx++;
      }
    } else {
      // Output remaining removed lines
      while (origIdx < originalLines.length) {
        result.push({ type: "removed", content: originalLines[origIdx] });
        origIdx++;
      }

      // Output remaining added lines
      while (modIdx < modifiedLines.length) {
        result.push({ type: "added", content: modifiedLines[modIdx] });
        modIdx++;
      }
    }
  }

  return result;
};

/**
 * Compute Longest Common Subsequence of two arrays of strings
 */
const computeLCS = (a: string[], b: string[]): string[] => {
  const m = a.length;
  const n = b.length;

  // Create DP table
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  // Fill DP table
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find LCS
  const lcs: string[] = [];
  let i = m;
  let j = n;

  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      lcs.unshift(a[i - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return lcs;
};

export const DiffView: React.FC<DiffViewProps> = ({
  originalContent,
  modifiedContent,
  language,
  wrap = true,
}) => {
  const [viewMode, setViewMode] = useState<ViewMode>("diff");

  const diffLines = useMemo(
    () => computeDiff(originalContent, modifiedContent),
    [originalContent, modifiedContent],
  );

  const tabs: Array<{ id: ViewMode; label: string }> = [
    { id: "diff", label: "Diff" },
    { id: "original", label: "Original" },
    { id: "modified", label: "Modified" },
  ];

  const handleTabChange = (tab: ViewMode) => {
    setViewMode(tab);
  };

  const handleTabKeyDown = (e: React.KeyboardEvent, tab: ViewMode) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setViewMode(tab);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Tab Buttons */}
      <div className="flex gap-1 px-3 py-2 border-b border-border/30 bg-muted/20">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => handleTabChange(tab.id)}
            onKeyDown={(e) => handleTabKeyDown(e, tab.id)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
              viewMode === tab.id
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
            }`}
            tabIndex={0}
            aria-selected={viewMode === tab.id}
            role="tab"
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-auto">
        {viewMode === "diff" && (
          <DiffContent diffLines={diffLines} wrap={wrap} />
        )}
        {viewMode === "original" && (
          <ComputerCodeBlock
            language={language}
            wrap={wrap}
            showButtons={false}
          >
            {originalContent}
          </ComputerCodeBlock>
        )}
        {viewMode === "modified" && (
          <ComputerCodeBlock
            language={language}
            wrap={wrap}
            showButtons={false}
          >
            {modifiedContent}
          </ComputerCodeBlock>
        )}
      </div>
    </div>
  );
};

interface DiffContentProps {
  diffLines: DiffLine[];
  wrap: boolean;
}

const DiffContent: React.FC<DiffContentProps> = ({ diffLines, wrap }) => {
  if (diffLines.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        No changes detected
      </div>
    );
  }

  return (
    <div className="shiki not-prose relative h-full w-full bg-transparent overflow-hidden">
      <div className="h-full w-full overflow-auto bg-background">
        <pre
          className={`shiki not-prose relative bg-transparent text-sm font-[450] text-card-foreground h-full w-full px-[0.5em] py-[0.5em] rounded-none m-0 min-h-full min-w-0 ${
            wrap
              ? "whitespace-pre-wrap break-words word-break-break-word"
              : "whitespace-pre overflow-x-auto"
          }`}
        >
          <code className="bg-transparent">
            {diffLines.map((line, index) => {
              const textClass =
                line.type === "added"
                  ? "text-green-600 dark:text-green-400"
                  : line.type === "removed"
                    ? "text-red-600 dark:text-red-400"
                    : "";

              const bgClass =
                line.type === "added"
                  ? "bg-green-500/10 dark:bg-green-500/15"
                  : line.type === "removed"
                    ? "bg-red-500/10 dark:bg-red-500/15"
                    : "";

              const className =
                textClass && bgClass ? `${textClass} ${bgClass}` : "";

              return (
                <span key={index} className={className}>
                  {line.content || " "}
                  {index < diffLines.length - 1 ? "\n" : ""}
                </span>
              );
            })}
          </code>
        </pre>
      </div>
    </div>
  );
};

export default DiffView;
