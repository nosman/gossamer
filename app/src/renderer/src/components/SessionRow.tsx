import React, { useState } from "react";
import { Table, Text, Anchor, ActionIcon, Tooltip, Badge } from "@mantine/core";
import type { Session } from "../api";
import { relativeTime, absoluteTime } from "./TimeAgo";

interface Props {
  session: Session;
  onPress: () => void;
  onArchive?: (sessionId: string) => void;
  isArchived?: boolean;
  onParentPress?: (sessionId: string) => void;
}

export const COL_WIDTHS = {
  sessionId:       180,
  user:            160,
  repo:            130,
  branch:          120,
  intent:          340,
  parentSessionId: 120,
  started:         110,
  updated:         110,
  actions:          56,
} as const;



function activityDot(updatedAt: string): { color: string; label: string } {
  const diff = Date.now() - new Date(updatedAt).getTime();
  if (diff < 2 * 60 * 1000)  return { color: "var(--mantine-color-green-6)", label: "Active" };
  if (diff < 15 * 60 * 1000) return { color: "var(--mantine-color-yellow-6)", label: "Idle" };
  return { color: "light-dark(var(--mantine-color-gray-4), var(--mantine-color-dark-3))", label: "Inactive" };
}

interface CopyCellProps {
  copyValue: string;
  width: number;
  children: React.ReactNode;
  prefix?: React.ReactNode;
}

function CopyCell({ copyValue, width, children, prefix }: CopyCellProps) {
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);

  function copy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(copyValue).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <Table.Td
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setCopied(false); }}
      style={{ width, maxWidth: width, overflow: "hidden", position: "relative", paddingRight: hovered ? 28 : undefined }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}>
        {prefix}
        <div style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
          {children}
        </div>
      </div>
      {hovered && copyValue && (
        <Tooltip label={copied ? "Copied!" : "Copy"} withArrow position="top" openDelay={0}>
          <ActionIcon
            size="xs"
            variant="subtle"
            color={copied ? "green" : "gray"}
            onClick={copy}
            style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)" }}
          >
            {copied ? "✓" : "⧉"}
          </ActionIcon>
        </Tooltip>
      )}
    </Table.Td>
  );
}

export function SessionRow({ session, onPress, onArchive, isArchived, onParentPress }: Props) {
  const dot = activityDot(session.updatedAt);
  const intent = session.intent ?? session.summary ?? session.prompt?.slice(0, 160) ?? "—";
  const shortId = session.sessionId.slice(0, 8) + "…";
  const shortParent = session.parentSessionId ? session.parentSessionId.slice(0, 8) + "…" : null;
  const [archiving, setArchiving] = useState(false);

  return (
    <Table.Tr onClick={onPress} style={{ cursor: "pointer" }}>
        <CopyCell copyValue={intent} width={COL_WIDTHS.intent}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, overflow: "hidden" }}>
            <Tooltip label={dot.label} withArrow position="left" openDelay={300}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: dot.color, flexShrink: 0 }} />
            </Tooltip>
            <Text size="sm" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{intent}</Text>
            {session.isLive && (
              <Badge size="xs" color="orange" variant="light" style={{ flexShrink: 0 }}>
                live
              </Badge>
            )}
          </div>
        </CopyCell>

        <CopyCell copyValue={session.sessionId} width={COL_WIDTHS.sessionId}>
          <Text ff="monospace" size="sm" c="indigo">{shortId}</Text>
        </CopyCell>

        <CopyCell copyValue={absoluteTime(session.updatedAt)} width={COL_WIDTHS.updated}>
          <Text size="sm" c="dimmed">{relativeTime(session.updatedAt)}</Text>
        </CopyCell>

        <CopyCell copyValue={session.branch ?? ""} width={COL_WIDTHS.branch}>
          <Text size="sm" ff="monospace" c={session.branch ? "teal" : "dimmed"}>
            {session.branch ?? "—"}
          </Text>
        </CopyCell>

        <CopyCell copyValue={session.repoName ?? ""} width={COL_WIDTHS.repo}>
          <Text size="sm" c={session.repoName ? undefined : "dimmed"}>
            {session.repoName ?? "—"}
          </Text>
        </CopyCell>

        <CopyCell copyValue={session.parentSessionId ?? ""} width={COL_WIDTHS.parentSessionId}>
          {session.parentSessionId && onParentPress ? (
            <Anchor
              ff="monospace"
              size="sm"
              onClick={(e) => { e.stopPropagation(); onParentPress(session.parentSessionId as string); }}
              underline="never"
              style={{ cursor: "pointer" }}
            >
              {shortParent}
            </Anchor>
          ) : shortParent ? (
            <Text ff="monospace" size="sm" c="blue">{shortParent}</Text>
          ) : (
            <Text size="sm" c="dimmed">—</Text>
          )}
        </CopyCell>

        <CopyCell copyValue={session.gitUserEmail ?? session.gitUserName ?? ""} width={COL_WIDTHS.user}>
          {session.gitUserEmail ? (
            <Anchor
              size="sm"
              href={`mailto:${session.gitUserEmail}`}
              onClick={(e) => e.stopPropagation()}
            >
              {session.gitUserName ?? session.gitUserEmail}
            </Anchor>
          ) : (
            <Text size="sm" c={session.gitUserName ? undefined : "dimmed"}>
              {session.gitUserName ?? "—"}
            </Text>
          )}
        </CopyCell>

        <CopyCell copyValue={absoluteTime(session.startedAt)} width={COL_WIDTHS.started}>
          <Text size="sm" c="dimmed">{relativeTime(session.startedAt)}</Text>
        </CopyCell>

        <Table.Td style={{ width: COL_WIDTHS.actions }} onClick={(e) => e.stopPropagation()}>
          {onArchive && (
            <Tooltip label={isArchived ? "Unarchive" : "Archive"} withArrow position="left" openDelay={300}>
              <ActionIcon
                size="sm"
                variant="subtle"
                color={isArchived ? "blue" : "gray"}
                loading={archiving}
                onClick={async (e) => {
                  e.stopPropagation();
                  setArchiving(true);
                  try { await onArchive(session.sessionId); }
                  finally { setArchiving(false); }
                }}
              >
                {isArchived ? "↩" : "⊗"}
              </ActionIcon>
            </Tooltip>
          )}
        </Table.Td>
    </Table.Tr>
  );
}
