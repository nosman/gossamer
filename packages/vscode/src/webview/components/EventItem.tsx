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

function applyHighlight(text: string, terms: string[] | undefined): React.ReactNode {
  if (!terms?.length) return text;
  const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const parts = text.split(new RegExp(`(${pattern})`, "gi"));
  return parts.map((p, i) =>
    i % 2 === 1
      ? <mark key={i} style={{ background: "rgba(255,200,0,0.45)", borderRadius: 2, padding: "0 1px" }}>{p}</mark>
      : p
  );
}

function BlockedBadge() {
  return <Badge color="red" size="xs" variant="filled" fw={700}>BLOCKED</Badge>;
}

// ── Shared row wrapper ─────────────────────────────────────────────────────────

function MessageRow({ accentColor, label, labelColor, timestamp, blocked, children }: {
  accentColor: string;
  label: string;
  labelColor: string;
  timestamp: string | null;
  blocked?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Box style={{
      display: "flex",
      gap: 10,
      padding: "5px 12px",
      paddingLeft: 10,
      borderLeft: `2px solid ${accentColor}`,
      borderBottom: "1px solid var(--vscode-panel-border)",
      alignItems: "flex-start",
    }}>
      <Text
        size="xs"
        fw={600}
        style={{ width: 80, flexShrink: 0, paddingTop: 2, color: labelColor, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
      >
        {label}
      </Text>
      <Box style={{ flex: 1, minWidth: 0 }}>
        {children}
      </Box>
      <Box style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 6, paddingTop: 2 }}>
        {blocked && <BlockedBadge />}
        {timestamp && <TimeAgo iso={timestamp} />}
      </Box>
    </Box>
  );
}

// ── User message ──────────────────────────────────────────────────────────────

function UserPromptCard({ event, user, matchTerms }: { event: Event; user?: UserInfo; matchTerms?: string[] }) {
  const d = data(event);
  const prompt = str(d.prompt);
  const images = Array.isArray(d.images) ? (d.images as { data: string; mediaType: string }[]) : [];
  const displayName = user?.name ?? "You";
  return (
    <MessageRow
      accentColor="var(--vscode-button-background)"
      label={displayName}
      labelColor="var(--vscode-textLink-foreground)"
      timestamp={event.timestamp}
      blocked={event.blocked}
    >
      {prompt ? (
        matchTerms?.length
          ? <Text size="sm" style={{ whiteSpace: "pre-wrap", lineHeight: "18px" }}>{applyHighlight(prompt, matchTerms)}</Text>
          : <MarkdownView text={prompt} />
      ) : !images.length ? <Text size="sm" c="dimmed">(no prompt)</Text> : null}
      {images.map((img, i) => (
        <img key={i} src={`data:${img.mediaType};base64,${img.data}`} style={{ maxWidth: "100%", borderRadius: 4, marginTop: 4, display: "block" }} />
      ))}
    </MessageRow>
  );
}

// ── Claude response ───────────────────────────────────────────────────────────

function AssistantCard({ event, matchTerms, agentLabel }: { event: Event; matchTerms?: string[]; agentLabel?: string }) {
  const d = data(event);
  const msg = str(d.last_assistant_message);
  const reason = str(d.reason);
  return (
    <MessageRow
      accentColor="var(--mantine-color-orange-5)"
      label={agentLabel ?? "Claude"}
      labelColor="var(--mantine-color-orange-5)"
      timestamp={event.timestamp}
      blocked={event.blocked}
    >
      <Box>
        {reason && <Badge color="orange" size="xs" variant="light" mb={4}>{reason}</Badge>}
        {msg && (matchTerms?.length ? (
          <Text size="sm" style={{ whiteSpace: "pre-wrap", lineHeight: "18px" }}>
            {applyHighlight(msg, matchTerms)}
          </Text>
        ) : <MarkdownView text={msg} />)}
      </Box>
    </MessageRow>
  );
}

// ── Session start / end ───────────────────────────────────────────────────────

function SessionEventRow({ event }: { event: Event }) {
  const d = data(event);
  const isStart = event.event === "SessionStart";
  const extra = isStart ? str(d.source) : str(d.reason);
  const cwd = str(d.cwd);
  const label = isStart ? "session started" : "session ended";
  return (
    <Box style={{ padding: "3px 12px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid var(--vscode-panel-border)" }}>
      <Text size="xs" c="dimmed" fw={500}>{label}</Text>
      {extra && <Badge variant="light" color="gray" size="xs">{extra}</Badge>}
      {cwd && <Text size="xs" c="dimmed" ff="monospace" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{cwd}</Text>}
      <Box style={{ flex: 1 }} />
      <TimeAgo iso={event.timestamp} />
    </Box>
  );
}

// ── Notification ──────────────────────────────────────────────────────────────

const NOTIF_META: Record<string, { color: string; label: string }> = {
  permission_prompt: { color: "var(--vscode-notificationsWarningIcon-foreground, var(--mantine-color-orange-4))", label: "permission request" },
  idle_prompt:       { color: "var(--vscode-descriptionForeground)", label: "idle" },
};

function NotificationRow({ event }: { event: Event }) {
  const [expanded, setExpanded] = useState(false);
  const d = data(event);
  const msg = str(d.message);
  const ntype = str(d.notification_type);
  const meta = NOTIF_META[ntype] ?? { color: "var(--vscode-descriptionForeground)", label: ntype || "notification" };
  return (
    <Box style={{ padding: "3px 12px", borderBottom: "1px solid var(--vscode-panel-border)" }}>
      <Box
        onClick={msg ? () => setExpanded((v) => !v) : undefined}
        style={{ display: "flex", alignItems: "center", gap: 8, cursor: msg ? "pointer" : "default" }}
      >
        <Text size="xs" fw={500} style={{ color: meta.color }}>{meta.label}</Text>
        {msg && <Text size="xs" c="dimmed">{expanded ? "▲" : "▼"}</Text>}
        {event.blocked && <BlockedBadge />}
        <Box style={{ flex: 1 }} />
        <TimeAgo iso={event.timestamp} />
      </Box>
      <Collapse in={expanded}>
        {msg && <Text size="xs" c="dimmed" fs="italic" pt={2} style={{ maxWidth: 480 }}>{msg}</Text>}
      </Collapse>
    </Box>
  );
}

// ── Other system events ───────────────────────────────────────────────────────

const EVENT_COLOR: Record<string, string> = {
  SubagentStart: "var(--mantine-color-cyan-5)",
  SubagentStop:  "var(--mantine-color-cyan-5)",
  PermissionRequest: "var(--vscode-notificationsWarningIcon-foreground, var(--mantine-color-yellow-6))",
};

function CompactRow({ event }: { event: Event }) {
  const [expanded, setExpanded] = useState(false);
  const color = EVENT_COLOR[event.event] ?? "var(--vscode-descriptionForeground)";
  const d = data(event);
  const body = str(d.message) || str(d.reason) || str(d.source);
  return (
    <Box style={{ padding: "3px 12px", borderBottom: "1px solid var(--vscode-panel-border)" }}>
      <Box
        onClick={body ? () => setExpanded((v) => !v) : undefined}
        style={{ display: "flex", alignItems: "center", gap: 8, cursor: body ? "pointer" : "default" }}
      >
        <Text size="xs" fw={500} style={{ color }}>{event.event}</Text>
        {body && <Text size="xs" c="dimmed">{expanded ? "▲" : "▼"}</Text>}
        {event.blocked && <BlockedBadge />}
        <Box style={{ flex: 1 }} />
        <TimeAgo iso={event.timestamp} />
      </Box>
      <Collapse in={expanded}>
        {body && <Text size="xs" c="dimmed" fs="italic" pt={2} style={{ maxWidth: 480 }}>{body}</Text>}
      </Collapse>
    </Box>
  );
}

// ── Export ────────────────────────────────────────────────────────────────────

export function EventItem({ event, user, matchTerms, agentLabel }: { event: Event; user?: UserInfo; matchTerms?: string[]; agentLabel?: string }) {
  if (event.event === "UserPromptSubmit") return <UserPromptCard event={event} user={user} matchTerms={matchTerms} />;
  if (event.event === "Stop") return <AssistantCard event={event} matchTerms={matchTerms} agentLabel={agentLabel} />;
  if (event.event === "Notification") return <NotificationRow event={event} />;
  if (event.event === "SessionStart" || event.event === "SessionEnd") return <SessionEventRow event={event} />;
  return <CompactRow event={event} />;
}
