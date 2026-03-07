import React, { useState } from "react";
import { Box, Badge, Group, Text, Collapse } from "@mantine/core";
import type { Event } from "../api";
import { MarkdownView } from "./MarkdownView";

function fmt(iso: string): string {
  const d = new Date(iso);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
}
function str(v: unknown): string { return typeof v === "string" ? v : ""; }
function data(event: Event): Record<string, unknown> { return (event.data ?? {}) as Record<string, unknown>; }

function BlockedBadge() {
  return <Badge color="red" size="xs" variant="filled" fw={700}>BLOCKED</Badge>;
}

function UserPromptCard({ event }: { event: Event }) {
  const prompt = str(data(event).prompt);
  return (
    <Box style={{ borderLeft: "4px solid var(--mantine-color-indigo-5)", backgroundColor: "light-dark(var(--mantine-color-indigo-1), var(--mantine-color-dark-6))", padding: "10px 14px" }}>
      <Group gap={8} align="baseline">
        <Text size="xs" c="dimmed">{fmt(event.timestamp)}</Text>
        <Text ff="monospace" size="xs" c="indigo" style={{ flex: 1, lineHeight: "18px" }}>{prompt || "(no prompt)"}</Text>
        {event.blocked && <BlockedBadge />}
      </Group>
    </Box>
  );
}

function AssistantCard({ event }: { event: Event }) {
  const d = data(event);
  const msg = str(d.last_assistant_message);
  const reason = str(d.reason);
  return (
    <Box style={{ borderLeft: "4px solid var(--mantine-color-orange-4)", backgroundColor: "light-dark(#fff, var(--mantine-color-dark-7))", padding: "10px 14px" }}>
      <Group gap={8} mb={4}>
        {reason && <Badge color="orange" size="xs" variant="light">{reason}</Badge>}
        <Text size="xs" c="dimmed">{fmt(event.timestamp)}</Text>
        {event.blocked && <BlockedBadge />}
      </Group>
      <MarkdownView text={msg || "(no message)"} />
    </Box>
  );
}

const NOTIF_STYLE: Record<string, { color: string; bg: string; sym: string }> = {
  permission_prompt: { color: "#b45309", bg: "light-dark(#fffbeb, var(--mantine-color-dark-6))", sym: "?" },
  idle_prompt:       { color: "#6b7280", bg: "light-dark(#f9fafb, var(--mantine-color-dark-7))", sym: "…" },
};

function NotificationRow({ event }: { event: Event }) {
  const d = data(event);
  const msg = str(d.message);
  const ntype = str(d.notification_type);
  const style = NOTIF_STYLE[ntype] ?? { color: "#6b7280", bg: "light-dark(#f9fafb, var(--mantine-color-dark-7))", sym: "◆" };
  return (
    <Group gap={8} px={12} py={5} style={{ backgroundColor: style.bg, borderBottom: "1px solid var(--mantine-color-gray-1)" }}>
      <Text size="sm" fw={700} style={{ color: style.color, width: 16, textAlign: "center" }}>{style.sym}</Text>
      <Text size="xs" style={{ color: style.color, flex: 1 }}>{msg}</Text>
      <Text size="xs" c="dimmed">{fmt(event.timestamp)}</Text>
      {event.blocked && <BlockedBadge />}
    </Group>
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
    <Group gap={8} px={12} py={6} style={{ borderBottom: "1px solid var(--mantine-color-gray-1)" }} align="flex-start">
      <Text size="sm" fw={700} style={{ color, width: 18, textAlign: "center", lineHeight: "20px" }}>{sym}</Text>
      <Group gap={6} style={{ flex: 1 }} wrap="wrap">
        <Text size="xs" fw={600} style={{ color }}>{event.event}</Text>
        {extra && <Badge variant="light" color="gray" size="xs">{extra}</Badge>}
        {cwd && <Text size="xs" c="dimmed" ff="monospace" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cwd}</Text>}
      </Group>
      <Text size="xs" c="dimmed">{fmt(event.timestamp)}</Text>
      {event.blocked && <BlockedBadge />}
    </Group>
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
    <Box
      onClick={body ? () => setExpanded((v) => !v) : undefined}
      style={{ cursor: body ? "pointer" : "default", borderBottom: "1px solid var(--mantine-color-gray-1)", padding: "4px 12px" }}
    >
      <Group gap={6} wrap="wrap">
        <Text size="xs" fw={700} style={{ color, width: 14, textAlign: "center" }}>{sym}</Text>
        <Text size="xs" fw={600} style={{ color, flex: 1 }}>{event.event}</Text>
        <Text size="xs" c="dimmed">{fmt(event.timestamp)}</Text>
        {event.blocked && <BlockedBadge />}
        {body && <Text size="xs" c="dimmed">{expanded ? "▲" : "▼"}</Text>}
      </Group>
      <Collapse in={expanded}>
        {body && <Text size="xs" c="dimmed" fs="italic" pl={20} pt={2}>{body}</Text>}
      </Collapse>
    </Box>
  );
}

export function EventItem({ event }: { event: Event }) {
  if (event.event === "UserPromptSubmit") return <UserPromptCard event={event} />;
  if (event.event === "Stop") return <AssistantCard event={event} />;
  if (event.event === "Notification") return <NotificationRow event={event} />;
  if (event.event === "SessionStart" || event.event === "SessionEnd") return <SessionEventRow event={event} />;
  return <CompactRow event={event} />;
}
