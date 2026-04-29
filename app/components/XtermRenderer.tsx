"use client";

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

interface XtermRendererProps {
  bytes: string;
  className?: string;
  isStreaming?: boolean;
}

export function XtermRenderer({
  bytes,
  className,
  isStreaming = false,
}: XtermRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const previousLengthRef = useRef<number>(0);

  useEffect(() => {
    if (!containerRef.current) return;

    const terminal = new Terminal({
      cursorBlink: false,
      cursorStyle: "block",
      disableStdin: true,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      theme: {
        background: "#141414",
        foreground: "#e0e0e0",
        cursor: "#e0e0e0",
        cursorAccent: "#1a1a1a",
        selectionBackground: "#3a3a3a",
        black: "#1a1a1a",
        red: "#ff6b6b",
        green: "#69db7c",
        yellow: "#ffd43b",
        blue: "#74c0fc",
        magenta: "#da77f2",
        cyan: "#66d9e8",
        white: "#e0e0e0",
        brightBlack: "#5c5c5c",
        brightRed: "#ff8787",
        brightGreen: "#8ce99a",
        brightYellow: "#ffe066",
        brightBlue: "#91d5ff",
        brightMagenta: "#e599f7",
        brightCyan: "#99e9f2",
        brightWhite: "#ffffff",
      },
      scrollback: 1000,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    terminal.open(containerRef.current);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    previousLengthRef.current = 0;

    // Use ResizeObserver to detect container size changes (sidebar open/close)
    const resizeObserver = new ResizeObserver(() => {
      // Small delay to ensure container has final dimensions
      requestAnimationFrame(() => {
        fitAddon.fit();
      });
    });
    resizeObserver.observe(containerRef.current);

    // Initial fit after a brief delay to ensure container is laid out
    requestAnimationFrame(() => {
      fitAddon.fit();
    });

    return () => {
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      previousLengthRef.current = 0;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    if (!bytes) {
      terminal.clear();
      previousLengthRef.current = 0;
      return;
    }

    if (isStreaming) {
      const newContent = bytes.slice(previousLengthRef.current);
      if (newContent) {
        terminal.write(newContent);
      }
      previousLengthRef.current = bytes.length;
    } else {
      terminal.clear();
      terminal.write(bytes);
      previousLengthRef.current = bytes.length;
    }
  }, [bytes, isStreaming]);

  // Outer div paints the bg + padding (matches shiki's `[&_pre]:p-[1em]`),
  // inner div is the xterm host — fitAddon measures it after padding.
  return (
    <div
      className={className}
      style={{
        width: "100%",
        height: "100%",
        padding: "1em",
        backgroundColor: "#141414",
        boxSizing: "border-box",
        overflow: "hidden",
      }}
    >
      <div
        ref={containerRef}
        style={{ width: "100%", height: "100%", overflow: "hidden" }}
      />
    </div>
  );
}
