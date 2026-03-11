import React, { useState } from "react";
import { Box, Badge, Group, Text, Collapse, Avatar } from "@mantine/core";
import type { Event } from "../api";
import { MarkdownView } from "./MarkdownView";
import { TimeAgo } from "./TimeAgo";

export interface UserInfo {
  name: string;
  avatarUrl?: string;
}

function str(v: unknown): string { return typeof v === "string" ? v : ""; }
function data(event: Event): Record<string, unknown> { return (event.data ?? {}) as Record<string, unknown>; }

function BlockedBadge() {
  return <Badge color="red" size="xs" variant="filled" fw={700}>BLOCKED</Badge>;
}

// ── User message ──────────────────────────────────────────────────────────────

function UserPromptCard({ event, user }: { event: Event; user?: UserInfo }) {
  const prompt = str(data(event).prompt);
  const displayName = user?.name ?? "You";
  const initials = displayName.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <Box style={{ display: "flex", justifyContent: "flex-end", alignItems: "flex-start", gap: 10, padding: "12px 20px 4px" }}>
      <Box style={{ maxWidth: "72%", display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
        <Group gap={8} align="center">
          {event.blocked && <BlockedBadge />}
          <TimeAgo iso={event.timestamp} />
          <Text size="xs" fw={600} c="indigo">{displayName}</Text>
        </Group>
        <Box style={{
          backgroundColor: "light-dark(var(--mantine-color-indigo-6), var(--mantine-color-indigo-8))",
          borderRadius: "14px 14px 2px 14px",
          padding: "10px 14px",
        }}>
          <Text size="sm" c="white" style={{ whiteSpace: "pre-wrap", lineHeight: "20px" }}>
            {prompt || "(no prompt)"}
          </Text>
        </Box>
      </Box>
      <Avatar
        src={user?.avatarUrl}
        alt={displayName}
        size={28}
        radius="xl"
        color="indigo"
        style={{ marginTop: 22, flexShrink: 0 }}
      >
        {initials}
      </Avatar>
    </Box>
  );
}

// ── Claude response ───────────────────────────────────────────────────────────

function AssistantCard({ event }: { event: Event }) {
  const d = data(event);
  const msg = str(d.last_assistant_message);
  const reason = str(d.reason);
  return (
    <Box style={{ display: "flex", padding: "12px 20px 4px", gap: 10 }}>
      <Box style={{
        width: 28, height: 28, borderRadius: "50%",
        backgroundColor: "var(--mantine-color-orange-6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        flexShrink: 0, marginTop: 2,
      }}>
        <Text size="xs" c="white" fw={800} style={{ lineHeight: 1 }}>C</Text>
      </Box>
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Group gap={8} mb={6} align="center">
          <Text size="xs" fw={600} c="orange">Claude</Text>
          {reason && <Badge color="orange" size="xs" variant="light">{reason}</Badge>}
          {event.blocked && <BlockedBadge />}
          <TimeAgo iso={event.timestamp} />
        </Group>
        <Box style={{
          backgroundColor: "light-dark(var(--mantine-color-white), var(--mantine-color-dark-6))",
          border: "1px solid light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-4))",
          borderRadius: "2px 14px 14px 14px",
          padding: "12px 16px",
        }}>
          <MarkdownView text={msg || "(no message)"} />
        </Box>
      </Box>
    </Box>
  );
}

// ── Session start / end ───────────────────────────────────────────────────────

function SessionEventRow({ event }: { event: Event }) {
  const d = data(event);
  const isStart = event.event === "SessionStart";
  const extra = isStart ? str(d.source) : str(d.reason);
  const cwd = str(d.cwd);
  const label = isStart ? "Session started" : "Session ended";
  return (
    <Box style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 20px" }}>
      <Box style={{ flex: 1, height: 1, backgroundColor: "light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-4))" }} />
      <Group gap={6} align="center">
        <Text size="xs" c="dimmed" fw={500}>{label}</Text>
        {extra && <Badge variant="light" color="gray" size="xs">{extra}</Badge>}
        {cwd && <Text size="xs" c="dimmed" ff="monospace" style={{ maxWidth: 240, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cwd}</Text>}
        <TimeAgo iso={event.timestamp} />
      </Group>
      <Box style={{ flex: 1, height: 1, backgroundColor: "light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-4))" }} />
    </Box>
  );
}

// ── Notification ──────────────────────────────────────────────────────────────

const NOTIF_META: Record<string, { color: string; label: string }> = {
  permission_prompt: { color: "light-dark(var(--mantine-color-orange-8), var(--mantine-color-orange-4))", label: "Permission request" },
  idle_prompt:       { color: "light-dark(var(--mantine-color-gray-7), var(--mantine-color-gray-4))", label: "Idle" },
};
const NOTIF_DEFAULT_COLOR = "light-dark(var(--mantine-color-gray-7), var(--mantine-color-gray-4))";

function NotificationRow({ event }: { event: Event }) {
  const [expanded, setExpanded] = useState(false);
  const d = data(event);
  const msg = str(d.message);
  const ntype = str(d.notification_type);
  const meta = NOTIF_META[ntype] ?? { color: NOTIF_DEFAULT_COLOR, label: ntype || "Notification" };
  return (
    <Box style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 20px" }}>
      <Box style={{ flex: 1, height: 1, backgroundColor: "light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-4))" }} />
      <Box onClick={msg ? () => setExpanded((v) => !v) : undefined} style={{ cursor: msg ? "pointer" : "default" }}>
        <Group gap={6} align="center">
          <Text size="xs" fw={500} style={{ color: meta.color }}>{meta.label}</Text>
          {msg && <Text size="xs" c="dimmed">{expanded ? "▲" : "▼"}</Text>}
          {event.blocked && <BlockedBadge />}
          <TimeAgo iso={event.timestamp} />
        </Group>
        <Collapse in={expanded}>
          {msg && <Text size="xs" c="dimmed" fs="italic" pt={2} style={{ maxWidth: 400 }}>{msg}</Text>}
        </Collapse>
      </Box>
      <Box style={{ flex: 1, height: 1, backgroundColor: "light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-4))" }} />
    </Box>
  );
}

// ── Other system events ───────────────────────────────────────────────────────

const EVENT_COLOR: Record<string, string> = {
  SubagentStart: "var(--mantine-color-cyan-5)", SubagentStop: "var(--mantine-color-cyan-5)",
  PreCompact: "light-dark(var(--mantine-color-gray-6), var(--mantine-color-gray-4))",
  Setup: "light-dark(var(--mantine-color-gray-6), var(--mantine-color-gray-4))",
  PermissionRequest: "var(--mantine-color-yellow-6)",
};
const EVENT_DEFAULT_COLOR = "light-dark(var(--mantine-color-gray-6), var(--mantine-color-gray-4))";

function CompactRow({ event }: { event: Event }) {
  const [expanded, setExpanded] = useState(false);
  const color = EVENT_COLOR[event.event] ?? EVENT_DEFAULT_COLOR;
  const d = data(event);
  const body = str(d.message) || str(d.reason) || str(d.source);
  return (
    <Box style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 20px" }}>
      <Box style={{ flex: 1, height: 1, backgroundColor: "light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-4))" }} />
      <Box onClick={body ? () => setExpanded((v) => !v) : undefined} style={{ cursor: body ? "pointer" : "default" }}>
        <Group gap={6} align="center">
          <Text size="xs" fw={500} style={{ color }}>{event.event}</Text>
          {body && <Text size="xs" c="dimmed">{expanded ? "▲" : "▼"}</Text>}
          {event.blocked && <BlockedBadge />}
          <TimeAgo iso={event.timestamp} />
        </Group>
        <Collapse in={expanded}>
          {body && <Text size="xs" c="dimmed" fs="italic" pt={2} style={{ maxWidth: 400 }}>{body}</Text>}
        </Collapse>
      </Box>
      <Box style={{ flex: 1, height: 1, backgroundColor: "light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-4))" }} />
    </Box>
  );
}

// ── Export ────────────────────────────────────────────────────────────────────

export function EventItem({ event, user }: { event: Event; user?: UserInfo }) {
  if (event.event === "UserPromptSubmit") return <UserPromptCard event={event} user={user} />;
  if (event.event === "Stop") return <AssistantCard event={event} />;
  if (event.event === "Notification") return <NotificationRow event={event} />;
  if (event.event === "SessionStart" || event.event === "SessionEnd") return <SessionEventRow event={event} />;
  return <CompactRow event={event} />;
}
