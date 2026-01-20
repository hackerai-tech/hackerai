"use client";

import React, { useState } from "react";
import { DiffEditor } from "@monaco-editor/react";
import { ComputerCodeBlock } from "./ComputerCodeBlock";

type ViewMode = "diff" | "original" | "modified";

interface DiffViewProps {
  originalContent: string;
  modifiedContent: string;
  language: string;
  wrap?: boolean;
}

export const DiffView: React.FC<DiffViewProps> = ({
  originalContent,
  modifiedContent,
  language,
  wrap = true,
}) => {
  const [viewMode, setViewMode] = useState<ViewMode>("diff");

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

  // Map common language names to Monaco language IDs
  const getMonacoLanguage = (lang: string): string => {
    const languageMap: Record<string, string> = {
      js: "javascript",
      ts: "typescript",
      py: "python",
      rb: "ruby",
      yml: "yaml",
      md: "markdown",
      sh: "shell",
      bash: "shell",
      zsh: "shell",
      txt: "plaintext",
      text: "plaintext",
    };
    return languageMap[lang.toLowerCase()] || lang.toLowerCase();
  };

  return (
    <div className="flex flex-col h-full">
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

      <div className="flex-1 min-h-0 overflow-hidden bg-background">
        {viewMode === "diff" && (
          <>
            <style>{`
              .original-in-monaco-diff-editor { display: none !important; }
              .monaco-editor,
              .monaco-editor .margin,
              .monaco-editor-background,
              .monaco-editor .inputarea.ime-input {
                background-color: transparent !important;
              }
              .monaco-editor .lines-content {
                background-color: transparent !important;
              }
            `}</style>
            <DiffEditor
              original={originalContent}
              modified={modifiedContent}
              language={getMonacoLanguage(language)}
              theme="vs-dark"
              options={{
                readOnly: true,
                renderSideBySide: false,
                wordWrap: wrap ? "on" : "off",
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                lineNumbers: "off",
                glyphMargin: false,
                folding: false,
                lineDecorationsWidth: 0,
                lineNumbersMinChars: 0,
                renderOverviewRuler: false,
                overviewRulerBorder: false,
                hideCursorInOverviewRuler: true,
                scrollbar: {
                  vertical: "auto",
                  horizontal: "auto",
                  verticalScrollbarSize: 6,
                  horizontalScrollbarSize: 6,
                },
                fontSize: 13,
                fontFamily: "Menlo, Monaco, 'Courier New', monospace",
                padding: { top: 8, bottom: 8 },
              }}
            />
          </>
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

export default DiffView;
