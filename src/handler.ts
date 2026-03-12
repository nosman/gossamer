#!/usr/bin/env node
/**
 * Claude Code stdin hook handler.
 *
 * Reads a hook event from stdin, maintains a markdown sessions table, and
 * writes a JSON response to stdout.
 *
 * Configure in ~/.claude/settings.json:
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [{
 *         "matcher": ".*",
 *         "hooks": [{ "type": "command", "command": "claude-hook-handler --sessions ~/.claude/sessions.md" }]
 *       }],
 *       ...
 *     }
 *   }
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  readdirSync,
  unlinkSync,
} from "fs";
import { dirname, join, resolve, basename } from "path";
import { homedir } from "os";
import { execSync, spawnSync } from "child_process";
import { Command } from "commander";
import type {
  HookInput,
  SyncHookJSONOutput,
  PreToolUseHookInput,
  PostToolUseHookInput,
  PostToolUseFailureHookInput,
  SubagentStartHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import {
  getDb,
  readStateFromDb,
  writeStateToDb,
  type State,
  type SessionRecord,
  type PendingToolUseRecord,
} from "./db.js";

// Re-export PendingToolUseRecord under the local alias used throughout
type PendingToolUse = PendingToolUseRecord;

// ─── Path helpers ─────────────────────────────────────────────────────────────

function expandHome(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : resolve(p);
}

// ─── Config file ──────────────────────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), ".claude", "hook-handler.json");

interface Config {
  anthropicApiKey?: string;
  /**
   * Path to a git repository where session logs are committed.
   * When set, sessions.md and the sessions/ folder are stored inside this
   * directory instead of the default ~/.claude location.
   * The --sessions CLI flag still overrides this value.
   *
   * Example: { "repository": "~/notes/claude-sessions" }
   */
  repository?: string;
}

function loadConfig(): Config {
  try {
    const raw = readFileSync(CONFIG_PATH, "utf8");
    const config = JSON.parse(raw) as Config;
    if (config.anthropicApiKey && !process.env.ANTHROPIC_API_KEY) {
      process.env.ANTHROPIC_API_KEY = config.anthropicApiKey;
    }
    return config;
  } catch {
    // Config file is optional — no-op if missing or unreadable
    return {};
  }
}

// ─── Git user ─────────────────────────────────────────────────────────────────

interface GitUser {
  name?: string;
  email?: string;
}

function gitUser(): GitUser {
  const get = (key: string): string | undefined => {
    try {
      return execSync(`git config --global ${key}`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || undefined;
    } catch { return undefined; }
  };
  return { name: get("user.name"), email: get("user.email") };
}

// ─── Git repo detection ───────────────────────────────────────────────────────

interface RepoInfo {
  repoRoot: string;
  repoName: string;
}

function detectRepo(cwd: string): RepoInfo | undefined {
  try {
    const root = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { repoRoot: root, repoName: basename(root) };
  } catch {
    return undefined;
  }
}

// ─── Markdown rendering ───────────────────────────────────────────────────────

function fmt(iso: string): string {
  const d = new Date(iso);
  const dd  = String(d.getDate()).padStart(2, "0");
  const mm  = String(d.getMonth() + 1).padStart(2, "0");
  const yy  = String(d.getFullYear()).slice(2);
  const hh  = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yy} ${hh}:${min}`;
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function renderMarkdown(state: State): string {
  const sessions = Object.values(state.sessions).sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );

  const updatedAt = `${fmt(new Date().toISOString())} UTC`;

  if (sessions.length === 0) {
    return (
      `# Claude Code Sessions\n\n` +
      `*No active sessions.*\n\n` +
      `*Last updated: ${updatedAt}*\n`
    );
  }

  const header = "| Session ID | User | Repo | Summary | Keywords | Started | Last Updated |";
  const divider = "|---|---|---|---|---|---|---|";
  const rows = sessions.map((s) => {
    const id = `[\`${s.sessionId.slice(0, 8)}…\`](sessions/${s.sessionId}.md)`;
    const user = escapeCell(
      s.gitUserName && s.gitUserEmail ? `${s.gitUserName} <${s.gitUserEmail}>`
      : s.gitUserName ?? s.gitUserEmail ?? "",
    );
    const repo = escapeCell(s.repoName ?? s.cwd.split("/").pop() ?? s.cwd);
    const summary = escapeCell(
      s.summary ?? s.prompt?.slice(0, 80) ?? "*waiting for prompt…*",
    );
    const keywords = s.keywords?.length
      ? s.keywords.map((k) => `\`${escapeCell(k)}\``).join(" ")
      : "";
    return `| ${id} | ${user} | ${repo} | ${summary} | ${keywords} | ${fmt(s.startedAt)} | ${fmt(s.updatedAt)} |`;
  });

  return [
    "# Claude Code Sessions",
    "",
    header,
    divider,
    ...rows,
    "",
    `*Last updated: ${updatedAt}*`,
    "",
  ].join("\n");
}

function writeMarkdown(sessionsPath: string, state: State): void {
  mkdirSync(dirname(sessionsPath), { recursive: true });
  const tmp = sessionsPath + ".tmp";
  writeFileSync(tmp, renderMarkdown(state), "utf8");
  renameSync(tmp, sessionsPath);
}

// ─── Per-session event log ────────────────────────────────────────────────────

// Always omit — structural noise with no reader value
const SKIP_COMMON = new Set([
  "session_id", "hook_event_name", "transcript_path", "tool_use_id",
]);
// Also omit for collapsed events (same for every tool call — not useful per-event)
const SKIP_NOISE = new Set([...SKIP_COMMON, "cwd", "permission_mode"]);

const IMPORTANT_EVENTS = new Set([
  "UserPromptSubmit", "Stop", "SessionEnd",
]);

const SKIP_EVENTS = new Set([
  "SessionStart",
]);

/** Extract a short hint string from tool_input for the <summary> line. */
function toolSummaryHint(toolName: string, toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== "object") return "";
  const inp = toolInput as Record<string, unknown>;
  const str = (k: string): string | undefined =>
    typeof inp[k] === "string" ? String(inp[k]) : undefined;
  switch (toolName) {
    case "Read":      return str("file_path") ?? "";
    case "Write":     return str("file_path") ?? "";
    case "Edit":      return str("file_path") ?? "";
    case "Bash":      return (str("command") ?? "").slice(0, 70);
    case "Glob":      return str("pattern") ?? "";
    case "Grep":      return str("pattern") ?? "";
    case "WebFetch":  return str("url") ?? "";
    case "WebSearch": return str("query") ?? "";
    default:          return "";
  }
}

/** Render fields for an event, skipping the given skip-set. */
function renderFields(
  input: HookInput,
  skip: Set<string>,
  childLogRelPath?: string,
): string[] {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (skip.has(key) || value === undefined) continue;
    if (key === "prompt" || key === "message" || key === "last_assistant_message") {
      lines.push(`**${key}:**`, "");
      for (const line of String(value).split("\n")) lines.push(`> ${line}`);
      lines.push("");
    } else if (key === "tool_input" || key === "tool_response") {
      const s = JSON.stringify(value, null, 2);
      lines.push(`**${key}:**`, "```json", s.length > 600 ? s.slice(0, 600) + "\n…" : s, "```", "");
    } else if (key === "agent_id" && childLogRelPath) {
      lines.push(`- **${key}:** [\`${String(value)}\`](${childLogRelPath})`);
    } else {
      lines.push(`- **${key}:** \`${String(value)}\``);
    }
  }
  return lines;
}

/** Important events: H2 heading, full field list, horizontal rule. */
function formatImportantEvent(input: HookInput): string {
  const ts = fmt(new Date().toISOString());
  const name = input.hook_event_name;
  const sym = EVENT_SYMBOL[name] ?? "◆";
  const fields = renderFields(input, SKIP_COMMON);
  return [`## ${sym} ${name}`, "", `<small>${ts}</small>`, "", ...fields, "---", ""].join("\n");
}

/** UserPromptSubmit: "<User> prompted:" followed by the prompt as a blockquote. */
function formatPromptEvent(input: HookInput, rec: SessionRecord | undefined): string {
  const ts = fmt(new Date().toISOString());
  const user = rec?.gitUserName ?? rec?.gitUserEmail ?? "User";
  const prompt = "prompt" in input ? String(input.prompt) : "";
  const lines: string[] = [`## → **${user} prompted:**`, "", `<small>${ts}</small>`, ""];
  for (const line of prompt.split("\n")) lines.push(`> ${line}`);
  lines.push("", "---", "");
  return lines.join("\n");
}

/** Stop / Notification: "Claude wrote:" followed by the message as a blockquote. */
function formatClaudeMessageEvent(input: HookInput): string {
  const ts = fmt(new Date().toISOString());
  const sym = EVENT_SYMBOL[input.hook_event_name] ?? "◆";
  const message =
    "last_assistant_message" in input && input.last_assistant_message
      ? String(input.last_assistant_message)
      : "message" in input && input.message
      ? String(input.message)
      : "";

  if (!message) return formatImportantEvent(input);

  const lines: string[] = [`## ${sym} **Claude wrote:**`, "", `<small>${ts}</small>`, ""];
  for (const line of message.split("\n")) lines.push(`> ${line}`);
  lines.push("", "---", "");
  return lines.join("\n");
}

/** Non-critical events: collapsed <details> block. */
function formatCollapsibleEvent(input: HookInput, childLogRelPath?: string): string {
  const ts = fmt(new Date().toISOString());
  const name = input.hook_event_name;
  const sym = EVENT_SYMBOL[name] ?? "◆";
  const fields = renderFields(input, SKIP_NOISE, childLogRelPath);
  return [
    `<details>`,
    `<summary><small>${name}</small></summary>`,
    "",
    `<small>${ts}</small>`,
    "",
    ...fields,
    `</details>`,
    "",
    "",
  ].join("\n");
}

/** Merged Pre+PostToolUse: collapsed <details> with success/failure indicator. */
function formatMergedToolUse(
  pending: PendingToolUse,
  post: PostToolUseHookInput | PostToolUseFailureHookInput,
): string {
  const failed = post.hook_event_name === "PostToolUseFailure";
  const statusSym = failed ? "✗" : "✓";
  const hint = toolSummaryHint(pending.tool_name, pending.tool_input);
  const hintStr = hint ? ` · \`${hint.replace(/`/g, "'").replace(/\s+/g, " ")}\`` : "";
  const endTs = fmt(new Date().toISOString());

  const lines: string[] = [
    `<details>`,
    `<summary><small>${statusSym} ${pending.tool_name}${hintStr}</small></summary>`,
    "",
    `<small>${pending.startedAt} → ${endTs}</small>`,
    "",
  ];

  if (pending.tool_input !== undefined) {
    const s = JSON.stringify(pending.tool_input, null, 2);
    lines.push("**input:**", "```json", s.length > 600 ? s.slice(0, 600) + "\n…" : s, "```", "");
  }

  if (failed && "error" in post && post.error) {
    lines.push(`**error:** \`${String(post.error)}\``, "");
  } else if ("tool_response" in post && post.tool_response !== undefined) {
    const s =
      typeof post.tool_response === "string"
        ? post.tool_response
        : JSON.stringify(post.tool_response, null, 2);
    lines.push("**output:**", "```", s.length > 400 ? s.slice(0, 400) + "\n…" : s, "```", "");
  }

  lines.push(`</details>`, "", "");
  return lines.join("\n");
}

function sessionLogPath(sessionsPath: string, sessionId: string): string {
  return join(dirname(sessionsPath), "sessions", `${sessionId}.md`);
}

// ─── Log rotation ─────────────────────────────────────────────────────────────

function archiveTimestamp(): string {
  const d = new Date();
  return (
    String(d.getFullYear()) +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0") +
    "-" +
    String(d.getHours()).padStart(2, "0") +
    String(d.getMinutes()).padStart(2, "0")
  );
}

/**
 * If `logPath` exceeds `maxLines` lines, rename it to a timestamped archive,
 * then write a fresh file containing only the header (with an "← prev" link).
 * Returns the archive path if rotation happened, undefined otherwise.
 */
function rotateSessionLog(logPath: string, maxLines: number): string | undefined {
  if (!existsSync(logPath)) return undefined;

  const content = readFileSync(logPath, "utf8");
  if (content.split("\n").length <= maxLines) return undefined;

  // Build archive filename next to the current file
  const dir = dirname(logPath);
  const base = basename(logPath, ".md");
  const archiveName = `${base}-${archiveTimestamp()}.md`;
  const archivePath = join(dir, archiveName);

  // Rename current file → archive
  renameSync(logPath, archivePath);

  // Append a forward link to the bottom of the archived file
  const nextName = basename(logPath);
  appendFileSync(archivePath, `\n---\n\n<small>[→ next](${nextName})</small>\n`, "utf8");

  // Extract header: everything before the first event entry
  const firstEventIdx = content.search(/^(?:## |<details>)/m);
  let header = firstEventIdx !== -1 ? content.slice(0, firstEventIdx) : content;

  // Inject / update the "← prev" link next to the session ID in the <sub> line
  const prevLink = `[← prev](${archiveName})`;
  if (header.includes("[← prev]")) {
    // Update existing link to point to the new archive
    header = header.replace(/\[← prev\]\([^)]*\)/, prevLink);
  } else if (header.includes("<sub>")) {
    // Insert after the backtick-wrapped session ID
    header = header.replace(/(<sub>)(`[^`]+`)/, `$1$2 · ${prevLink}`);
  } else {
    // Fallback for bare initial header (pre-UserPromptSubmit)
    header = header.replace(
      /^(# Session `[^`]+`\n\n)/m,
      `$1<small>${prevLink}</small>\n\n`,
    );
  }

  writeFileSync(logPath, header, "utf8");
  return archivePath;
}

function updateLogHeader(logPath: string, rec: SessionRecord): void {
  const content = readFileSync(logPath, "utf8");

  // Build the new header: AI summary as the H1, session ID + user in small text beneath
  const title = rec.summary ?? `Session \`${rec.sessionId}\``;
  const keywordsLine = rec.keywords?.length
    ? `**Keywords:** ${rec.keywords.map((k) => `\`${k}\``).join(" ")}`
    : "";

  const userPart = rec.gitUserName && rec.gitUserEmail
    ? ` · ${rec.gitUserName} &lt;${rec.gitUserEmail}&gt;`
    : rec.gitUserName ? ` · ${rec.gitUserName}`
    : rec.gitUserEmail ? ` · ${rec.gitUserEmail}`
    : "";
  const headerParts = [`# ${title}`, "", `<sub>\`${rec.sessionId}\`${userPart}</sub>`, ""];
  if (keywordsLine) headerParts.push(keywordsLine, "");
  const newHeader = headerParts.join("\n");

  // Replace everything from the start of file up to the first event entry.
  // Events start with ## , ### , or <details>.
  const firstEventIdx = content.search(/^(?:#{2,3} |<details>)/m);
  const body = firstEventIdx !== -1 ? content.slice(firstEventIdx) : "";
  writeFileSync(logPath, newHeader + "\n" + body, "utf8");
}

function appendSessionLog(sessionsPath: string, input: HookInput, state: State, maxLogLines: number): string[] {
  const logPath = sessionLogPath(sessionsPath, input.session_id);
  mkdirSync(dirname(logPath), { recursive: true });

  if (!existsSync(logPath)) {
    writeFileSync(logPath, `# Session \`${input.session_id}\`\n\n`, "utf8");
  }

  // Patch the file header with summary + keywords once we have them
  if (input.hook_event_name === "UserPromptSubmit") {
    const rec = state.sessions[input.session_id];
    if (rec) updateLogHeader(logPath, rec);
  }

  // ── Events to skip entirely ───────────────────────────────────────────────
  if (SKIP_EVENTS.has(input.hook_event_name)) {
    return [];
  }

  // ── PreToolUse: stash and write nothing yet ───────────────────────────────
  if (input.hook_event_name === "PreToolUse") {
    const pre = input as PreToolUseHookInput;
    state.pendingToolUses[pre.tool_use_id] = {
      tool_use_id: pre.tool_use_id,
      tool_name: pre.tool_name,
      tool_input: pre.tool_input,
      startedAt: fmt(new Date().toISOString()),
    };
    return []; // nothing written to disk yet
  }

  // ── Log rotation (before any write) ──────────────────────────────────────
  const rotatedPaths: string[] = [];
  if (maxLogLines > 0) {
    const archived = rotateSessionLog(logPath, maxLogLines);
    if (archived) rotatedPaths.push(archived);
  }

  // ── PostToolUse / PostToolUseFailure: merge with stashed Pre ─────────────
  if (
    input.hook_event_name === "PostToolUse" ||
    input.hook_event_name === "PostToolUseFailure"
  ) {
    const post = input as PostToolUseHookInput | PostToolUseFailureHookInput;
    const pending = state.pendingToolUses[post.tool_use_id];
    if (pending) {
      delete state.pendingToolUses[post.tool_use_id];
      appendFileSync(logPath, formatMergedToolUse(pending, post), "utf8");
    } else {
      // No matching Pre (e.g. state was cleared) — render as collapsible fallback
      appendFileSync(logPath, formatCollapsibleEvent(input), "utf8");
    }
    return [...rotatedPaths, logPath];
  }

  // ── SubagentStart: create child log file ──────────────────────────────────
  const changedPaths: string[] = [...rotatedPaths];
  let childLogRelPath: string | undefined;

  if (input.hook_event_name === "SubagentStart") {
    const { agent_id, agent_type } = input as SubagentStartHookInput;
    const childPath = sessionLogPath(sessionsPath, agent_id);
    mkdirSync(dirname(childPath), { recursive: true });
    if (!existsSync(childPath)) {
      const parentLink = `[\`${input.session_id.slice(0, 8)}…\`](${input.session_id}.md)`;
      writeFileSync(
        childPath,
        `# Subagent Session \`${agent_id}\`\n\n` +
        `**Parent:** ${parentLink}  \n` +
        `**Type:** \`${agent_type}\`\n\n`,
        "utf8",
      );
      changedPaths.push(childPath);
    }
    childLogRelPath = `${agent_id}.md`;
  }

  // ── Important events: prominent H2 rendering ──────────────────────────────
  if (input.hook_event_name === "UserPromptSubmit") {
    appendFileSync(logPath, formatPromptEvent(input, state.sessions[input.session_id]), "utf8");
  } else if (input.hook_event_name === "Stop" || input.hook_event_name === "Notification") {
    appendFileSync(logPath, formatClaudeMessageEvent(input), "utf8");
  } else if (IMPORTANT_EVENTS.has(input.hook_event_name)) {
    appendFileSync(logPath, formatImportantEvent(input), "utf8");
  } else {
    // ── Everything else: collapsed ────────────────────────────────────────────
    appendFileSync(logPath, formatCollapsibleEvent(input, childLogRelPath), "utf8");
  }

  changedPaths.push(logPath);
  return changedPaths;
}

// ─── Git history ──────────────────────────────────────────────────────────────

function ensureRepo(dir: string, sessionsFilename: string): void {
  try {
    execSync("git rev-parse --git-dir", { cwd: dir, stdio: "ignore" });
  } catch {
    execSync("git init", { cwd: dir, stdio: "ignore" });
  }
  // Always keep gitignore up to date — may need to add sessions/ on upgrade
  const gitignore = join(dir, ".gitignore");
  const desired =
    `# Managed by claude-hook-handler\n` +
    `*\n!.gitignore\n!${sessionsFilename}\n!sessions/\n!sessions/*.md\n`;
  try {
    if (readFileSync(gitignore, "utf8") !== desired) writeFileSync(gitignore, desired, "utf8");
  } catch {
    writeFileSync(gitignore, desired, "utf8");
  }
}

function commitFiles(sessionsPath: string, paths: string[], message: string): void {
  const dir = dirname(sessionsPath);
  ensureRepo(dir, basename(sessionsPath));

  for (const p of paths) spawnSync("git", ["add", p], { cwd: dir });

  const diff = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: dir });
  if (diff.status === 0) return;

  spawnSync(
    "git",
    [
      "-c", "user.name=claude-hook-handler",
      "-c", "user.email=noreply@localhost",
      "commit", "-m", message,
    ],
    { cwd: dir },
  );
}

function buildCommitMessage(input: HookInput, state: State): string {
  const id = input.session_id.slice(0, 8);
  switch (input.hook_event_name) {
    case "SessionStart": {
      const rec = state.sessions[input.session_id];
      const repo = rec?.repoName ? ` (${rec.repoName})` : "";
      return `session started: ${id}${repo}`;
    }
    case "UserPromptSubmit": {
      const rec = state.sessions[input.session_id];
      const summary = rec?.summary ?? rec?.prompt?.slice(0, 60) ?? "";
      return `session prompt: ${id}: ${summary}`;
    }
    case "SessionEnd":
      return `session ended: ${id}`;
    default: {
      const count = Object.keys(state.sessions).length;
      return `sessions: ${count} active`;
    }
  }
}

// ─── Prompt summarisation ─────────────────────────────────────────────────────

interface PromptAnalysis {
  summary: string;
  keywords: string[];
}

async function analyse(prompt: string): Promise<PromptAnalysis> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return truncateAnalysis(prompt);
  }
  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 120,
      messages: [
        {
          role: "user",
          content:
            `Analyse the following user prompt. Reply with a JSON object only — no prose, no code fences.\n` +
            `{\n` +
            `  "summary": "<one sentence, 10 words max, no trailing punctuation>",\n` +
            `  "keywords": ["<3-6 keywords: named entities, tools, concepts, actions>"]\n` +
            `}\n\nPrompt:\n${prompt}`,
        },
      ],
    });
    const block = response.content[0];
    if (block?.type === "text") {
      // Strip markdown code fences in case the model wraps its JSON
      const raw = block.text.trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
      const parsed = JSON.parse(raw) as Partial<PromptAnalysis>;
      return {
        summary: String(parsed.summary ?? "").replace(/[.!?]$/, ""),
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map(String) : [],
      };
    }
  } catch {
    // fall through
  }
  return truncateAnalysis(prompt);
}

function truncateAnalysis(prompt: string): PromptAnalysis {
  const firstLine = prompt.split("\n")[0]?.trim() ?? prompt;
  return {
    summary: firstLine.length > 80 ? firstLine.slice(0, 77) + "…" : firstLine,
    keywords: [],
  };
}

// ─── State mutation per event ─────────────────────────────────────────────────

async function applyEvent(
  state: State,
  input: HookInput,
  noSummary: boolean,
  precomputed?: { summary: string; keywords: string[] },
): Promise<void> {
  const { session_id, hook_event_name, cwd } = input;
  const now = new Date().toISOString();

  switch (hook_event_name) {
    case "SessionStart": {
      const repo = detectRepo(cwd);
      const parentSessionId = state.agentParents[session_id];
      const user = gitUser();
      state.sessions[session_id] = {
        sessionId: session_id,
        startedAt: now,
        updatedAt: now,
        cwd,
        repoRoot: repo?.repoRoot,
        repoName: repo?.repoName,
        parentSessionId,
        gitUserName: user.name,
        gitUserEmail: user.email,
      };
      break;
    }

    case "SubagentStart": {
      const { agent_id } = input as SubagentStartHookInput;
      state.agentParents[agent_id] = session_id;
      // Touch parent updatedAt
      const existing = state.sessions[session_id];
      if (existing) existing.updatedAt = now;
      break;
    }

    case "UserPromptSubmit": {
      const prompt = "prompt" in input ? String(input.prompt) : "";
      const existing = state.sessions[session_id];
      const { summary, keywords } = precomputed ?? (noSummary ? truncateAnalysis(prompt) : await analyse(prompt));
      // Detect repo/user now if SessionStart was missed
      const repo = existing?.repoRoot ? undefined : detectRepo(existing?.cwd ?? cwd);
      const user = (existing?.gitUserName ?? existing?.gitUserEmail) ? undefined : gitUser();
      state.sessions[session_id] = {
        sessionId: session_id,
        startedAt: existing?.startedAt ?? now,
        updatedAt: now,
        cwd: existing?.cwd ?? cwd,
        repoRoot: existing?.repoRoot ?? repo?.repoRoot,
        repoName: existing?.repoName ?? repo?.repoName,
        parentSessionId: existing?.parentSessionId,
        gitUserName: existing?.gitUserName ?? user?.name,
        gitUserEmail: existing?.gitUserEmail ?? user?.email,
        prompt,
        summary,
        keywords,
      };
      break;
    }

    case "SessionEnd": {
      delete state.sessions[session_id];
      break;
    }

    case "PreToolUse":
      // Don't update sessions table — too frequent, makes updatedAt meaningless
      break;

    default: {
      // Touch updatedAt for any other event
      const existing = state.sessions[session_id];
      if (existing) {
        existing.updatedAt = now;
      }
      break;
    }
  }
}

// ─── stderr formatting ────────────────────────────────────────────────────────

const EVENT_SYMBOL: Record<string, string> = {
  PreToolUse:         "▶",
  PostToolUse:        "✓",
  PostToolUseFailure: "✗",
  SessionStart:       "◉",
  SessionEnd:         "◎",
  Stop:               "■",
  UserPromptSubmit:   "→",
  Notification:       "◆",
  Setup:              "⚙",
  SubagentStart:      "▷",
  SubagentStop:       "◁",
  PermissionRequest:  "?",
  PreCompact:         "⌃",
};

function formatForStderr(input: HookInput, blocked: boolean): string {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 23);
  const name = input.hook_event_name;
  const sym = EVENT_SYMBOL[name] ?? "◆";
  const blockTag = blocked ? " \x1b[31m[BLOCKED]\x1b[0m" : "";

  const lines = [`\x1b[1m[${ts}] ${sym} ${name}\x1b[0m${blockTag}`];

  if ("tool_name" in input)
    lines.push(`  tool:   \x1b[1m${input.tool_name}\x1b[0m`);
  if ("tool_input" in input && input.tool_input !== undefined) {
    const s = JSON.stringify(input.tool_input);
    lines.push(`  input:  ${s.length > 120 ? s.slice(0, 120) + "…" : s}`);
  }
  if ("tool_response" in input && input.tool_response !== undefined) {
    const s = JSON.stringify(input.tool_response);
    lines.push(`  output: ${s.length > 120 ? s.slice(0, 120) + "…" : s}`);
  }
  if ("error" in input && input.error)
    lines.push(`  error:  \x1b[31m${input.error}\x1b[0m`);
  if ("prompt" in input && input.prompt)
    lines.push(`  prompt: ${String(input.prompt).slice(0, 100)}`);
  if ("message" in input && input.message)
    lines.push(`  msg:    ${String(input.message)}`);
  if ("reason" in input && input.reason)
    lines.push(`  reason: ${String(input.reason)}`);
  if ("source" in input && input.source)
    lines.push(`  source: ${String(input.source)}`);

  lines.push(`  session: \x1b[2m${input.session_id.slice(0, 8)}…\x1b[0m`);
  return lines.join("\n");
}

// ─── Tool blocking ────────────────────────────────────────────────────────────

function shouldBlock(input: HookInput, patterns: RegExp[]): boolean {
  if (input.hook_event_name !== "PreToolUse" || patterns.length === 0)
    return false;
  const name = (input as PreToolUseHookInput).tool_name ?? "";
  return patterns.some((re) => re.test(name));
}

function buildResponse(blocked: boolean, reason: string): SyncHookJSONOutput {
  return blocked ? { decision: "block", reason } : {};
}

// ─── SQLite event log ─────────────────────────────────────────────────────────

import type { PrismaClient } from "../prisma/generated/client/index.js";

/**
 * Insert one event record into the SQLite database.
 * For UserPromptSubmit, also stores summary and keywords from the session state.
 */
async function writeEventLog(
  db: PrismaClient,
  input: HookInput,
  blocked: boolean,
  state: State,
): Promise<void> {
  const session = state.sessions[input.session_id];
  await db.event.create({
    data: {
      event: input.hook_event_name,
      sessionId: input.session_id,
      blocked,
      data: JSON.stringify(input),
      summary: input.hook_event_name === "UserPromptSubmit"
        ? (session?.summary ?? null)
        : null,
      keywords: input.hook_event_name === "UserPromptSubmit" && session?.keywords
        ? JSON.stringify(session.keywords)
        : null,
    },
  });
}

// ─── Interaction overview ─────────────────────────────────────────────────────

/**
 * Generate (or update) an InteractionOverview for the given session.
 * Collects all events from SessionStart through the most recent Stop, builds a
 * compact text representation, and calls the AI to produce a summary and keywords.
 * Upserts the record so repeated Stop events refine the overview.
 */
async function generateInteractionOverview(
  db: PrismaClient,
  sessionId: string,
  noSummary: boolean,
): Promise<void> {
  const events = await db.event.findMany({
    where: { sessionId },
    orderBy: { timestamp: "asc" },
  });

  const stopEvents = events.filter((e) => e.event === "Stop");
  if (stopEvents.length === 0) return;

  const startEvent = events.find((e) => e.event === "SessionStart");
  const startedAt = startEvent ? startEvent.timestamp : events[0].timestamp;
  const endedAt = stopEvents[stopEvents.length - 1].timestamp;

  // Build a compact text for AI consumption
  const parts: string[] = [];
  const toolCounts = new Map<string, number>();

  for (const ev of events) {
    let d: Record<string, unknown>;
    try { d = JSON.parse(ev.data) as Record<string, unknown>; } catch { continue; }

    if (ev.event === "UserPromptSubmit" && typeof d.prompt === "string") {
      parts.push(`User: ${d.prompt.slice(0, 600)}`);
    } else if (ev.event === "Stop" && typeof d.last_assistant_message === "string") {
      parts.push(`Assistant: ${d.last_assistant_message.slice(0, 600)}`);
    } else if (ev.event === "PreToolUse" && typeof d.tool_name === "string") {
      toolCounts.set(d.tool_name, (toolCounts.get(d.tool_name) ?? 0) + 1);
    }
  }

  if (toolCounts.size > 0) {
    const toolSummary = [...toolCounts.entries()]
      .map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
      .join(", ");
    parts.push(`Tools used: ${toolSummary}`);
  }

  const text = parts.join("\n\n");

  let analysis: { summary: string; keywords: string[] };

  if (noSummary || !process.env.ANTHROPIC_API_KEY) {
    // Fallback: derive from first user prompt
    const firstPrompt = events.find((e) => e.event === "UserPromptSubmit");
    let prompt = "";
    try {
      const d = firstPrompt ? JSON.parse(firstPrompt.data) as Record<string, unknown> : {};
      prompt = typeof d.prompt === "string" ? d.prompt : "";
    } catch { /* ignore */ }
    analysis = truncateAnalysis(prompt || sessionId);
  } else {
    try {
      const client = new Anthropic();
      const response = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 250,
        messages: [{
          role: "user",
          content:
            `Summarise this Claude Code session. Reply with JSON only — no prose, no code fences.\n` +
            `{\n` +
            `  "summary": "<2-3 sentences describing what was accomplished, what tools were used, and the outcome>",\n` +
            `  "keywords": ["<5-8 keywords: file names, tools, languages, concepts, actions>"]\n` +
            `}\n\nSession:\n${text.slice(0, 3000)}`,
        }],
      });
      const block = response.content[0];
      if (block?.type !== "text") throw new Error("unexpected response");
      const raw = block.text.trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
      const parsed = JSON.parse(raw) as Partial<{ summary: string; keywords: string[] }>;
      analysis = {
        summary: String(parsed.summary ?? ""),
        keywords: Array.isArray(parsed.keywords) ? parsed.keywords.map(String) : [],
      };
    } catch {
      const firstPrompt = events.find((e) => e.event === "UserPromptSubmit");
      let prompt = "";
      try {
        const d = firstPrompt ? JSON.parse(firstPrompt.data) as Record<string, unknown> : {};
        prompt = typeof d.prompt === "string" ? d.prompt : "";
      } catch { /* ignore */ }
      analysis = truncateAnalysis(prompt || sessionId);
    }
  }

  await db.interactionOverview.upsert({
    where: { sessionId },
    create: {
      sessionId,
      summary: analysis.summary,
      keywords: JSON.stringify(analysis.keywords),
      startedAt,
      endedAt,
    },
    update: {
      summary: analysis.summary,
      keywords: JSON.stringify(analysis.keywords),
      endedAt,
    },
  });
}

// ─── Reconstruction ───────────────────────────────────────────────────────────

/**
 * Replay the SQLite event log and rebuild all markdown files from scratch.
 * Uses stored summary/keywords from each record; calls AI for any that are missing
 * unless noSummary is true.
 */
async function runReconstruct(
  db: PrismaClient,
  sessionsPath: string,
  maxLogLines: number,
  noSummary: boolean,
): Promise<void> {
  // Clear existing markdown output so we start fresh
  const absSessions = expandHome(sessionsPath);
  const sessionsDir = join(dirname(absSessions), "sessions");
  if (existsSync(sessionsDir)) {
    for (const f of readdirSync(sessionsDir)) {
      if (f.endsWith(".md")) unlinkSync(join(sessionsDir, f));
    }
  }
  if (existsSync(absSessions)) unlinkSync(absSessions);

  const events = await db.event.findMany({ orderBy: { timestamp: "asc" } });

  const state: State = { sessions: {}, agentParents: {}, pendingToolUses: {} };
  let replayed = 0;
  let skipped = 0;
  let filled = 0;
  let lastEnded: { sessionId: string; cwd: string; ts: number } | undefined;

  for (const event of events) {
    let input: HookInput;
    try {
      input = JSON.parse(event.data) as HookInput;
    } catch {
      skipped++;
      continue;
    }

    if (!input?.hook_event_name || input.hook_event_name === "Setup") {
      continue;
    }

    // Track last ended session (before applyEvent removes it from state)
    if (input.hook_event_name === "SessionEnd") {
      const cur = state.sessions[input.session_id];
      if (cur) lastEnded = { sessionId: input.session_id, cwd: cur.cwd, ts: event.timestamp.getTime() };
    }

    // Auto-link plan→implementation sessions during replay
    if (
      input.hook_event_name === "SessionStart" &&
      !state.agentParents[input.session_id] &&
      lastEnded &&
      event.timestamp.getTime() - lastEnded.ts < 30_000 &&
      lastEnded.cwd === input.cwd
    ) {
      state.agentParents[input.session_id] = lastEnded.sessionId;
    }

    const precomputed = event.summary !== null
      ? { summary: event.summary, keywords: event.keywords ? (JSON.parse(event.keywords) as string[]) : [] }
      : undefined;

    await applyEvent(state, input, noSummary, precomputed);

    // If AI filled in missing summary/keywords, backfill into the DB record
    if (!precomputed && input.hook_event_name === "UserPromptSubmit") {
      const session = state.sessions[input.session_id];
      if (session?.summary !== undefined) {
        await db.event.update({
          where: { id: event.id },
          data: {
            summary: session.summary,
            keywords: JSON.stringify(session.keywords ?? []),
          },
        });
        filled++;
      }
    }

    writeMarkdown(absSessions, state);
    appendSessionLog(absSessions, input, state, maxLogLines);
    replayed++;
  }

  // Write state back to DB
  await writeStateToDb(db, state);

  if (filled > 0) {
    process.stderr.write(`claude-hook-handler reconstruct: filled ${filled} missing summaries\n`);
  }
  process.stderr.write(
    `claude-hook-handler reconstruct: replayed ${replayed} events` +
      (skipped ? `, skipped ${skipped} malformed records` : "") +
      `\n  sessions → ${absSessions}\n`,
  );
}

// ─── Migration: NDJSON → SQLite ───────────────────────────────────────────────

interface LegacyEventRecord {
  timestamp: string;
  event: string;
  blocked: boolean;
  data: HookInput;
  summary?: string;
  keywords?: string[];
}

async function runMigrate(
  eventsPath: string,
  db: PrismaClient,
  sessionsPath: string,
  maxLogLines: number,
  noSummary: boolean,
): Promise<void> {
  const absEvents = expandHome(eventsPath);
  if (!existsSync(absEvents)) {
    process.stderr.write(`claude-hook-handler migrate: no NDJSON file found at ${absEvents}\n`);
    process.exit(1);
  }

  const rawLines = readFileSync(absEvents, "utf8").split("\n");
  let inserted = 0;
  let skipped = 0;

  for (const line of rawLines) {
    if (!line.trim()) continue;

    let record: LegacyEventRecord;
    try {
      record = JSON.parse(line) as LegacyEventRecord;
    } catch {
      skipped++;
      continue;
    }

    if (!record.data?.hook_event_name) {
      skipped++;
      continue;
    }

    try {
      await db.event.create({
        data: {
          timestamp: new Date(record.timestamp),
          event: record.event,
          sessionId: record.data.session_id,
          blocked: record.blocked ?? false,
          data: JSON.stringify(record.data),
          summary: record.summary ?? null,
          keywords: record.keywords ? JSON.stringify(record.keywords) : null,
        },
      });
      inserted++;
    } catch {
      skipped++;
    }
  }

  process.stderr.write(
    `claude-hook-handler migrate: inserted ${inserted} events` +
      (skipped ? `, skipped ${skipped} lines` : "") +
      `\n`,
  );

  // Rebuild sessions/state from the newly inserted events
  process.stderr.write(`claude-hook-handler migrate: running reconstruct...\n`);
  await runReconstruct(db, sessionsPath, maxLogLines, noSummary);
}

// ─── stdin ────────────────────────────────────────────────────────────────────

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    process.stderr.write(
      "claude-hook-handler: no stdin detected.\n" +
        "This program is called by Claude Code hooks, not directly.\n" +
        "Run with --help for configuration instructions.\n",
    );
    process.exit(1);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const config = loadConfig();

  const repoInfo = detectRepo(process.cwd());
  const defaultDbPath = repoInfo
    ? join(repoInfo.repoRoot, ".gossamer", "hook-handler.db")
    : expandHome("~/.claude/hook-handler.db");
  const defaultSessionsPath = config.repository
    ? join(expandHome(config.repository), "sessions.md")
    : expandHome("~/.claude/sessions.md");

  const program = new Command();

  program
    .name("claude-hook-handler")
    .description(
      "Stdin hook handler for Claude Code's settings-based hook system.\n" +
        "Maintains a live markdown sessions table and writes a JSON response to stdout.",
    )
    .version("1.0.0")
    .enablePositionalOptions();

  // ── reconstruct subcommand ───────────────────────────────────────────────
  program
    .command("reconstruct")
    .description(
      "Rebuild markdown session files from the SQLite event log.\n" +
        "Clears existing markdown output and replays all recorded events.",
    )
    .option(
      "--db <file>",
      "SQLite database file",
      defaultDbPath,
    )
    .option(
      "-s, --sessions <file>",
      "Markdown sessions table to write",
      defaultSessionsPath,
    )
    .option(
      "--max-log-lines <n>",
      "Rotate session log files after this many lines (0 to disable)",
      (v: string) => parseInt(v, 10),
      1000,
    )
    .option("--no-summary", "Skip AI summarisation, use truncated prompt text instead")
    .action(async (opts: {
      db: string;
      sessions: string;
      maxLogLines: number;
      summary: boolean;
    }) => {
      const db = await getDb(expandHome(opts.db));
      await runReconstruct(db, opts.sessions, opts.maxLogLines, !opts.summary);
    });

  // ── migrate subcommand ───────────────────────────────────────────────────
  program
    .command("migrate")
    .description(
      "Migrate events from an NDJSON event log into a SQLite database.\n" +
        "After inserting all events, runs reconstruct to rebuild session markdown.",
    )
    .requiredOption(
      "--events <file>",
      "Source NDJSON event log to read",
    )
    .option(
      "--db <file>",
      "Destination SQLite database file",
      defaultDbPath,
    )
    .option(
      "-s, --sessions <file>",
      "Markdown sessions table to write",
      defaultSessionsPath,
    )
    .option(
      "--max-log-lines <n>",
      "Rotate session log files after this many lines (0 to disable)",
      (v: string) => parseInt(v, 10),
      1000,
    )
    .option("--no-summary", "Skip AI summarisation, use truncated prompt text instead")
    .action(async (opts: {
      events: string;
      db: string;
      sessions: string;
      maxLogLines: number;
      summary: boolean;
    }) => {
      const db = await getDb(expandHome(opts.db));
      await runMigrate(opts.events, db, opts.sessions, opts.maxLogLines, !opts.summary);
    });

  // ── index-checkpoints subcommand ─────────────────────────────────────────
  program
    .command("index-checkpoints")
    .description(
      "Index Entire CLI checkpoints from a checkout of the entire/checkpoints/v1 branch.\n" +
        "Walks the shard tree (<root>/<2-hex>/<10-hex>/) and writes\n" +
        "Checkpoint, CheckpointSession, and CheckpointMessage records to the DB.",
    )
    .requiredOption(
      "--dir <path>",
      "Path to the checkpoints root directory (checkout of entire/checkpoints/v1)",
    )
    .option("--db <file>", "SQLite database file", defaultDbPath)
    .action(async (opts: { dir: string; db: string }) => {
      const { indexAllCheckpoints } = await import("./indexer.js");
      const db = await getDb(expandHome(opts.db));
      const { checkpoints } = await indexAllCheckpoints(
        db,
        expandHome(opts.dir),
        (id) => process.stderr.write(`  ${id}\n`),
      );
      process.stderr.write(
        `index-checkpoints: done — ${checkpoints} checkpoint(s) indexed\n`,
      );
    });

  // ── backfill-overviews subcommand ────────────────────────────────────────
  program
    .command("backfill-overviews")
    .description(
      "Generate InteractionOverview records for all historical sessions.\n" +
        "Iterates every session that has at least one Stop event and upserts its overview.",
    )
    .option("--db <file>", "SQLite database file", defaultDbPath)
    .option("--no-summary", "Skip AI summarisation, use truncated prompt text instead")
    .action(async (opts: { db: string; summary: boolean }) => {
      const db = await getDb(expandHome(opts.db));
      const noSummary = !opts.summary;

      const groups = await db.event.groupBy({
        by: ["sessionId"],
        where: { event: "Stop" },
      });

      process.stderr.write(
        `claude-hook-handler backfill-overviews: ${groups.length} session(s) to process\n`,
      );

      let done = 0;
      for (const { sessionId } of groups) {
        await generateInteractionOverview(db, sessionId, noSummary);
        done++;
        process.stderr.write(`  [${done}/${groups.length}] ${sessionId.slice(0, 8)}…\n`);
      }

      process.stderr.write(`claude-hook-handler backfill-overviews: done\n`);
    });

  // ── serve subcommand ─────────────────────────────────────────────────────
  program
    .command("serve")
    .description("Start the HTTP + WebSocket API server.")
    .option("--db <file>", "SQLite database file", defaultDbPath)
    .option("--port <n>", "Port to listen on", (v: string) => parseInt(v, 10), 3000)
    .option("--repo-dir <path>", "Git repo root for automatic checkpoint indexing (default: cwd)")
    .action(async (opts: { db: string; port: number; repoDir?: string }) => {
      const { startServer } = await import("./server.js");
      await startServer(expandHome(opts.db), opts.port, opts.repoDir ?? process.cwd());
    });

  // ── default: stdin hook handler ──────────────────────────────────────────
  program
    .option(
      "--db <file>",
      "SQLite database file for event log and session state",
      defaultDbPath,
    )
    .option(
      "-s, --sessions <file>",
      "Markdown sessions table to maintain",
      defaultSessionsPath,
    )
    .option(
      "-b, --block <pattern>",
      "Regex of tool names to block (repeatable, PreToolUse only)",
      (v: string, acc: string[]) => [...acc, v],
      [] as string[],
    )
    .option(
      "--block-reason <reason>",
      "Message sent to Claude when a tool is blocked",
      "Blocked by claude-hook-handler",
    )
    .option(
      "--no-summary",
      "Skip AI summarisation, use truncated prompt text instead",
    )
    .option(
      "--max-log-lines <n>",
      "Rotate session log files after this many lines (0 to disable)",
      (v: string) => parseInt(v, 10),
      1000,
    )
    .option("--quiet", "Suppress stderr output")
    .action(async () => {
      const opts = program.opts<{
        db: string;
        sessions: string;
        block: string[];
        blockReason: string;
        summary: boolean; // commander sets this from --no-summary
        maxLogLines: number;
        quiet?: boolean;
      }>();

      const sessionsPath = expandHome(opts.sessions);
      const blockPatterns = opts.block.map((p) => new RegExp(p));
      const noSummary = !opts.summary;

      // Read stdin
      let raw: string;
      try {
        raw = await readStdin();
      } catch (err) {
        process.stderr.write(`claude-hook-handler: failed to read stdin: ${err}\n`);
        process.exit(1);
      }

      let input: HookInput;
      try {
        input = JSON.parse(raw) as HookInput;
      } catch {
        process.stderr.write(
          `claude-hook-handler: invalid JSON on stdin:\n${raw.slice(0, 200)}\n`,
        );
        process.exit(1);
      }

      const blocked = shouldBlock(input, blockPatterns);

      if (input.hook_event_name !== "Setup") {
        try {
          const db = await getDb(expandHome(opts.db));
          const state = await readStateFromDb(db);

          // Auto-link plan→implementation sessions: a SessionStart that fires within
          // 30 s of a SessionEnd in the same cwd is treated as a continuation.
          if (input.hook_event_name === "SessionStart" && !state.agentParents[input.session_id]) {
            // Explicit parent passed via spawn env var takes priority
            const spawnParent = process.env.GOSSAMER_SPAWN_PARENT_SESSION;
            if (spawnParent) {
              state.agentParents[input.session_id] = spawnParent;
            } else {
              // Fall back to auto-linking: a SessionStart within 30s of a SessionEnd in same cwd
              const recentEnd = await db.event.findFirst({
                where: { event: "SessionEnd", timestamp: { gte: new Date(Date.now() - 30_000) } },
                orderBy: { timestamp: "desc" },
              });
              if (recentEnd) {
                const prev = await db.session.findUnique({
                  where: { sessionId: recentEnd.sessionId },
                  select: { cwd: true },
                });
                if (prev?.cwd === input.cwd) {
                  state.agentParents[input.session_id] = recentEnd.sessionId;
                }
              }
            }
          }

          // 1. Compute derived state (summary/keywords via AI if needed)
          await applyEvent(state, input, noSummary);

          // 2. Write to SQLite event log — primary source of truth
          await writeEventLog(db, input, blocked, state);

          // 2b. On SessionStart, link any open items that were passed via env var
          if (input.hook_event_name === "SessionStart") {
            const raw = process.env.GOSSAMER_SPAWN_OPEN_ITEMS;
            if (raw) {
              const ids = raw.split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0);
              if (ids.length) {
                await db.openItem.updateMany({
                  where: { id: { in: ids } },
                  data: { subSessionId: input.session_id },
                });
              }
            }
          }

          // 2a. On Stop, generate/update interaction overview (non-fatal)
          if (input.hook_event_name === "Stop") {
            generateInteractionOverview(db, input.session_id, noSummary).catch((err) => {
              process.stderr.write(`claude-hook-handler: overview generation failed: ${err}\n`);
            });
          }

          // 3. Derive markdown from state
          writeMarkdown(sessionsPath, state);
          const logPaths = appendSessionLog(sessionsPath, input, state, opts.maxLogLines);

          // 4. Persist state (after appendSessionLog so pendingToolUses mutations are saved)
          await writeStateToDb(db, state);

          commitFiles(sessionsPath, [sessionsPath, ...logPaths], buildCommitMessage(input, state));
        } catch (err) {
          process.stderr.write(
            `claude-hook-handler: failed to update sessions table: ${err}\n`,
          );
          // Non-fatal — Claude Code must still get a response
        }
      }

      // stderr summary (visible inside Claude Code)
      if (!opts.quiet) {
        process.stderr.write(formatForStderr(input, blocked) + "\n");
      }

      // JSON response to stdout
      process.stdout.write(
        JSON.stringify(buildResponse(blocked, opts.blockReason)) + "\n",
      );
    });

  await program.parseAsync();
}

main().catch((err: Error) => {
  process.stderr.write(`claude-hook-handler: fatal: ${err.message}\n`);
  process.exit(1);
});
