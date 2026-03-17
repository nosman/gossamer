import React, { useEffect, useRef } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

declare global {
  interface Window {
    pty: {
      spawn: (id: string, options?: { cwd?: string }) => Promise<void>;
      write: (id: string, data: string) => void;
      resize: (id: string, cols: number, rows: number) => void;
      kill: (id: string) => void;
      onData: (id: string, cb: (data: string) => void) => () => void;
      onExit: (id: string, cb: () => void) => () => void;
    };
  }
}

interface TerminalProps {
  id: string;
  active: boolean;
  cwd?: string;
}

export function Terminal({ id, active, cwd }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const initializedRef = useRef(false);

  // Initialize only once the container is actually visible
  useEffect(() => {
    if (!active || initializedRef.current || !containerRef.current) return;
    initializedRef.current = true;

    const term = new XTerm({
      fontFamily: '"Menlo", "Monaco", "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      theme: {
        background: "#1a1b1e",
        foreground: "#c1c2c5",
        cursor: "#c1c2c5",
        black: "#1a1b1e",
        red: "#fa5252",
        green: "#40c057",
        yellow: "#fab005",
        blue: "#4dabf7",
        magenta: "#cc5de8",
        cyan: "#22b8cf",
        white: "#c1c2c5",
        brightBlack: "#5c5f66",
        brightRed: "#ff6b6b",
        brightGreen: "#69db7c",
        brightYellow: "#ffd43b",
        brightBlue: "#74c0fc",
        brightMagenta: "#da77f2",
        brightCyan: "#3bc9db",
        brightWhite: "#ffffff",
      },
    });

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);
    term.open(containerRef.current);
    fitAddon.fit();

    window.pty.spawn(id, { cwd }).then(() => {
      window.pty.resize(id, term.cols, term.rows);
    });

    const offData = window.pty.onData(id, (data) => term.write(data));
    const offExit = window.pty.onExit(id, () =>
      term.write("\r\n\x1b[2m[process exited]\x1b[0m\r\n")
    );
    term.onData((data) => window.pty.write(id, data));

    const observer = new ResizeObserver(() => {
      try {
        fitAddon.fit();
        window.pty.resize(id, term.cols, term.rows);
      } catch {}
    });
    observer.observe(containerRef.current);

    return () => {
      observer.disconnect();
      offData();
      offExit();
      window.pty.kill(id);
      fitAddonRef.current = null;
      term.dispose();
    };
  }, [active]);

  // Re-fit when navigating back to this terminal
  useEffect(() => {
    if (active && initializedRef.current && fitAddonRef.current) {
      requestAnimationFrame(() => {
        try { fitAddonRef.current?.fit(); } catch {}
      });
    }
  }, [active]);

  return (
    <div
      ref={containerRef}
      style={{
        width: "100%",
        height: "100%",
        backgroundColor: "#1a1b1e",
        padding: 8,
        boxSizing: "border-box",
      }}
    />
  );
}
