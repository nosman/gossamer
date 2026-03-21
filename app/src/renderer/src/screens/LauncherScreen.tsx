import React, { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { Box } from "@mantine/core";
import "@xterm/xterm/css/xterm.css";
import { WS_URL } from "../api";

interface Props {
  cwd: string;
  command: string;
}

export function LauncherScreen({ cwd, command }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
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

    const ro = new ResizeObserver(() => fitAddon.fit());
    ro.observe(containerRef.current);
    fitAddon.fit();

    const ws = new WebSocket(`${WS_URL}?type=terminal&cwd=${encodeURIComponent(cwd)}`);

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
        if (msg.type === "data" && msg.data) term.write(msg.data);
      } catch { /* ignore */ }
    };

    term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "data", data }));
    });

    term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "resize", cols, rows }));
    });

    return () => {
      ro.disconnect();
      term.dispose();
      ws.close();
    };
  }, [cwd, command]);

  return (
    <Box style={{ flex: 1, overflow: "hidden", backgroundColor: "#0d1117", padding: "4px 4px 4px 2px" }}>
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
    </Box>
  );
}
