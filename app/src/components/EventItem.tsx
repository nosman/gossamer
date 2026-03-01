import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import type { Event } from "../api";
import { MarkdownView } from "./MarkdownView";

interface Props {
  event: Event;
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

function data(event: Event): Record<string, unknown> {
  return (event.data ?? {}) as Record<string, unknown>;
}

// ─── Blocked badge ────────────────────────────────────────────────────────────

function BlockedBadge() {
  return (
    <View style={s.blockedBadge}>
      <Text style={s.blockedText}>BLOCKED</Text>
    </View>
  );
}

// ─── UserPromptSubmit card ────────────────────────────────────────────────────

function UserPromptCard({ event }: { event: Event }) {
  const prompt = str(data(event).prompt);
  return (
    <View style={s.userCard}>
      <View style={s.cardHeader}>
        <Text style={s.userLabel}>→ User</Text>
        <Text style={s.cardTime}>{fmt(event.timestamp)}</Text>
        {event.blocked && <BlockedBadge />}
      </View>
      <Text style={s.promptText} selectable>{prompt || "(no prompt)"}</Text>
    </View>
  );
}

// ─── Stop / Assistant card ────────────────────────────────────────────────────

function AssistantCard({ event }: { event: Event }) {
  const d = data(event);
  const msg = str(d.last_assistant_message);
  const reason = str(d.reason);
  return (
    <View style={s.assistantCard}>
      <View style={s.cardHeader}>
        <Text style={s.assistantLabel}>■ Assistant</Text>
        {reason ? <Text style={s.reasonBadge}>{reason}</Text> : null}
        <Text style={s.cardTime}>{fmt(event.timestamp)}</Text>
        {event.blocked && <BlockedBadge />}
      </View>
      {msg
        ? <MarkdownView text={msg} />
        : <Text style={s.emptyMsg}>(no message)</Text>}
    </View>
  );
}

// ─── Notification row ─────────────────────────────────────────────────────────

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
    <View style={[s.notifRow, { backgroundColor: style.bg }]}>
      <Text style={[s.notifSym, { color: style.color }]}>{style.sym}</Text>
      <Text style={[s.notifMsg, { color: style.color }]}>{msg}</Text>
      <Text style={s.compactTime}>{fmt(event.timestamp)}</Text>
      {event.blocked && <BlockedBadge />}
    </View>
  );
}

// ─── SessionStart / SessionEnd row ────────────────────────────────────────────

function SessionRow({ event }: { event: Event }) {
  const d = data(event);
  const isStart = event.event === "SessionStart";
  const color = "#8b5cf6";
  const sym = isStart ? "◉" : "◎";
  const extra = isStart ? str(d.source) : str(d.reason);
  const cwd = str(d.cwd);
  return (
    <View style={s.sessionRow}>
      <Text style={[s.sessionSym, { color }]}>{sym}</Text>
      <View style={s.sessionBody}>
        <Text style={[s.sessionEvent, { color }]}>{event.event}</Text>
        {extra ? <Text style={s.sessionExtra}>{extra}</Text> : null}
        {cwd ? <Text style={s.sessionCwd} numberOfLines={1}>{cwd}</Text> : null}
      </View>
      <Text style={s.compactTime}>{fmt(event.timestamp)}</Text>
      {event.blocked && <BlockedBadge />}
    </View>
  );
}

// ─── Generic compact row ──────────────────────────────────────────────────────

const EVENT_SYMBOL: Record<string, string> = {
  SubagentStart: "▷",
  SubagentStop: "◁",
  PreCompact: "⌃",
  Setup: "⚙",
  PermissionRequest: "?",
};

const EVENT_COLOR: Record<string, string> = {
  SubagentStart: "#06b6d4",
  SubagentStop: "#06b6d4",
  PreCompact: "#94a3b8",
  Setup: "#94a3b8",
  PermissionRequest: "#f59e0b",
};

function CompactRow({ event }: { event: Event }) {
  const [expanded, setExpanded] = useState(false);
  const sym = EVENT_SYMBOL[event.event] ?? "◆";
  const color = EVENT_COLOR[event.event] ?? "#64748b";
  const d = data(event);
  // Show any interesting text field
  const body = str(d.message) || str(d.reason) || str(d.source);
  const hasBody = body.length > 0;
  return (
    <TouchableOpacity
      onPress={hasBody ? () => setExpanded((v) => !v) : undefined}
      activeOpacity={hasBody ? 0.7 : 1}
      style={s.compactRow}
    >
      <Text style={[s.compactSym, { color }]}>{sym}</Text>
      <Text style={[s.compactEvent, { color }]}>{event.event}</Text>
      <Text style={s.compactTime}>{fmt(event.timestamp)}</Text>
      {event.blocked && <BlockedBadge />}
      {hasBody && <Text style={s.chevron}>{expanded ? "▲" : "▼"}</Text>}
      {expanded && body ? (
        <Text style={s.compactBody}>{body}</Text>
      ) : null}
    </TouchableOpacity>
  );
}

// ─── Main export ─────────────────────────────────────────────────────────────

export function EventItem({ event }: Props) {
  if (event.event === "UserPromptSubmit") return <UserPromptCard event={event} />;
  if (event.event === "Stop") return <AssistantCard event={event} />;
  if (event.event === "Notification") return <NotificationRow event={event} />;
  if (event.event === "SessionStart" || event.event === "SessionEnd") return <SessionRow event={event} />;
  return <CompactRow event={event} />;
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  // User card
  userCard: {
    borderLeftWidth: 4,
    borderLeftColor: "#6366f1",
    backgroundColor: "#f5f3ff",
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginVertical: 4,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 6,
  },
  userLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: "#4338ca",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  cardTime: {
    fontSize: 11,
    color: "#9ca3af",
    marginLeft: "auto",
  },
  promptText: {
    fontSize: 14,
    color: "#1e1b4b",
    lineHeight: 22,
  },

  // Assistant card
  assistantCard: {
    borderLeftWidth: 4,
    borderLeftColor: "#f59e0b",
    backgroundColor: "#fff",
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginVertical: 4,
  },
  assistantLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: "#b45309",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  reasonBadge: {
    fontSize: 10,
    color: "#92400e",
    backgroundColor: "#fde68a",
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
  },
  emptyMsg: {
    fontSize: 13,
    color: "#9ca3af",
    fontStyle: "italic",
  },

  // Notification
  notifRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 5,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
  },
  notifSym: {
    fontSize: 13,
    fontWeight: "700",
    width: 16,
    textAlign: "center",
  },
  notifMsg: {
    fontSize: 12,
    flex: 1,
  },

  // Session
  sessionRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
  },
  sessionSym: {
    fontSize: 14,
    fontWeight: "bold",
    width: 18,
    textAlign: "center",
    lineHeight: 20,
  },
  sessionBody: {
    flex: 1,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    alignItems: "center",
  },
  sessionEvent: {
    fontSize: 12,
    fontWeight: "600",
  },
  sessionExtra: {
    fontSize: 11,
    color: "#6b7280",
    backgroundColor: "#f3f4f6",
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
  },
  sessionCwd: {
    fontSize: 10,
    color: "#9ca3af",
    fontFamily: "monospace",
    flex: 1,
  },

  // Compact
  compactRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 4,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
    flexWrap: "wrap",
  },
  compactSym: {
    fontSize: 12,
    fontWeight: "bold",
    width: 14,
    textAlign: "center",
  },
  compactEvent: {
    fontSize: 11,
    fontWeight: "600",
    flex: 1,
  },
  compactTime: {
    fontSize: 10,
    color: "#9ca3af",
    marginLeft: "auto",
  },
  compactBody: {
    width: "100%",
    fontSize: 11,
    color: "#6b7280",
    fontStyle: "italic",
    paddingLeft: 20,
    paddingTop: 2,
  },
  chevron: {
    fontSize: 9,
    color: "#9ca3af",
  },

  // Shared
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
});
