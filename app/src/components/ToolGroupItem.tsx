import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import type { Event } from "../api";
import { ToolUseItem } from "./ToolUseItem";

export interface ToolUseData {
  pre: Event;
  post?: Event;
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

function toolName(pre: Event): string {
  const d = pre.data as Record<string, unknown>;
  return typeof d.tool_name === "string" ? d.tool_name : "?";
}

export function ToolGroupItem({ tools }: { tools: ToolUseData[] }) {
  const [expanded, setExpanded] = useState(false);

  const names = tools.map((t) => toolName(t.pre));
  // Build a compact deduplicated label: "Read ×3, Edit, Bash ×2"
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const summary = [...counts.entries()]
    .map(([n, c]) => (c > 1 ? `${n} ×${c}` : n))
    .join(", ");

  const anyFailed  = tools.some((t) => t.failed);
  const anyPending = tools.some((t) => !t.post);
  const anyBlocked = tools.some((t) => t.pre.blocked);

  const sym   = anyFailed ? "✗" : anyPending ? "▶" : "✓";
  const color = anyFailed ? "#ef4444" : anyPending ? "#3b82f6" : "#22c55e";

  const timeStart = fmt(tools[0].pre.timestamp);
  const lastPost  = [...tools].reverse().find((t) => t.post)?.post;
  const timeEnd   = lastPost ? fmt(lastPost.timestamp) : undefined;
  const showRange = timeEnd && timeEnd !== timeStart;

  return (
    <View style={s.wrapper}>
      {/* Tappable header row */}
      <TouchableOpacity onPress={() => setExpanded((v) => !v)} activeOpacity={0.7} style={s.header}>
        <Text style={[s.sym, { color }]}>{sym}</Text>
        <Text style={s.count}>({tools.length}) tool uses</Text>
        <Text style={s.summary} numberOfLines={1}>{summary}</Text>
        <Text style={s.time}>{timeStart}{showRange ? ` → ${timeEnd}` : ""}</Text>
        {anyBlocked && (
          <View style={s.blockedBadge}>
            <Text style={s.blockedText}>BLOCKED</Text>
          </View>
        )}
        <Text style={s.chevron}>{expanded ? "▲" : "▼"}</Text>
      </TouchableOpacity>

      {/* Expanded: individual tool items */}
      {expanded && (
        <View style={s.items}>
          {tools.map((t, i) => (
            <ToolUseItem key={i} pre={t.pre} post={t.post} failed={t.failed} />
          ))}
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrapper: {
    borderLeftWidth: 4,
    borderLeftColor: "#9ca3af",
    backgroundColor: "#f8fafc",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  sym: {
    fontSize: 12,
    fontWeight: "bold",
    width: 14,
    textAlign: "center",
  },
  count: {
    fontSize: 12,
    fontWeight: "600",
    color: "#374151",
    flexShrink: 0,
  },
  summary: {
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
  items: {
    borderTopWidth: 1,
    borderTopColor: "#e5e7eb",
  },
});
