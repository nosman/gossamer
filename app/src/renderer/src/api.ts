export const API_BASE = "http://localhost:3000/api";
export const WS_URL = "ws://localhost:3000";

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
}

export interface Event {
  id: number;
  timestamp: string;
  event: string;
  sessionId: string;
  blocked: boolean;
  data: unknown;
  summary: string | null;
  keywords: string[];
}

export interface InteractionOverview {
  sessionId: string;
  summary: string;
  keywords: string[];
  startedAt: string;
  endedAt: string;
}

export async function fetchSessions(): Promise<Session[]> {
  const res = await fetch(`${API_BASE}/sessions`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<Session[]>;
}

export async function fetchSession(id: string): Promise<Session> {
  const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<Session>;
}

export async function fetchSessionOverview(id: string): Promise<InteractionOverview | null> {
  const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(id)}/overview`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<InteractionOverview>;
}

export async function fetchSessionEvents(id: string): Promise<Event[]> {
  const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(id)}/events`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<Event[]>;
}

export interface OpenItem {
  id: number;
  text: string;
  status: "open" | "in_progress" | "complete";
  subSessionId: string | null;
}

export interface CheckpointSummary {
  intent: string;
  outcome: string;
  repoLearnings: string[];
  codeLearnings: Array<{ path: string; finding: string }>;
  workflowLearnings: string[];
  friction: string[];
  openItems: OpenItem[];
}

export interface TokenUsage {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  apiCallCount: number;
}

export interface Checkpoint {
  id: number;
  checkpointId: string;
  branch: string | null;
  cliVersion: string | null;
  strategy: string | null;
  checkpointsCount: number;
  createdAt: string | null;
  filesTouched: string[];
  tokenUsage: TokenUsage | null;
  sessionCount: number;
  summary: CheckpointSummary | null;
}

export interface CheckpointMessage {
  id: number;
  uuid: string;
  sessionId: string;
  parentUuid: string | null;
  type: string;
  timestamp: string | null;
  gitBranch: string | null;
  slug: string | null;
  planContent: string | null;
  toolUseId: string | null;
  parentToolUseId: string | null;
  data: unknown;
}

export async function fetchCheckpoint(id: string): Promise<Checkpoint> {
  const res = await fetch(`${API_BASE}/v2/checkpoints/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<Checkpoint>;
}

export async function fetchCheckpoints(): Promise<Checkpoint[]> {
  const res = await fetch(`${API_BASE}/v2/checkpoints`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<Checkpoint[]>;
}

export async function fetchCheckpointMessages(checkpointId: string): Promise<CheckpointMessage[]> {
  const res = await fetch(`${API_BASE}/checkpoints/${encodeURIComponent(checkpointId)}/messages`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<CheckpointMessage[]>;
}

// Returned by GET /api/sessions/:id/checkpoints — session-scoped view of a checkpoint
export interface SessionCheckpoint {
  checkpointId: string;
  branch: string | null;
  cliVersion: string | null;
  filesTouched: string[];
  tokenUsage: TokenUsage | null;
  createdAt: string | null;
  summary: CheckpointSummary | null;
}

export async function fetchSessionCheckpoints(id: string): Promise<SessionCheckpoint[]> {
  const res = await fetch(`${API_BASE}/v2/sessions/${encodeURIComponent(id)}/checkpoints`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<SessionCheckpoint[]>;
}

export async function updateOpenItemStatus(
  id: number,
  status: "open" | "in_progress" | "complete",
  subSessionId?: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/open-items/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, ...(subSessionId !== undefined ? { subSessionId } : {}) }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function spawnSession(prompt: string, cwd: string, openItemIds?: number[]): Promise<void> {
  const res = await fetch(`${API_BASE}/sessions/spawn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, cwd, openItemIds }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export function subscribeToUpdates(onUpdate: () => void): () => void {
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let delay = 1000;

  function connect() {
    if (closed) return;
    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      delay = 1000; // reset backoff on successful connection
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string) as { type: string };
        if (msg.type === "sessions_updated") onUpdate();
      } catch {
        // ignore malformed messages
      }
    };

    ws.onclose = () => {
      if (closed) return;
      timer = setTimeout(() => {
        delay = Math.min(delay * 2, 30000);
        connect();
      }, delay);
    };

    ws.onerror = () => {
      ws?.close();
    };
  }

  connect();

  return () => {
    closed = true;
    if (timer !== null) clearTimeout(timer);
    ws?.close();
  };
}
