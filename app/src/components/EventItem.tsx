import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import type { Event } from "../api";

interface Props {
  event: Event;
}

const EVENT_SYMBOL: Record<string, string> = {
  PreToolUse: "▶",
  PostToolUse: "✓",
  PostToolUseFailure: "✗",
  SessionStart: "◉",
  SessionEnd: "◎",
  Stop: "■",
  UserPromptSubmit: "→",
  Notification: "◆",
  Setup: "⚙",
  SubagentStart: "▷",
  SubagentStop: "◁",
  PermissionRequest: "?",
  PreCompact: "⌃",
};

const EVENT_COLOR: Record<string, string> = {
  PreToolUse: "#3b82f6",
  PostToolUse: "#22c55e",
  PostToolUseFailure: "#ef4444",
  SessionStart: "#8b5cf6",
  SessionEnd: "#8b5cf6",
  Stop: "#f59e0b",
  UserPromptSubmit: "#6366f1",
  Notification: "#64748b",
  SubagentStart: "#06b6d4",
  SubagentStop: "#06b6d4",
};

function fmt(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${min}:${ss}`;
}

function getToolName(data: unknown): string | undefined {
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d.tool_name === "string") return d.tool_name;
  }
  return undefined;
}

function getMessage(data: unknown): string | undefined {
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (typeof d.last_assistant_message === "string") return d.last_assistant_message;
    if (typeof d.message === "string") return d.message;
    if (typeof d.prompt === "string") return d.prompt;
  }
  return undefined;
}

function getToolInput(data: unknown): string | undefined {
  if (data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    if (d.tool_input !== undefined) {
      const s = JSON.stringify(d.tool_input, null, 2);
      return s.length > 800 ? s.slice(0, 800) + "\n…" : s;
    }
  }
  return undefined;
}

export function EventItem({ event }: Props) {
  const [expanded, setExpanded] = useState(false);
  const sym = EVENT_SYMBOL[event.event] ?? "◆";
  const color = EVENT_COLOR[event.event] ?? "#64748b";
  const toolName = getToolName(event.data);
  const message = getMessage(event.data);
  const toolInput = getToolInput(event.data);
  const hasExpandable = toolInput !== undefined;

  const isPrompt = event.event === "UserPromptSubmit";
  const isMessage = event.event === "Stop" || event.event === "Notification";

  return (
    <TouchableOpacity
      onPress={hasExpandable ? () => setExpanded((v) => !v) : undefined}
      activeOpacity={hasExpandable ? 0.7 : 1}
      style={styles.container}
    >
      <View style={styles.header}>
        <Text style={[styles.symbol, { color }]}>{sym}</Text>
        <Text style={[styles.eventName, { color }]}>{event.event}</Text>
        {toolName && <Text style={styles.toolName}>{toolName}</Text>}
        <Text style={styles.timestamp}>{fmt(event.timestamp)}</Text>
        {event.blocked && (
          <View style={styles.blockedBadge}>
            <Text style={styles.blockedText}>BLOCKED</Text>
          </View>
        )}
        {hasExpandable && (
          <Text style={styles.expandHint}>{expanded ? "▲" : "▼"}</Text>
        )}
      </View>

      {(isPrompt || isMessage) && message && (
        <Text style={styles.bodyText} numberOfLines={isPrompt ? 3 : 5}>
          {message}
        </Text>
      )}

      {expanded && toolInput && (
        <Text style={styles.codeBlock}>{toolInput}</Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 6,
  },
  symbol: {
    fontSize: 14,
    fontWeight: "bold",
    minWidth: 18,
  },
  eventName: {
    fontSize: 13,
    fontWeight: "600",
  },
  toolName: {
    fontSize: 13,
    color: "#374151",
    backgroundColor: "#f3f4f6",
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: 4,
    fontFamily: "monospace",
  },
  timestamp: {
    fontSize: 11,
    color: "#9ca3af",
    marginLeft: "auto",
  },
  blockedBadge: {
    backgroundColor: "#ef4444",
    borderRadius: 4,
    paddingHorizontal: 5,
    paddingVertical: 1,
  },
  blockedText: {
    color: "#fff",
    fontSize: 10,
    fontWeight: "bold",
  },
  expandHint: {
    fontSize: 10,
    color: "#9ca3af",
  },
  bodyText: {
    marginTop: 4,
    fontSize: 13,
    color: "#6b7280",
    fontStyle: "italic",
    lineHeight: 18,
  },
  codeBlock: {
    marginTop: 6,
    padding: 8,
    backgroundColor: "#f8fafc",
    borderRadius: 4,
    fontFamily: "monospace",
    fontSize: 11,
    color: "#1e293b",
    lineHeight: 16,
  },
});
