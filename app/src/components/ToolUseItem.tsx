import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import type { Event } from "../api";

interface Props {
  pre: Event;
  post?: Event; // undefined = still pending
  failed: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(iso: string): string {
  const d = new Date(iso);
  return (
    String(d.getHours()).padStart(2, "0") + ":" +
    String(d.getMinutes()).padStart(2, "0") + ":" +
    String(d.getSeconds()).padStart(2, "0")
  );
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function toolHint(toolName: string, data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const inp = (data as Record<string, unknown>).tool_input;
  if (!inp || typeof inp !== "object") return "";
  const i = inp as Record<string, unknown>;
  const s = (k: string) => (typeof i[k] === "string" ? String(i[k]) : undefined);
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":      return s("file_path") ?? "";
    case "Bash":      return (s("command") ?? "").replace(/\s+/g, " ").slice(0, 80);
    case "Glob":      return s("pattern") ?? "";
    case "Grep":      return s("pattern") ?? "";
    case "WebFetch":  return s("url") ?? "";
    case "WebSearch": return s("query") ?? "";
    default:          return "";
  }
}

function truncated(val: unknown, max = 1200): string | undefined {
  if (val === undefined) return undefined;
  const s = typeof val === "string" ? val : JSON.stringify(val, null, 2);
  return s.length > max ? s.slice(0, max) + "\n…" : s;
}

// ─── Diff view for Edit tool ──────────────────────────────────────────────────

function DiffView({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  return (
    <View style={ts.diffWrap}>
      {oldStr ? (
        <View style={ts.diffDel}>
          <Text style={ts.diffText} selectable>
            {oldStr.split("\n").map((l) => "− " + l).join("\n")}
          </Text>
        </View>
      ) : null}
      {newStr ? (
        <View style={ts.diffAdd}>
          <Text style={ts.diffText} selectable>
            {newStr.split("\n").map((l) => "+ " + l).join("\n")}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

// ─── Tool-specific input renderers ────────────────────────────────────────────

function renderInput(toolName: string, inp: Record<string, unknown>): React.ReactNode {
  switch (toolName) {
    case "Edit": {
      const fp = str(inp.file_path);
      const oldStr = str(inp.old_string);
      const newStr = str(inp.new_string);
      return (
        <View>
          {fp ? <Text style={ts.filePath}>{fp}</Text> : null}
          <DiffView oldStr={oldStr} newStr={newStr} />
        </View>
      );
    }
    case "Write": {
      const fp = str(inp.file_path);
      const content = str(inp.content);
      return (
        <View>
          {fp ? <Text style={ts.filePath}>{fp}</Text> : null}
          <Text style={ts.code} selectable>
            {content.length > 1200 ? content.slice(0, 1200) + "\n…" : content}
          </Text>
        </View>
      );
    }
    case "Read": {
      const fp = str(inp.file_path);
      const offset = inp.offset != null ? `  offset: ${inp.offset}` : "";
      const limit  = inp.limit  != null ? `  limit: ${inp.limit}`   : "";
      return <Text style={ts.filePath}>{fp}{offset}{limit}</Text>;
    }
    case "Bash": {
      const cmd = str(inp.command);
      return <Text style={ts.code} selectable>{cmd}</Text>;
    }
    case "Glob":
    case "Grep": {
      const pattern = str(inp.pattern);
      const extra = str(inp.path || inp.glob || inp.type || "");
      return (
        <Text style={ts.code} selectable>
          {pattern}{extra ? `\n${extra}` : ""}
        </Text>
      );
    }
    case "WebFetch": {
      const url = str(inp.url);
      const prompt = str(inp.prompt);
      return (
        <View>
          <Text style={ts.filePath}>{url}</Text>
          {prompt ? <Text style={ts.code} selectable>{prompt}</Text> : null}
        </View>
      );
    }
    case "WebSearch": {
      return <Text style={ts.code} selectable>{str(inp.query)}</Text>;
    }
    default: {
      const raw = JSON.stringify(inp, null, 2);
      return (
        <Text style={ts.code} selectable>
          {raw.length > 1200 ? raw.slice(0, 1200) + "\n…" : raw}
        </Text>
      );
    }
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

export function ToolUseItem({ pre, post, failed }: Props) {
  const [expanded, setExpanded] = useState(false);

  const preData = pre.data as Record<string, unknown>;
  const toolName = typeof preData.tool_name === "string" ? preData.tool_name : "?";
  const hint = toolHint(toolName, pre.data);

  const sym = !post ? "▶" : failed ? "✗" : "✓";
  const color = !post ? "#3b82f6" : failed ? "#ef4444" : "#22c55e";

  const toolInput = preData.tool_input as Record<string, unknown> | undefined;

  let outputStr: string | undefined;
  if (post) {
    const postData = post.data as Record<string, unknown>;
    outputStr = failed
      ? truncated(postData.error)
      : truncated(postData.tool_response);
  }

  const timeStart = fmt(pre.timestamp);
  const timeEnd = post ? fmt(post.timestamp) : undefined;
  const showRange = timeEnd && timeEnd !== timeStart;

  return (
    <TouchableOpacity
      onPress={() => setExpanded((v) => !v)}
      activeOpacity={0.7}
      style={ts.container}
    >
      <View style={ts.header}>
        <Text style={[ts.sym, { color }]}>{sym}</Text>
        <Text style={[ts.toolName, { color }]}>{toolName}</Text>
        {hint ? (
          <Text style={ts.hint} numberOfLines={1}>{hint}</Text>
        ) : null}
        <Text style={ts.time}>
          {timeStart}{showRange ? ` → ${timeEnd}` : ""}
        </Text>
        {pre.blocked && (
          <View style={ts.blockedBadge}>
            <Text style={ts.blockedText}>BLOCKED</Text>
          </View>
        )}
        <Text style={ts.chevron}>{expanded ? "▲" : "▼"}</Text>
      </View>

      {expanded && (
        <View style={ts.body}>
          {toolInput !== undefined && (
            <>
              <Text style={ts.sectionLabel}>input</Text>
              {renderInput(toolName, toolInput)}
            </>
          )}
          {outputStr !== undefined && (
            <>
              <Text style={[ts.sectionLabel, failed && ts.sectionLabelError]}>
                {failed ? "error" : "output"}
              </Text>
              <Text style={ts.code} selectable>{outputStr}</Text>
            </>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const ts = StyleSheet.create({
  container: {
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  sym: {
    fontSize: 12,
    fontWeight: "bold",
    width: 14,
    textAlign: "center",
  },
  toolName: {
    fontSize: 12,
    fontWeight: "600",
    fontFamily: "monospace",
    flexShrink: 0,
  },
  hint: {
    fontSize: 11,
    color: "#6b7280",
    fontFamily: "monospace",
    flex: 1,
  },
  time: {
    fontSize: 10,
    color: "#9ca3af",
    flexShrink: 0,
  },
  blockedBadge: {
    backgroundColor: "#ef4444",
    borderRadius: 3,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  blockedText: {
    color: "#fff",
    fontSize: 9,
    fontWeight: "bold",
  },
  chevron: {
    fontSize: 9,
    color: "#9ca3af",
    flexShrink: 0,
  },
  body: {
    marginTop: 4,
    marginLeft: 20,
    marginBottom: 4,
  },
  sectionLabel: {
    fontSize: 10,
    color: "#6b7280",
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginTop: 6,
    marginBottom: 2,
  },
  sectionLabelError: {
    color: "#ef4444",
  },
  filePath: {
    fontFamily: "monospace",
    fontSize: 11,
    color: "#4338ca",
    marginBottom: 4,
    fontWeight: "600",
  },
  code: {
    fontFamily: "monospace",
    fontSize: 11,
    color: "#1e293b",
    backgroundColor: "#f8fafc",
    padding: 6,
    borderRadius: 3,
    lineHeight: 15,
  },
  diffWrap: {
    gap: 4,
  },
  diffDel: {
    backgroundColor: "#fef2f2",
    borderLeftWidth: 3,
    borderLeftColor: "#fca5a5",
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 2,
  },
  diffAdd: {
    backgroundColor: "#f0fdf4",
    borderLeftWidth: 3,
    borderLeftColor: "#86efac",
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 2,
  },
  diffText: {
    fontFamily: "monospace",
    fontSize: 11,
    lineHeight: 16,
    color: "#1e293b",
  },
});
