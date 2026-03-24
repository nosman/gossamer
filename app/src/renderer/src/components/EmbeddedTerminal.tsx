import React, { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Box, ActionIcon, Text, Group } from "@mantine/core";
import "@xterm/xterm/css/xterm.css";

interface Props {
  cwd: string;
  /** Initial height in px for the terminal panel (excluding header). */
  defaultHeight?: number;
  /** Command to type into the shell after connection is established. */
  command?: string;
}

const MIN_HEIGHT = 80;
const HEADER_H = 28;

export function EmbeddedTerminal({ cwd, defaultHeight = 220, command }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [height, setHeight] = useState(defaultHeight);
  const dragState = useRef<{ startY: number; startH: number } | null>(null);

  // ── Terminal lifecycle ──────────────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.4,
      theme: {
        background: "#0d1117",
        foreground: "#e6edf3",
        cursor: "#e6edf3",
        selectionBackground: "#264f78",
        black: "#0d1117",
        red: "#ff7b72",
        green: "#3fb950",
        yellow: "#d29922",
        blue: "#58a6ff",
        magenta: "#bc8cff",
        cyan: "#39d353",
        white: "#b1bac4",
        brightBlack: "#6e7681",
        brightRed: "#ffa198",
        brightGreen: "#56d364",
        brightYellow: "#e3b341",
        brightBlue: "#79c0ff",
        brightMagenta: "#d2a8ff",
        brightCyan: "#56d364",
        brightWhite: "#f0f6fc",
      },
      cursorBlink: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    termRef.current = term;
    fitRef.current = fitAddon;

    const ws = new WebSocket(
      `ws://localhost:3000?type=terminal&cwd=${encodeURIComponent(cwd)}`,
    );
    wsRef.current = ws;

    ws.onopen = () => {
      const { cols, rows } = term;
      ws.send(JSON.stringify({ type: "resize", cols, rows }));
      if (command) {
        setTimeout(() => {
          ws.send(JSON.stringify({ type: "data", data: command + "\n" }));
        }, 300);
      }
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string) as { type: string; data?: string };
        if (msg.type === "data" && msg.data) term.write(msg.data, () => term.scrollToBottom());
      } catch { /* ignore */ }
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "data", data }));
    });

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
    });

    return () => {
      term.dispose();
      ws.close();
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
  }, [cwd]);

  // ── Refit when height changes or terminal is restored ───────────────────
  useEffect(() => {
    if (minimized) return;
    const t = setTimeout(() => { fitRef.current?.fit(); termRef.current?.scrollToBottom(); }, 16);
    return () => clearTimeout(t);
  }, [height, minimized]);

  // ── Resize drag handle ──────────────────────────────────────────────────
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragState.current = { startY: e.clientY, startH: height };

    const onMove = (ev: MouseEvent) => {
      if (!dragState.current) return;
      const delta = dragState.current.startY - ev.clientY; // drag up = bigger terminal
      const next = Math.max(MIN_HEIGHT, dragState.current.startH + delta);
      setHeight(next);
    };
    const onUp = () => {
      dragState.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [height]);

  return (
    <Box
      style={{
        display: "flex",
        flexDirection: "column",
        flexShrink: 0,
        borderTop: "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
      }}
    >
      {/* Drag handle (above the header) */}
      {!minimized && (
        <Box
          onMouseDown={onDragStart}
          style={{
            height: 4,
            cursor: "ns-resize",
            backgroundColor: "transparent",
            flexShrink: 0,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "var(--mantine-color-indigo-6)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = "transparent"; }}
        />
      )}

      {/* Header bar */}
      <Group
        gap={6}
        px={10}
        style={{
          height: HEADER_H,
          flexShrink: 0,
          backgroundColor: "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-7))",
          borderTop: "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
          cursor: "default",
          userSelect: "none",
        }}
      >
        <Text size="xs" c="dimmed" ff="monospace" style={{ flex: 1 }}>
          ⬡ terminal
        </Text>
        <ActionIcon
          size="xs"
          variant="subtle"
          color="gray"
          title={minimized ? "Expand terminal" : "Minimize terminal"}
          onClick={() => setMinimized((m) => !m)}
        >
          {minimized ? "▲" : "▼"}
        </ActionIcon>
      </Group>

      {/* xterm container — always mounted so the PTY connection survives minimize */}
      <Box
        style={{
          height: minimized ? 0 : height,
          overflow: "hidden",
          backgroundColor: "#0d1117",
          padding: minimized ? 0 : "4px 4px 4px 2px",
        }}
      >
        <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
      </Box>
    </Box>
  );
}
