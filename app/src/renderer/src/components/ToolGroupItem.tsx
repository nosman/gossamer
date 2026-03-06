import React, { useState } from "react";
import { StyleSheet } from "../primitives";
import type { Event } from "../api";
import { ToolUseItem } from "./ToolUseItem";

export interface ToolUseData {
  pre: Event;
  post?: Event;
  failed: boolean;
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
}

function toolName(pre: Event): string {
  const d = pre.data as Record<string, unknown>;
  return typeof d.tool_name === "string" ? d.tool_name : "?";
}

export function ToolGroupItem({ tools }: { tools: ToolUseData[] }) {
  const [expanded, setExpanded] = useState(false);

  const names = tools.map((t) => toolName(t.pre));
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const summary = [...counts.entries()].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(", ");

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
    <div style={s.wrapper}>
      <div onClick={() => setExpanded((v) => !v)} style={s.header}>
        <span style={{ ...s.sym, color } as React.CSSProperties}>{sym}</span>
        <span style={s.count}>({tools.length}) tool uses</span>
        <span style={s.summary}>{summary}</span>
        <span style={s.time}>{timeStart}{showRange ? ` → ${timeEnd}` : ""}</span>
        {anyBlocked && <span style={s.blockedBadge}>BLOCKED</span>}
        <span style={s.chevron}>{expanded ? "▲" : "▼"}</span>
      </div>
      {expanded && (
        <div style={s.items}>
          {tools.map((t, i) => (
            <ToolUseItem key={i} pre={t.pre} post={t.post} failed={t.failed} />
          ))}
        </div>
      )}
    </div>
  );
}

const s = StyleSheet.create({
  wrapper: { borderLeft: "4px solid #9ca3af", backgroundColor: "#f8fafc" } as React.CSSProperties,
  header: { display: "flex", flexDirection: "row", alignItems: "center", gap: 6, padding: "6px 12px", cursor: "pointer" } as React.CSSProperties,
  sym: { fontSize: 12, fontWeight: "bold", width: 14, textAlign: "center" } as React.CSSProperties,
  count: { fontSize: 12, fontWeight: 600, color: "#374151", flexShrink: 0 } as React.CSSProperties,
  summary: { fontSize: 11, color: "#6b7280", fontFamily: "monospace", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as React.CSSProperties,
  time: { fontSize: 10, color: "#9ca3af", flexShrink: 0 } as React.CSSProperties,
  blockedBadge: { backgroundColor: "#ef4444", borderRadius: 3, padding: "1px 4px", color: "#fff", fontSize: 9, fontWeight: "bold" } as React.CSSProperties,
  chevron: { fontSize: 9, color: "#9ca3af", flexShrink: 0 } as React.CSSProperties,
  items: { borderTop: "1px solid #e5e7eb" } as React.CSSProperties,
});
