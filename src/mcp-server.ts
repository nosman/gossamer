/**
 * Gossamer MCP tool factory.
 *
 * Creates a configured McpServer whose tools call the Gossamer HTTP API.
 * Transport is supplied by the caller (stdio for standalone, streamable-HTTP for embedded).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { get as httpGet } from "http";

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function httpGetRaw(baseUrl: string, path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpGet(`${baseUrl}${path}`, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if ((res.statusCode ?? 200) >= 400) {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          return;
        }
        resolve(body);
      });
    });
    req.on("error", reject);
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function httpGetJson<T>(baseUrl: string, path: string): Promise<T> {
  return httpGetRaw(baseUrl, path).then((body) => JSON.parse(body) as T);
}

// ── Utility ───────────────────────────────────────────────────────────────────

function formatAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createMcpServer(port: number): McpServer {
  const base = `http://localhost:${port}`;
  const getJson = <T>(path: string) => httpGetJson<T>(base, path);
  const getRaw  = (path: string)    => httpGetRaw(base, path);

  const server = new McpServer({ name: "gossamer", version: "1.0.0" });

  // ── Tool: search ────────────────────────────────────────────────────────────

  server.registerTool(
    "search",
    {
      description:
        "Full-text search across all Gossamer session chat history (user messages, AI responses, tool calls). " +
        "Returns matching sessions with a highlighted snippet. Supports SQLite FTS5 query syntax.",
      inputSchema: z.object({
        query: z.string().describe("Search query (FTS5 syntax supported)"),
        limit: z.number().int().min(1).max(100).optional().default(20)
          .describe("Maximum number of results (default 20, max 100)"),
      }),
    },
    async ({ query, limit }) => {
      const results = await getJson<Array<{
        sessionId: string;
        snippet: string;
        contentType: string;
        gitUserName: string | null;
      }>>(`/api/search?q=${encodeURIComponent(query)}&limit=${limit}`);

      if (results.length === 0) {
        return { content: [{ type: "text", text: "No results found." }] };
      }

      const bySession = new Map<string, typeof results>();
      for (const r of results) {
        const list = bySession.get(r.sessionId) ?? [];
        list.push(r);
        bySession.set(r.sessionId, list);
      }

      const lines: string[] = [`Found ${results.length} match(es) across ${bySession.size} session(s):\n`];
      for (const [sessionId, hits] of bySession) {
        const author = hits[0].gitUserName ? ` (${hits[0].gitUserName})` : "";
        lines.push(`Session ${sessionId.slice(0, 8)}${author}`);
        for (const h of hits) {
          const clean = h.snippet.replace(/«/g, "**").replace(/»/g, "**").trim();
          lines.push(`  [${h.contentType}] ${clean}`);
        }
        lines.push("");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ── Tool: list_sessions ─────────────────────────────────────────────────────

  server.registerTool(
    "list_sessions",
    {
      description:
        "List Gossamer sessions sorted by recency. " +
        "Use active_only to filter to sessions that are currently running.",
      inputSchema: z.object({
        active_only: z.boolean().optional().default(false)
          .describe("When true, only return sessions that are currently live/active"),
        limit: z.number().int().min(1).max(200).optional().default(50)
          .describe("Maximum sessions to return (default 50)"),
      }),
    },
    async ({ active_only, limit }) => {
      const sessions = await getJson<Array<{
        sessionId: string;
        cwd: string;
        repoName: string | null;
        intent: string | null;
        prompt: string | null;
        branch: string | null;
        updatedAt: string;
        isLive: boolean;
      }>>("/api/sessions");

      const filtered = active_only ? sessions.filter((s) => s.isLive) : sessions;
      const sliced   = filtered.slice(0, limit);

      if (sliced.length === 0) {
        return { content: [{ type: "text", text: active_only ? "No active sessions." : "No sessions found." }] };
      }

      const lines = sliced.map((s) => {
        const title = s.intent ?? s.prompt?.slice(0, 80) ?? s.sessionId.slice(0, 8);
        const ago   = formatAgo(s.updatedAt);
        const live  = s.isLive ? " [LIVE]" : "";
        return `${s.sessionId.slice(0, 8)}${live}  ${title}\n  repo: ${s.repoName ?? s.cwd}  branch: ${s.branch ?? "unknown"}  updated: ${ago}`;
      });

      return {
        content: [{
          type: "text",
          text: `${sliced.length} session(s)${active_only ? " (active)" : ""}:\n\n${lines.join("\n\n")}`,
        }],
      };
    },
  );

  // ── Tool: get_session ───────────────────────────────────────────────────────

  server.registerTool(
    "get_session",
    {
      description:
        "Get full details of a Gossamer session including metadata and recent conversation events " +
        "(user messages, assistant messages, tool calls/results).",
      inputSchema: z.object({
        session_id: z.string().describe("Session ID"),
        event_limit: z.number().int().min(1).max(500).optional().default(100)
          .describe("Maximum number of events to include, most recent first (default 100)"),
      }),
    },
    async ({ session_id, event_limit }) => {
      const [info, events] = await Promise.all([
        getJson<{
          sessionId: string;
          cwd: string;
          repoName: string | null;
          branch: string | null;
          intent: string | null;
          prompt: string | null;
          startedAt: string;
          updatedAt: string;
          isLive: boolean;
          gitUserName: string | null;
        }>(`/api/sessions/${encodeURIComponent(session_id)}`),
        getJson<Array<{
          type: string;
          content: string | null;
          toolName: string | null;
          toolInput: string | null;
          toolOutput: string | null;
          isError: boolean | null;
        }>>(`/api/v2/sessions/${encodeURIComponent(session_id)}/log-events`),
      ]);

      const lines: string[] = [
        `Session: ${info.sessionId}`,
        `Title:   ${info.intent ?? info.prompt?.slice(0, 80) ?? "(untitled)"}`,
        `Repo:    ${info.repoName ?? info.cwd}`,
        `Branch:  ${info.branch ?? "unknown"}`,
        `Status:  ${info.isLive ? "LIVE" : "completed"}`,
        `Author:  ${info.gitUserName ?? "unknown"}`,
        `Started: ${info.startedAt}`,
        `Updated: ${info.updatedAt}`,
        "",
        `── Events (${events.length} total, showing last ${Math.min(events.length, event_limit)}) ──`,
        "",
      ];

      for (const e of events.slice(-event_limit)) {
        if (e.type === "user" || e.type === "assistant") {
          lines.push(`[${e.type === "user" ? "User" : "Assistant"}]\n${(e.content ?? "").slice(0, 2000)}\n`);
        } else if (e.type === "tool_use") {
          lines.push(`[Tool: ${e.toolName ?? "?"}]\n${(e.toolInput ?? "").slice(0, 500)}\n`);
        } else if (e.type === "tool_result") {
          lines.push(`[Result${e.isError ? " ERROR" : ""}]\n${(e.toolOutput ?? "").slice(0, 500)}\n`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ── Tool: list_repos ────────────────────────────────────────────────────────

  server.registerTool(
    "list_repos",
    {
      description:
        "List all repositories registered with Gossamer, including their current git branch, " +
        "local path, remote, and the ID of the most recent checkpoint.",
      inputSchema: z.object({}),
    },
    async () => {
      const statuses = await getJson<Array<{
        name: string;
        localPath: string;
        remote: string;
        currentBranch: string | null;
        latestCheckpointId: string | null;
        gitUserName: string | null;
      }>>("/api/repos/status");

      if (statuses.length === 0) {
        return { content: [{ type: "text", text: "No repositories registered." }] };
      }

      const lines = statuses.map((r) =>
        [
          r.name,
          `  path:              ${r.localPath}`,
          `  remote:            ${r.remote || "(none)"}`,
          `  branch:            ${r.currentBranch ?? "unknown"}`,
          `  latest checkpoint: ${r.latestCheckpointId?.slice(0, 8) ?? "none"}`,
        ].join("\n"),
      );

      return { content: [{ type: "text", text: `${statuses.length} repo(s):\n\n${lines.join("\n\n")}` }] };
    },
  );

  // ── Tool: list_branch_checkpoints ───────────────────────────────────────────

  server.registerTool(
    "list_branch_checkpoints",
    {
      description:
        "List checkpoints committed on a git branch, parsed from Entire-Checkpoint git trailers. " +
        "Shows the commit message, which session created each checkpoint, and the files changed. " +
        "Useful for understanding what work has been done on a branch over time.",
      inputSchema: z.object({
        local_path: z.string().describe("Absolute local path to the repository (or a subdirectory)"),
        branch: z.string().optional()
          .describe("Branch name — defaults to the repo's current branch"),
        limit: z.number().int().min(1).max(50).optional().default(20)
          .describe("Maximum checkpoints to return (default 20)"),
      }),
    },
    async ({ local_path, branch, limit }) => {
      let resolvedBranch = branch;
      if (!resolvedBranch) {
        const statuses = await getJson<Array<{ localPath: string; currentBranch: string | null }>>(
          "/api/repos/status",
        );
        resolvedBranch = statuses
          .find((r) => r.localPath === local_path || local_path.startsWith(r.localPath + "/"))
          ?.currentBranch ?? "HEAD";
      }

      const data = await getJson<{
        entries: Array<{
          checkpointId: string;
          sessionId: string;
          commitMessage: string | null;
          commitHash: string | null;
          createdAt: string | null;
          filesTouched: string[];
          summary: { intent: string } | null;
        }>;
        hasMore: boolean;
      }>(`/api/branch-log?localPath=${encodeURIComponent(local_path)}&branch=${encodeURIComponent(resolvedBranch)}&limit=${limit}`);

      const { entries, hasMore } = data;
      if (entries.length === 0) {
        return { content: [{ type: "text", text: `No checkpoints found on branch '${resolvedBranch}'.` }] };
      }

      const lines: string[] = [
        `${entries.length} checkpoint(s) on ${resolvedBranch}${hasMore ? " (more available)" : ""}:\n`,
      ];
      for (const e of entries) {
        const msg   = e.commitMessage ?? e.summary?.intent ?? "(no message)";
        const files = e.filesTouched.length > 0 ? e.filesTouched.join(", ") : "(no files)";
        const ago   = e.createdAt ? formatAgo(e.createdAt) : "unknown";
        lines.push(
          `${e.checkpointId.slice(0, 8)}  ${msg.slice(0, 80)}`,
          `  session: ${e.sessionId.slice(0, 8)}  commit: ${e.commitHash?.slice(0, 8) ?? "?"}  created: ${ago}`,
          `  files: ${files.slice(0, 200)}`,
          "",
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ── Tool: list_session_checkpoints ──────────────────────────────────────────

  server.registerTool(
    "list_session_checkpoints",
    {
      description:
        "List all checkpoints created within a specific Gossamer session, in chronological order.",
      inputSchema: z.object({
        session_id: z.string().describe("Session ID"),
      }),
    },
    async ({ session_id }) => {
      const checkpoints = await getJson<Array<{
        checkpointId: string;
        commitMessage: string | null;
        commitHash: string | null;
        createdAt: string | null;
        filesTouched: string[];
        summary: { intent: string } | null;
      }>>(`/api/v2/sessions/${encodeURIComponent(session_id)}/checkpoints`);

      if (checkpoints.length === 0) {
        return { content: [{ type: "text", text: "No checkpoints found for this session." }] };
      }

      const lines: string[] = [`${checkpoints.length} checkpoint(s):\n`];
      for (const cp of checkpoints) {
        const msg   = cp.commitMessage ?? cp.summary?.intent ?? "(no message)";
        const ago   = cp.createdAt ? formatAgo(cp.createdAt) : "unknown";
        const files = cp.filesTouched.join(", ") || "(none)";
        lines.push(
          `${cp.checkpointId.slice(0, 8)}  ${msg.slice(0, 80)}`,
          `  commit: ${cp.commitHash?.slice(0, 8) ?? "?"}  created: ${ago}`,
          `  files: ${files.slice(0, 200)}`,
          "",
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  // ── Tool: get_checkpoint_diff ────────────────────────────────────────────────

  server.registerTool(
    "get_checkpoint_diff",
    {
      description:
        "Get the unified diff for a Gossamer checkpoint — shows exactly what files changed and how. " +
        "Optionally filter to a specific file path.",
      inputSchema: z.object({
        checkpoint_id: z.string().describe("Checkpoint ID"),
        local_path: z.string().optional()
          .describe("Repo local path — helps locate the right repo when multiple are registered"),
        file_path: z.string().optional()
          .describe("Filter diff to a specific file path"),
      }),
    },
    async ({ checkpoint_id, local_path, file_path }) => {
      const lpParam = local_path ? `?localPath=${encodeURIComponent(local_path)}` : "";
      const id = encodeURIComponent(checkpoint_id);

      const [rawDiff, fileStats] = await Promise.all([
        getRaw(`/api/v2/checkpoints/${id}/diff${lpParam}`).catch(() => ""),
        getJson<Array<{ path: string; additions: number; deletions: number }>>(
          `/api/v2/checkpoints/${id}/diff-stats${lpParam}`,
        ).catch(() => [] as Array<{ path: string; additions: number; deletions: number }>),
      ]);

      let text = rawDiff;
      if (file_path) {
        const sections = text.split(/^(?=diff --git )/m);
        const filtered = sections.filter((s) => s.includes(file_path));
        text = filtered.join("") || `No diff found for file: ${file_path}`;
      }

      const totalAdd = fileStats.reduce((n, f) => n + f.additions, 0);
      const totalDel = fileStats.reduce((n, f) => n + f.deletions, 0);
      const summary  = fileStats.length > 0
        ? `+${totalAdd} -${totalDel} across ${fileStats.length} file(s)\n\n`
        : "";

      return { content: [{ type: "text", text: summary + (text || "(empty diff)") }] };
    },
  );

  return server;
}
