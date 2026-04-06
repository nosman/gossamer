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

export interface LogContentBlock {
  contentType: string;
  contentIndex: number;
  text: string | null;
  thinking: string | null;
  toolUseId: string | null;
  toolName: string | null;
  toolInput: unknown | null;
  toolResultContent: string | null;
  isError: boolean | null;
  imageData: string | null;
  imageMediaType: string | null;
}

export interface LogEventItem {
  id: number;
  uuid: string | null;
  sessionId: string | null;
  parentUuid: string | null;
  type: string;
  timestamp: string | null;
  cwd: string | null;
  gitBranch: string | null;
  slug: string | null;
  isSidechain: boolean | null;
  toolUseId: string | null;
  parentToolUseId: string | null;
  contents: LogContentBlock[];
  usage: {
    model: string | null;
    stopReason: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  } | null;
  hookProgress: { type: string | null; hookEvent: string | null; hookName: string | null; command: string | null; } | null;
  systemData: { subtype: string | null; hookCount: number | null; stopReason: string | null; preventedContinuation: boolean | null; level: string | null; durationMs: number | null; } | null;
}

export async function fetchSession(id: string): Promise<Session> {
  const res = await fetch(`${API_BASE()}/sessions/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<Session>;
}

export interface Checkpoint {
  checkpointId: string;
  branch: string | null;
  createdAt: string | null;
  filesTouched: string[];
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    apiCallCount: number;
  } | null;
}

export async function fetchCheckpoints(sessionId: string): Promise<Checkpoint[]> {
  const res = await fetch(`${API_BASE()}/v2/sessions/${encodeURIComponent(sessionId)}/checkpoints`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<Checkpoint[]>;
}

export async function fetchLogEvents(id: string): Promise<LogEventItem[]> {
  const res = await fetch(`${API_BASE()}/v2/sessions/${encodeURIComponent(id)}/log-events`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<LogEventItem[]>;
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
