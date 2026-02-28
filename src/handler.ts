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
} from "fs";
import { dirname, join, resolve, basename } from "path";
import { homedir } from "os";
import { execSync, spawnSync } from "child_process";
import { Command } from "commander";
import type {
  HookInput,
  SyncHookJSONOutput,
  PreToolUseHookInput,
  SubagentStartHookInput,
} from "@anthropic-ai/claude-agent-sdk";

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

// ─── Session state ────────────────────────────────────────────────────────────

interface SessionRecord {
  sessionId: string;
  startedAt: string;
  updatedAt: string;
  cwd: string;
  repoRoot?: string;
  repoName?: string;
  parentSessionId?: string;
  prompt?: string;
  summary?: string;
  keywords?: string[];
}

interface State {
  sessions: Record<string, SessionRecord>;
  // Maps agent_id → parent session_id so we can link child SessionStart events
  agentParents: Record<string, string>;
}

function readState(statePath: string): State {
  try {
    const s = JSON.parse(readFileSync(statePath, "utf8")) as Partial<State>;
    return { sessions: s.sessions ?? {}, agentParents: s.agentParents ?? {} };
  } catch {
    return { sessions: {}, agentParents: {} };
  }
}

function writeState(statePath: string, state: State): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const tmp = statePath + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, statePath); // atomic on same filesystem
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

  const header = "| Session ID | Repo | Summary | Keywords | Started | Last Updated |";
  const divider = "|---|---|---|---|---|---|";
  const rows = sessions.map((s) => {
    const id = `[\`${s.sessionId.slice(0, 8)}…\`](sessions/${s.sessionId}.md)`;
    const repo = escapeCell(s.repoName ?? s.cwd.split("/").pop() ?? s.cwd);
    const summary = escapeCell(
      s.summary ?? s.prompt?.slice(0, 80) ?? "*waiting for prompt…*",
    );
    const keywords = s.keywords?.length
      ? s.keywords.map((k) => `\`${escapeCell(k)}\``).join(" ")
      : "";
    return `| ${id} | ${repo} | ${summary} | ${keywords} | ${fmt(s.startedAt)} | ${fmt(s.updatedAt)} |`;
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

const SKIP_FIELDS = new Set(["session_id", "hook_event_name", "transcript_path"]);

function formatEventEntry(input: HookInput, childLogRelPath?: string): string {
  const ts = fmt(new Date().toISOString());
  const name = input.hook_event_name;
  const sym = EVENT_SYMBOL[name] ?? "◆";
  const lines: string[] = [`### ${ts} · ${sym} ${name}`, ""];

  for (const [key, value] of Object.entries(input)) {
    if (SKIP_FIELDS.has(key) || value === undefined) continue;

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

  lines.push("---", "");
  return lines.join("\n");
}

function sessionLogPath(sessionsPath: string, sessionId: string): string {
  return join(dirname(sessionsPath), "sessions", `${sessionId}.md`);
}

function updateLogHeader(logPath: string, rec: SessionRecord): void {
  let content = readFileSync(logPath, "utf8");

  const keywordsLine = rec.keywords?.length
    ? `**Keywords:** ${rec.keywords.map((k) => `\`${k}\``).join(" ")}`
    : "";
  const summaryLine = rec.summary ? `**Summary:** ${rec.summary}` : "";
  const metaBlock = [summaryLine, keywordsLine].filter(Boolean).join("  \n");

  if (!metaBlock) return;

  // Replace existing meta block (between heading and first event) or insert one
  const headingRe = /^(# (?:Sub)?agent Session `[^`]+`\n(?:\*\*(?:Parent|Type):[^\n]*\n)*\n)/;
  if (content.includes("**Keywords:**") || content.includes("**Summary:**")) {
    // Replace the existing meta block lines
    content = content.replace(
      /(?:^\*\*(?:Summary|Keywords):\*\*[^\n]*\n)+/m,
      metaBlock + "\n",
    );
  } else {
    // Insert after heading (and any Parent/Type lines for subagents)
    content = content.replace(headingRe, `$1${metaBlock}\n\n`);
    // Fallback: insert after the plain session heading
    if (!content.includes(metaBlock)) {
      content = content.replace(
        /^(# Session `[^`]+`\n\n)/,
        `$1${metaBlock}\n\n`,
      );
    }
  }
  writeFileSync(logPath, content, "utf8");
}

function appendSessionLog(sessionsPath: string, input: HookInput, state: State): string[] {
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

  const changedPaths = [logPath];
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

  appendFileSync(logPath, formatEventEntry(input, childLogRelPath), "utf8");
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
): Promise<void> {
  const { session_id, hook_event_name, cwd } = input;
  const now = new Date().toISOString();

  switch (hook_event_name) {
    case "SessionStart": {
      const repo = detectRepo(cwd);
      const parentSessionId = state.agentParents[session_id];
      state.sessions[session_id] = {
        sessionId: session_id,
        startedAt: now,
        updatedAt: now,
        cwd,
        repoRoot: repo?.repoRoot,
        repoName: repo?.repoName,
        parentSessionId,
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
      const { summary, keywords } = noSummary ? truncateAnalysis(prompt) : await analyse(prompt);
      // Detect repo now if SessionStart was missed
      const repo = existing?.repoRoot ? undefined : detectRepo(existing?.cwd ?? cwd);
      state.sessions[session_id] = {
        sessionId: session_id,
        startedAt: existing?.startedAt ?? now,
        updatedAt: now,
        cwd: existing?.cwd ?? cwd,
        repoRoot: existing?.repoRoot ?? repo?.repoRoot,
        repoName: existing?.repoName ?? repo?.repoName,
        parentSessionId: existing?.parentSessionId,
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

// ─── NDJSON log ───────────────────────────────────────────────────────────────

function writeLog(logPath: string, input: HookInput, blocked: boolean): void {
  const absPath = expandHome(logPath);
  mkdirSync(dirname(absPath), { recursive: true });
  appendFileSync(
    absPath,
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event: input.hook_event_name,
      blocked,
      data: input,
    }) + "\n",
    "utf8",
  );
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

  const defaultSessionsPath = config.repository
    ? join(expandHome(config.repository), "sessions.md")
    : "~/.claude/sessions.md";

  const program = new Command();

  program
    .name("claude-hook-handler")
    .description(
      "Stdin hook handler for Claude Code's settings-based hook system.\n" +
        "Maintains a live markdown sessions table and writes a JSON response to stdout.",
    )
    .version("1.0.0")
    .option(
      "-s, --sessions <file>",
      "Markdown sessions table to maintain",
      defaultSessionsPath,
    )
    .option(
      "--state <file>",
      "JSON state file for session persistence",
      "~/.claude/sessions-state.json",
    )
    .option("-l, --log <file>", "Append NDJSON event records to this file")
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
    .option("--quiet", "Suppress stderr output");

  program.parse();

  const opts = program.opts<{
    sessions: string;
    state: string;
    log?: string;
    block: string[];
    blockReason: string;
    summary: boolean; // commander sets this from --no-summary
    quiet?: boolean;
  }>();

  const sessionsPath = expandHome(opts.sessions);
  const statePath = expandHome(opts.state);
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

  // Update sessions state + markdown + per-session log (all events except setup noise)
  if (input.hook_event_name !== "Setup") {
    try {
      const state = readState(statePath);
      await applyEvent(state, input, noSummary);
      writeState(statePath, state);
      writeMarkdown(sessionsPath, state);
      const logPaths = appendSessionLog(sessionsPath, input, state);
      commitFiles(sessionsPath, [sessionsPath, ...logPaths], buildCommitMessage(input, state));
    } catch (err) {
      process.stderr.write(
        `claude-hook-handler: failed to update sessions table: ${err}\n`,
      );
      // Non-fatal
    }
  }

  // NDJSON log
  if (opts.log) {
    try {
      writeLog(opts.log, input, blocked);
    } catch (err) {
      process.stderr.write(`claude-hook-handler: failed to write log: ${err}\n`);
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
}

main().catch((err: Error) => {
  process.stderr.write(`claude-hook-handler: fatal: ${err.message}\n`);
  process.exit(1);
});
