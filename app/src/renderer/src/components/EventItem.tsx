import React, { useState } from "react";
import { View, TouchableOpacity, StyleSheet } from "../primitives";
import type { Event } from "../api";
import { MarkdownView } from "./MarkdownView";

function fmt(iso: string): string {
  const d = new Date(iso);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
}
function str(v: unknown): string { return typeof v === "string" ? v : ""; }
function data(event: Event): Record<string, unknown> { return (event.data ?? {}) as Record<string, unknown>; }

function BlockedBadge() {
  return <span style={s.blockedBadge}>BLOCKED</span>;
}

function UserPromptCard({ event }: { event: Event }) {
  const prompt = str(data(event).prompt);
  return (
    <div style={s.userCard}>
      <div style={s.userRow}>
        <span style={s.cardTime}>{fmt(event.timestamp)}</span>
        <span style={s.promptText}>{prompt || "(no prompt)"}</span>
        {event.blocked && <BlockedBadge />}
      </div>
    </div>
  );
}

function AssistantCard({ event }: { event: Event }) {
  const d = data(event);
  const msg = str(d.last_assistant_message);
  const reason = str(d.reason);
  return (
    <div style={s.assistantCard}>
      <div style={s.cardHeader}>
        {reason ? <span style={s.reasonBadge}>{reason}</span> : null}
        <span style={s.cardTime}>{fmt(event.timestamp)}</span>
        {event.blocked && <BlockedBadge />}
      </div>
      <MarkdownView text={msg || "(no message)"} />
    </div>
  );
}

const NOTIF_STYLE: Record<string, { color: string; bg: string; sym: string }> = {
  permission_prompt: { color: "#b45309", bg: "#fffbeb", sym: "?" },
  idle_prompt:       { color: "#6b7280", bg: "#f9fafb", sym: "…" },
};

function NotificationRow({ event }: { event: Event }) {
  const d = data(event);
  const msg = str(d.message);
  const ntype = str(d.notification_type);
  const style = NOTIF_STYLE[ntype] ?? { color: "#6b7280", bg: "#f9fafb", sym: "◆" };
  return (
    <div style={{ ...s.notifRow, backgroundColor: style.bg } as React.CSSProperties}>
      <span style={{ ...s.notifSym, color: style.color } as React.CSSProperties}>{style.sym}</span>
      <span style={{ ...s.notifMsg, color: style.color } as React.CSSProperties}>{msg}</span>
      <span style={s.compactTime}>{fmt(event.timestamp)}</span>
      {event.blocked && <BlockedBadge />}
    </div>
  );
}

function SessionEventRow({ event }: { event: Event }) {
  const d = data(event);
  const isStart = event.event === "SessionStart";
  const color = "#8b5cf6";
  const sym = isStart ? "◉" : "◎";
  const extra = isStart ? str(d.source) : str(d.reason);
  const cwd = str(d.cwd);
  return (
    <div style={s.sessionRow}>
      <span style={{ ...s.sessionSym, color }}>{sym}</span>
      <div style={s.sessionBody}>
        <span style={{ ...s.sessionEvent, color }}>{event.event}</span>
        {extra ? <span style={s.sessionExtra}>{extra}</span> : null}
        {cwd ? <span style={s.sessionCwd}>{cwd}</span> : null}
      </div>
      <span style={s.compactTime}>{fmt(event.timestamp)}</span>
      {event.blocked && <BlockedBadge />}
    </div>
  );
}

const EVENT_SYMBOL: Record<string, string> = { SubagentStart: "▷", SubagentStop: "◁", PreCompact: "⌃", Setup: "⚙", PermissionRequest: "?" };
const EVENT_COLOR: Record<string, string> = { SubagentStart: "#06b6d4", SubagentStop: "#06b6d4", PreCompact: "#94a3b8", Setup: "#94a3b8", PermissionRequest: "#f59e0b" };

function CompactRow({ event }: { event: Event }) {
  const [expanded, setExpanded] = useState(false);
  const sym = EVENT_SYMBOL[event.event] ?? "◆";
  const color = EVENT_COLOR[event.event] ?? "#64748b";
  const d = data(event);
  const body = str(d.message) || str(d.reason) || str(d.source);
  return (
    <div onClick={body ? () => setExpanded((v) => !v) : undefined} style={{ ...s.compactRow, cursor: body ? "pointer" : "default" } as React.CSSProperties}>
      <span style={{ ...s.compactSym, color } as React.CSSProperties}>{sym}</span>
      <span style={{ ...s.compactEvent, color } as React.CSSProperties}>{event.event}</span>
      <span style={s.compactTime}>{fmt(event.timestamp)}</span>
      {event.blocked && <BlockedBadge />}
      {body && <span style={s.chevron}>{expanded ? "▲" : "▼"}</span>}
      {expanded && body && <span style={s.compactBody}>{body}</span>}
    </div>
  );
}

export function EventItem({ event }: { event: Event }) {
  if (event.event === "UserPromptSubmit") return <UserPromptCard event={event} />;
  if (event.event === "Stop") return <AssistantCard event={event} />;
  if (event.event === "Notification") return <NotificationRow event={event} />;
  if (event.event === "SessionStart" || event.event === "SessionEnd") return <SessionEventRow event={event} />;
  return <CompactRow event={event} />;
}

const s = StyleSheet.create({
  userCard: { borderLeft: "4px solid #6366f1", backgroundColor: "#ddd6fe", padding: "10px 14px" } as React.CSSProperties,
  userRow: { display: "flex", flexDirection: "row", alignItems: "baseline", gap: 8 } as React.CSSProperties,
  cardHeader: { display: "flex", flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 4 } as React.CSSProperties,
  cardTime: { fontSize: 11, color: "#9ca3af", flexShrink: 0 } as React.CSSProperties,
  promptText: { fontFamily: "monospace", fontSize: 12, color: "#1e1b4b", lineHeight: "18px", flex: 1 } as React.CSSProperties,
  assistantCard: { borderLeft: "4px solid #f59e0b", backgroundColor: "#fff", padding: "10px 14px" } as React.CSSProperties,
  reasonBadge: { fontSize: 10, color: "#92400e", backgroundColor: "#fde68a", padding: "1px 5px", borderRadius: 3 } as React.CSSProperties,
  notifRow: { display: "flex", flexDirection: "row", alignItems: "center", gap: 8, padding: "5px 12px", borderBottom: "1px solid #f1f5f9" } as React.CSSProperties,
  notifSym: { fontSize: 13, fontWeight: 700, width: 16, textAlign: "center" } as React.CSSProperties,
  notifMsg: { fontSize: 12, flex: 1 } as React.CSSProperties,
  sessionRow: { display: "flex", flexDirection: "row", alignItems: "flex-start", gap: 8, padding: "6px 12px", borderBottom: "1px solid #f1f5f9" } as React.CSSProperties,
  sessionSym: { fontSize: 14, fontWeight: "bold", width: 18, textAlign: "center", lineHeight: "20px" } as React.CSSProperties,
  sessionBody: { flex: 1, display: "flex", flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center" } as React.CSSProperties,
  sessionEvent: { fontSize: 12, fontWeight: 600 } as React.CSSProperties,
  sessionExtra: { fontSize: 11, color: "#6b7280", backgroundColor: "#f3f4f6", padding: "1px 5px", borderRadius: 3 } as React.CSSProperties,
  sessionCwd: { fontSize: 10, color: "#9ca3af", fontFamily: "monospace", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as React.CSSProperties,
  compactRow: { display: "flex", flexDirection: "row", alignItems: "center", gap: 6, padding: "4px 12px", borderBottom: "1px solid #f1f5f9", flexWrap: "wrap" } as React.CSSProperties,
  compactSym: { fontSize: 12, fontWeight: "bold", width: 14, textAlign: "center" } as React.CSSProperties,
  compactEvent: { fontSize: 11, fontWeight: 600, flex: 1 } as React.CSSProperties,
  compactTime: { fontSize: 10, color: "#9ca3af", marginLeft: "auto" } as React.CSSProperties,
  compactBody: { width: "100%", fontSize: 11, color: "#6b7280", fontStyle: "italic", paddingLeft: 20, paddingTop: 2 } as React.CSSProperties,
  chevron: { fontSize: 9, color: "#9ca3af" } as React.CSSProperties,
  blockedBadge: { backgroundColor: "#ef4444", borderRadius: 3, padding: "1px 4px", color: "#fff", fontSize: 9, fontWeight: "bold" } as React.CSSProperties,
});
