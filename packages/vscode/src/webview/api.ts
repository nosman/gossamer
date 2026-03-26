// HTTP/WebSocket API for the VS Code webview.
// The port is injected by GossamerPanel into window.__GOSSAMER_PORT__.

declare global {
  interface Window { __GOSSAMER_PORT__: number; }
}

const port = () => window.__GOSSAMER_PORT__;
const API_BASE = () => `http://localhost:${port()}/api`;
const WS_URL   = () => `ws://localhost:${port()}`;

export interface Session {
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  cwd: string;
  repoRoot: string | null;
  repoName: string | null;
  parentSessionId: string | null;
  childSessionIds: string[];
  gitUserName: string | null;
  gitUserEmail: string | null;
  prompt: string | null;
  summary: string | null;
  keywords: string[];
  branch: string | null;
  intent: string | null;
  isLive: boolean;
}

export async function fetchSessions(includeArchived = false): Promise<Session[]> {
  const qs  = includeArchived ? "?archived=1" : "";
  const res = await fetch(`${API_BASE()}/sessions${qs}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<Session[]>;
}

export async function archiveSession(sessionId: string): Promise<void> {
  const res = await fetch(`${API_BASE()}/sessions/${encodeURIComponent(sessionId)}/archive`, { method: "POST" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function unarchiveSession(sessionId: string): Promise<void> {
  const res = await fetch(`${API_BASE()}/sessions/${encodeURIComponent(sessionId)}/archive`, { method: "DELETE" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function syncSessions(): Promise<void> {
  const res = await fetch(`${API_BASE()}/sessions/sync`, { method: "POST" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export function subscribeToUpdates(onUpdate: () => void): () => void {
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let delay  = 1000;

  function connect() {
    if (closed) return;
    ws = new WebSocket(WS_URL());
    ws.onopen  = () => { delay = 1000; };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string) as { type: string };
        if (msg.type === "sessions_updated") onUpdate();
      } catch { /* ignore */ }
    };
    ws.onclose = () => {
      if (closed) return;
      timer = setTimeout(() => { delay = Math.min(delay * 2, 30000); connect(); }, delay);
    };
    ws.onerror = () => ws?.close();
  }

  connect();
  return () => {
    closed = true;
    if (timer !== null) clearTimeout(timer);
    ws?.close();
  };
}
