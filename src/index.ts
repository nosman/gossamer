#!/usr/bin/env node
import {
  query,
  type HookCallback,
  type HookCallbackMatcher,
  type HookEvent,
  type HookInput,
  type HookJSONOutput,
  type SDKMessage,
  type SDKResultError,
  type SDKResultSuccess,
  type SDKSystemMessage,
  type PermissionMode,
} from "@anthropic-ai/claude-agent-sdk";
import { Command } from "commander";
import { createWriteStream, type WriteStream } from "fs";
import { resolve } from "path";

// ─── Terminal color helpers ───────────────────────────────────────────────────

const C = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  red:     "\x1b[31m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  blue:    "\x1b[34m",
  magenta: "\x1b[35m",
  cyan:    "\x1b[36m",
  white:   "\x1b[37m",
  gray:    "\x1b[90m",
} as const;

type ColorCode = keyof typeof C;

function col(text: string, ...codes: ColorCode[]): string {
  if (!process.stderr.isTTY) return text;
  return codes.map((k) => C[k]).join("") + text + C.reset;
}

// ─── Hook event styling ───────────────────────────────────────────────────────

const EVENT_STYLE: Record<string, { color: ColorCode; symbol: string }> = {
  PreToolUse:        { color: "yellow",  symbol: "▶" },
  PostToolUse:       { color: "cyan",    symbol: "✓" },
  PostToolUseFailure:{ color: "red",     symbol: "✗" },
  SessionStart:      { color: "green",   symbol: "◉" },
  SessionEnd:        { color: "red",     symbol: "◎" },
  Stop:              { color: "blue",    symbol: "■" },
  UserPromptSubmit:  { color: "magenta", symbol: "→" },
  Notification:      { color: "white",   symbol: "◆" },
  Setup:             { color: "gray",    symbol: "⚙" },
  SubagentStart:     { color: "cyan",    symbol: "▷" },
  SubagentStop:      { color: "cyan",    symbol: "◁" },
  PermissionRequest: { color: "yellow",  symbol: "?" },
  PreCompact:        { color: "gray",    symbol: "⌃" },
  WorktreeCreate:    { color: "green",   symbol: "⊕" },
  WorktreeRemove:    { color: "red",     symbol: "⊖" },
};

function formatHookEvent(input: HookInput, toolUseID?: string): string {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 23);
  const name = input.hook_event_name;
  const style = EVENT_STYLE[name] ?? { color: "white" as ColorCode, symbol: "◆" };

  const header = col(`[${ts}] ${style.symbol} ${name}`, style.color, "bold");
  const lines: string[] = [];

  // Fields present on tool-related events
  if ("tool_name" in input)
    lines.push(`  tool:    ${col(String(input.tool_name), "bold")}`);

  if (toolUseID)
    lines.push(`  id:      ${col(toolUseID, "dim")}`);

  if ("tool_input" in input && input.tool_input !== undefined) {
    const s = JSON.stringify(input.tool_input);
    lines.push(`  input:   ${s.length > 120 ? s.slice(0, 120) + "…" : s}`);
  }

  if ("tool_response" in input && input.tool_response !== undefined) {
    const s = JSON.stringify(input.tool_response);
    lines.push(`  output:  ${s.length > 120 ? s.slice(0, 120) + "…" : s}`);
  }

  if ("error" in input && input.error)
    lines.push(`  error:   ${col(String(input.error), "red")}`);

  // UserPromptSubmit
  if ("prompt" in input && input.prompt)
    lines.push(`  prompt:  ${String(input.prompt).slice(0, 100)}`);

  // Notification
  if ("message" in input && input.message)
    lines.push(`  message: ${String(input.message)}`);

  // SessionStart
  if ("source" in input && input.source)
    lines.push(`  source:  ${String(input.source)}`);

  if ("model" in input && input.model)
    lines.push(`  model:   ${String(input.model)}`);

  // SessionEnd / Stop
  if ("reason" in input && input.reason)
    lines.push(`  reason:  ${String(input.reason)}`);

  if ("last_assistant_message" in input && input.last_assistant_message)
    lines.push(`  last:    ${String(input.last_assistant_message).slice(0, 100)}`);

  // SubagentStart/Stop
  if ("agent_type" in input && input.agent_type)
    lines.push(`  agent:   ${String(input.agent_type)}`);

  lines.push(`  session: ${col(input.session_id.slice(0, 8) + "…", "dim")}`);

  return [header, ...lines, col("─".repeat(64), "dim")].join("\n");
}

// ─── Hook factory ─────────────────────────────────────────────────────────────

function makeHookCallback(
  filter: Set<string> | null,
  logStream?: WriteStream,
): HookCallback {
  return async (
    input: HookInput,
    toolUseID: string | undefined,
    _options: { signal: AbortSignal },
  ): Promise<HookJSONOutput> => {
    const name = input.hook_event_name;

    if (!filter || filter.has(name)) {
      process.stderr.write(formatHookEvent(input, toolUseID) + "\n");
    }

    if (logStream) {
      const record = JSON.stringify({
        timestamp: new Date().toISOString(),
        event: name,
        tool_use_id: toolUseID,
        data: input,
      });
      logStream.write(record + "\n");
    }

    return {};
  };
}

const ALL_HOOK_EVENTS: HookEvent[] = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "UserPromptSubmit",
  "Notification",
  "Setup",
  "SubagentStart",
  "SubagentStop",
  "PermissionRequest",
  "PreCompact",
  "WorktreeCreate",
  "WorktreeRemove",
];

function buildHooks(
  filter: Set<string> | null,
  logStream?: WriteStream,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const cb = makeHookCallback(filter, logStream);
  const matchers: HookCallbackMatcher[] = [{ hooks: [cb] }];
  return Object.fromEntries(
    ALL_HOOK_EVENTS.map((event) => [event, matchers]),
  ) as Partial<Record<HookEvent, HookCallbackMatcher[]>>;
}

// ─── Result / message helpers ─────────────────────────────────────────────────

function isResultSuccess(m: SDKMessage): m is SDKResultSuccess {
  return m.type === "result" && m.subtype === "success";
}

function isResultError(m: SDKMessage): m is SDKResultError {
  return m.type === "result" && m.subtype !== "success";
}

function isSystemInit(m: SDKMessage): m is SDKSystemMessage {
  return m.type === "system" && m.subtype === "init";
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const program = new Command();

  program
    .name("claude-hooks")
    .description(
      "Run a Claude agent task and observe all hook events in real-time.\n" +
      "Hook events are written to stderr; the final result is written to stdout.",
    )
    .version("1.0.0")
    .argument("<prompt>", "The task or question for the agent")
    .option(
      "-t, --tools <tools>",
      "Comma-separated list of auto-allowed tools",
      "Read,Glob,Grep,Bash",
    )
    .option("-c, --cwd <path>", "Working directory for file operations")
    .option(
      "-m, --mode <mode>",
      "Permission mode: default | acceptEdits | bypassPermissions | plan | dontAsk",
      "acceptEdits",
    )
    .option("--model <model>", "Claude model to use", "claude-opus-4-6")
    .option(
      "-n, --max-turns <n>",
      "Maximum agent turns before stopping",
      (v: string) => parseInt(v, 10),
    )
    .option(
      "-l, --log <file>",
      "Append NDJSON hook event records to a log file",
    )
    .option(
      "-e, --events <events>",
      "Show only these hook events (comma-separated). Omit to show all.",
    )
    .option("--quiet", "Suppress hook event display (still logs if --log set)")
    .addHelpText(
      "after",
      `
Examples:
  $ claude-hooks "list the files in this directory"
  $ claude-hooks "summarize README.md" -t Read -m default
  $ claude-hooks "refactor utils.ts" -t "Read,Edit,Write" -l hooks.log
  $ claude-hooks "find TODO comments" -e "PreToolUse,PostToolUse"
`,
    );

  program.parse();

  const [prompt] = program.args as [string];
  const opts = program.opts<{
    tools: string;
    cwd?: string;
    mode: string;
    model: string;
    maxTurns?: number;
    log?: string;
    events?: string;
    quiet?: boolean;
  }>();

  const allowedTools = opts.tools
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const eventFilter: Set<string> | null = opts.events
    ? new Set(opts.events.split(",").map((e) => e.trim()))
    : null;

  let logStream: WriteStream | undefined;
  if (opts.log) {
    logStream = createWriteStream(resolve(opts.log), { flags: "a" });
  }

  if (!opts.quiet) {
    process.stderr.write(
      col("\nClaude Hooks Listener\n", "bold") +
        col("─".repeat(64) + "\n", "dim") +
        col("Prompt:  ", "dim") +
        prompt.slice(0, 80) +
        (prompt.length > 80 ? "…" : "") +
        "\n" +
        col("Tools:   ", "dim") +
        allowedTools.join(", ") +
        "\n" +
        col("Mode:    ", "dim") +
        opts.mode +
        "\n" +
        col("Model:   ", "dim") +
        opts.model +
        "\n" +
        (opts.log ? col("Log:     ", "dim") + resolve(opts.log) + "\n" : "") +
        col("─".repeat(64) + "\n\n", "dim"),
    );
  }

  const hooks = opts.quiet && !logStream
    ? undefined
    : buildHooks(opts.quiet ? null : eventFilter, logStream);

  try {
    for await (const message of query({
      prompt,
      options: {
        allowedTools,
        cwd: opts.cwd,
        permissionMode: opts.mode as PermissionMode,
        model: opts.model,
        maxTurns: opts.maxTurns,
        hooks,
      },
    })) {
      if (isSystemInit(message) && !opts.quiet) {
        process.stderr.write(
          col(`Session: `, "dim") +
            message.session_id +
            "\n" +
            col(`Version: `, "dim") +
            message.claude_code_version +
            "\n\n",
        );
      } else if (isResultSuccess(message)) {
        if (!opts.quiet) {
          process.stderr.write(
            col("\n─── Result ──────────────────────────────────────────────────\n", "dim"),
          );
        }
        process.stdout.write(message.result + "\n");
        if (!opts.quiet) {
          process.stderr.write(
            col(
              `\nTurns: ${message.num_turns} | ` +
                `Cost: $${message.total_cost_usd.toFixed(4)} | ` +
                `In: ${message.usage.input_tokens} tokens | ` +
                `Out: ${message.usage.output_tokens} tokens\n`,
              "dim",
            ),
          );
        }
      } else if (isResultError(message)) {
        process.stderr.write(
          col(`\nAgent stopped: ${message.subtype}\n`, "red"),
        );
        if (message.errors.length > 0) {
          process.stderr.write(message.errors.join("\n") + "\n");
        }
        process.exitCode = 1;
      }
    }
  } finally {
    logStream?.end();
  }
}

main().catch((err: Error) => {
  process.stderr.write(col(`\nFatal: ${err.message}\n`, "red"));
  if (process.env.DEBUG) {
    process.stderr.write((err.stack ?? "") + "\n");
  }
  process.exit(1);
});
