import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Table, Text, Anchor, ActionIcon, Tooltip, Box, Group, Loader, UnstyledButton, Badge } from "@mantine/core";
import { fetchSessionCheckpoints, type Session, type SessionCheckpoint } from "../api";

interface Props {
  session: Session;
  onPress: () => void;
}

export const COL_WIDTHS = {
  sessionId:       140,
  user:            160,
  branch:          120,
  intent:          340,
  parentSessionId: 120,
  started:         110,
  updated:         110,
} as const;

const NCOLS = Object.keys(COL_WIDTHS).length;

function fmt(iso: string): string {
  const d = new Date(iso);
  return (
    String(d.getDate()).padStart(2, "0") + "/" +
    String(d.getMonth() + 1).padStart(2, "0") + "/" +
    String(d.getFullYear()).slice(2) + " " +
    String(d.getHours()).padStart(2, "0") + ":" +
    String(d.getMinutes()).padStart(2, "0")
  );
}

function activityDot(updatedAt: string): { color: string; label: string } {
  const diff = Date.now() - new Date(updatedAt).getTime();
  if (diff < 2 * 60 * 1000)  return { color: "#22c55e", label: "Active" };
  if (diff < 15 * 60 * 1000) return { color: "#f59e0b", label: "Idle" };
  return { color: "#d1d5db", label: "Inactive" };
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

export function SessionRow({ session, onPress }: Props) {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [checkpoints, setCheckpoints] = useState<SessionCheckpoint[] | null>(null);
  const [loadingCp, setLoadingCp] = useState(false);

  const dot = activityDot(session.updatedAt);
  const intent = session.intent ?? session.summary ?? session.prompt?.slice(0, 160) ?? "—";
  const shortId = session.sessionId.slice(0, 8) + "…";
  const shortParent = session.parentSessionId ? session.parentSessionId.slice(0, 8) + "…" : null;

  function handleRowClick() {
    if (!expanded && checkpoints === null && !loadingCp) {
      setLoadingCp(true);
      fetchSessionCheckpoints(session.sessionId)
        .then((cps) => setCheckpoints([...cps].reverse().slice(0, 5)))
        .catch(() => setCheckpoints([]))
        .finally(() => setLoadingCp(false));
    }
    setExpanded((v) => !v);
  }

  return (
    <>
      <Table.Tr onClick={handleRowClick} style={{ cursor: "pointer" }}>
        <CopyCell
          copyValue={session.sessionId}
          width={COL_WIDTHS.sessionId}
          prefix={
            <Tooltip label={dot.label} withArrow position="left" openDelay={300}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: dot.color, flexShrink: 0 }} />
            </Tooltip>
          }
        >
          <Text ff="monospace" size="sm" c="indigo">
            {shortId} <Text component="span" size="xs" c="dimmed">{expanded ? "▲" : "▼"}</Text>
          </Text>
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

        <CopyCell copyValue={session.branch ?? ""} width={COL_WIDTHS.branch}>
          <Text size="sm" ff="monospace" c={session.branch ? "teal" : "dimmed"}>
            {session.branch ?? "—"}
          </Text>
        </CopyCell>

        <CopyCell copyValue={intent} width={COL_WIDTHS.intent}>
          <Text size="sm">{intent}</Text>
        </CopyCell>

        <CopyCell copyValue={session.parentSessionId ?? ""} width={COL_WIDTHS.parentSessionId}>
          {shortParent ? (
            <Text ff="monospace" size="sm" c="blue">{shortParent}</Text>
          ) : (
            <Text size="sm" c="dimmed">—</Text>
          )}
        </CopyCell>

        <CopyCell copyValue={fmt(session.startedAt)} width={COL_WIDTHS.started}>
          <Text size="sm">{fmt(session.startedAt)}</Text>
        </CopyCell>

        <CopyCell copyValue={fmt(session.updatedAt)} width={COL_WIDTHS.updated}>
          <Text size="sm">{fmt(session.updatedAt)}</Text>
        </CopyCell>
      </Table.Tr>

      {expanded && (
        <Table.Tr>
          <Table.Td
            colSpan={NCOLS}
            style={{ padding: 0, backgroundColor: "var(--mantine-color-gray-0)", borderBottom: "2px solid var(--mantine-color-gray-3)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <Group gap={0} align="flex-start" wrap="nowrap" px={16} py={10}>
              {/* Checkpoints */}
              <Box style={{ flex: 1 }}>
                {loadingCp ? (
                  <Loader size="xs" color="teal" />
                ) : checkpoints?.length === 0 ? (
                  <Text size="xs" c="dimmed">No checkpoints for this session.</Text>
                ) : (
                  <Group gap={6} wrap="wrap">
                    <Text size="xs" c="dimmed" fw={600} tt="uppercase" style={{ letterSpacing: 0.4, alignSelf: "center" }}>
                      Recent checkpoints
                    </Text>
                    {checkpoints?.map((cp) => (
                      <UnstyledButton
                        key={cp.checkpointId}
                        onClick={() =>
                          navigate(`/checkpoints/${cp.checkpointId}`, {
                            state: { title: cp.branch ? `${cp.branch} · ${cp.checkpointId}` : cp.checkpointId },
                          })
                        }
                      >
                        <Badge
                          variant="outline"
                          color="teal"
                          size="sm"
                          ff="monospace"
                          style={{ cursor: "pointer" }}
                          title={cp.checkpointId}
                        >
                          {cp.checkpointId.slice(0, 10)}…
                          {cp.branch && <Text component="span" size="xs" c="dimmed"> · {cp.branch}</Text>}
                        </Badge>
                      </UnstyledButton>
                    ))}
                  </Group>
                )}
              </Box>

              {/* View session link */}
              <UnstyledButton
                onClick={onPress}
                style={{ flexShrink: 0, alignSelf: "center", padding: "4px 10px", borderRadius: 4, border: "1px solid var(--mantine-color-indigo-3)" }}
              >
                <Text size="xs" c="indigo" ff="monospace">View session →</Text>
              </UnstyledButton>
            </Group>
          </Table.Td>
        </Table.Tr>
      )}
    </>
  );
}
