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
  /** true when this session is currently indexed in a shadow branch */
  isLive: boolean;
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
  /** Real LogEvent.id this synthetic event was derived from — set by logEventsToEvents. */
  _sourceLogEventId?: number;
  /** Additional LogEvent IDs for the same turn (e.g. separate thinking events). */
  _extraSourceLogEventIds?: number[];
  /** Original UUID from the JSONL log event this synthetic event was derived from. */
  _sourceUuid?: string;
}

export interface InteractionOverview {
  sessionId: string;
  summary: string;
  keywords: string[];
  startedAt: string;
  endedAt: string;
}

export interface RepoConfig {
  name: string;
  remote: string;
  localPath: string;
  dbPath: string;
}

export interface RepoStatus {
  name: string;
  localPath: string;
  remote: string;
  currentBranch: string | null;
  latestCheckpointId: string | null;
  gitUserName: string | null;
  gitUserEmail: string | null;
}

export async function fetchRepoStatuses(): Promise<RepoStatus[]> {
  const res = await fetch(`${API_BASE}/repos/status`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<RepoStatus[]>;
}

export async function fetchBranches(localPath: string): Promise<string[]> {
  const res = await fetch(`${API_BASE}/branches?localPath=${encodeURIComponent(localPath)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<string[]>;
}

export async function fetchRepos(): Promise<RepoConfig[]> {
  const res = await fetch(`${API_BASE}/repos`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<RepoConfig[]>;
}

export async function fetchCurrentRepo(): Promise<RepoConfig | null> {
  const res = await fetch(`${API_BASE}/repos/current`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<RepoConfig | null>;
}

export async function addRepo(repo: { name: string; remote: string; localPath: string }): Promise<RepoConfig> {
  const res = await fetch(`${API_BASE}/repos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(repo),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<RepoConfig>;
}

export async function deleteRepo(localPath: string): Promise<void> {
  const res = await fetch(`${API_BASE}/repos`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ localPath }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function fetchSessions(includeArchived = false): Promise<Session[]> {
  const qs = includeArchived ? "?archived=1" : "";
  const res = await fetch(`${API_BASE}/sessions${qs}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<Session[]>;
}

export async function archiveSession(sessionId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/archive`, { method: "POST" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function unarchiveSession(sessionId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/archive`, { method: "DELETE" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function syncSessions(): Promise<void> {
  const res = await fetch(`${API_BASE}/sessions/sync`, { method: "POST" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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
  status: "open" | "in_progress" | "complete" | "na";
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
  localPath: string | null;
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

export interface FileDiffStat {
  path: string;
  additions: number;
  deletions: number;
}

export async function fetchCheckpointDiff(checkpointId: string, localPath?: string | null): Promise<string | null> {
  const qs = localPath ? `?localPath=${encodeURIComponent(localPath)}` : "";
  const res = await fetch(`${API_BASE}/v2/checkpoints/${encodeURIComponent(checkpointId)}/diff${qs}`);
  if (!res.ok) return null;
  return res.text();
}

export async function fetchCheckpointDiffStats(checkpointId: string, localPath?: string | null): Promise<FileDiffStat[]> {
  const qs = localPath ? `?localPath=${encodeURIComponent(localPath)}` : "";
  const res = await fetch(`${API_BASE}/v2/checkpoints/${encodeURIComponent(checkpointId)}/diff-stats${qs}`);
  if (!res.ok) return [];
  return res.json() as Promise<FileDiffStat[]>;
}

export async function fetchCheckpoint(id: string, localPath?: string | null): Promise<Checkpoint> {
  const qs = localPath ? `?localPath=${encodeURIComponent(localPath)}` : "";
  const res = await fetch(`${API_BASE}/v2/checkpoints/${encodeURIComponent(id)}${qs}`);
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
  commitMessage: string | null;
  commitHash: string | null;
}

export async function fetchSessionCheckpoints(id: string): Promise<SessionCheckpoint[]> {
  const res = await fetch(`${API_BASE}/v2/sessions/${encodeURIComponent(id)}/checkpoints`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<SessionCheckpoint[]>;
}

export interface LogContentBlock {
  contentType: string;        // text | thinking | tool_use | tool_result
  contentIndex: number;
  text: string | null;
  thinking: string | null;
  toolUseId: string | null;
  toolName: string | null;
  toolInput: unknown | null;
  toolResultContent: string | null;
  isError: boolean | null;
}

export interface LogEventItem {
  id: number;
  uuid: string | null;
  sessionId: string | null;
  parentUuid: string | null;
  type: string;               // user | assistant | progress | system | file-history-snapshot
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
  hookProgress: {
    type: string | null;
    hookEvent: string | null;
    hookName: string | null;
    command: string | null;
  } | null;
  systemData: {
    subtype: string | null;
    hookCount: number | null;
    stopReason: string | null;
    preventedContinuation: boolean | null;
    level: string | null;
    durationMs: number | null;
  } | null;
}

export interface BranchLogEntry {
  checkpointId: string;
  sessionId: string;
  branch: string | null;
  createdAt: string | null;
  gitUserName: string | null;
  gitUserEmail: string | null;
  filesTouched: string[];
  tokenUsage: TokenUsage | null;
  summary: CheckpointSummary | null;
  commitMessage: string | null;
  commitHash: string | null;
}

export interface BranchLiveSession {
  sessionId: string;
  prompt: string | null;
}

export async function fetchBranchLog(localPath: string, branch: string, page = 0): Promise<{ entries: BranchLogEntry[]; hasMore: boolean; liveSession: BranchLiveSession | null }> {
  const res = await fetch(
    `${API_BASE}/branch-log?localPath=${encodeURIComponent(localPath)}&branch=${encodeURIComponent(branch)}&page=${page}`,
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<{ entries: BranchLogEntry[]; hasMore: boolean; liveSession: BranchLiveSession | null }>;
}

export async function fetchLogEvents(id: string): Promise<LogEventItem[]> {
  const res = await fetch(`${API_BASE}/v2/sessions/${encodeURIComponent(id)}/log-events`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<LogEventItem[]>;
}

export async function fetchCheckpointLogEvents(sessionId: string, checkpointId: string): Promise<LogEventItem[]> {
  const res = await fetch(`${API_BASE}/v2/sessions/${encodeURIComponent(sessionId)}/checkpoints/${encodeURIComponent(checkpointId)}/log-events`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<LogEventItem[]>;
}

export interface SearchResult {
  logContentId: number;
  logEventId: number;
  sessionId: string;
  timestamp: string | null;
  contentType: string;
  toolName: string | null;
  logEventType: string;
  gitUserName: string | null;
  gitUserEmail: string | null;
  snippet: string;
  rank: number;
}

export async function fetchSearch(query: string, limit = 50): Promise<SearchResult[]> {
  const res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(query)}&limit=${limit}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<SearchResult[]>;
}

export async function updateOpenItemStatus(
  id: number,
  status: "open" | "in_progress" | "complete" | "na",
  subSessionId?: string,
): Promise<void> {
  const res = await fetch(`${API_BASE}/open-items/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, ...(subSessionId !== undefined ? { subSessionId } : {}) }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function resumeSession(sessionId: string, cwd: string): Promise<void> {
  const res = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

export async function spawnSession(prompt: string, cwd: string, openItemIds?: number[], parentSessionId?: string): Promise<void> {
  const res = await fetch(`${API_BASE}/sessions/spawn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, cwd, openItemIds, parentSessionId }),
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
