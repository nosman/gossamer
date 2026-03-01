import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import type { Event } from "../api";

interface Props {
  pre: Event;
  post?: Event; // undefined = still pending
  failed: boolean;
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return (
    String(d.getHours()).padStart(2, "0") + ":" +
    String(d.getMinutes()).padStart(2, "0") + ":" +
    String(d.getSeconds()).padStart(2, "0")
  );
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

function truncated(val: unknown, max = 800): string | undefined {
  if (val === undefined) return undefined;
  const s = typeof val === "string" ? val : JSON.stringify(val, null, 2);
  return s.length > max ? s.slice(0, max) + "\n…" : s;
}

export function ToolUseItem({ pre, post, failed }: Props) {
  const [expanded, setExpanded] = useState(false);

  const preData = pre.data as Record<string, unknown>;
  const toolName = typeof preData.tool_name === "string" ? preData.tool_name : "?";
  const hint = toolHint(toolName, pre.data);

  const sym = !post ? "▶" : failed ? "✗" : "✓";
  const color = !post ? "#3b82f6" : failed ? "#ef4444" : "#22c55e";

  const inputStr = truncated(preData.tool_input);

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
      style={styles.container}
    >
      <View style={styles.header}>
        <Text style={[styles.sym, { color }]}>{sym}</Text>
        <Text style={[styles.toolName, { color }]}>{toolName}</Text>
        {hint ? (
          <Text style={styles.hint} numberOfLines={1}>{hint}</Text>
        ) : null}
        <Text style={styles.time}>
          {timeStart}{showRange ? ` → ${timeEnd}` : ""}
        </Text>
        {pre.blocked && (
          <View style={styles.blockedBadge}>
            <Text style={styles.blockedText}>BLOCKED</Text>
          </View>
        )}
        <Text style={styles.chevron}>{expanded ? "▲" : "▼"}</Text>
      </View>

      {expanded && (
        <View style={styles.body}>
          {inputStr !== undefined && (
            <>
              <Text style={styles.sectionLabel}>input</Text>
              <Text style={styles.code}>{inputStr}</Text>
            </>
          )}
          {outputStr !== undefined && (
            <>
              <Text style={[styles.sectionLabel, failed && styles.sectionLabelError]}>
                {failed ? "error" : "output"}
              </Text>
              <Text style={styles.code}>{outputStr}</Text>
            </>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
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
  code: {
    fontFamily: "monospace",
    fontSize: 11,
    color: "#1e293b",
    backgroundColor: "#f8fafc",
    padding: 6,
    borderRadius: 3,
    lineHeight: 15,
  },
});
