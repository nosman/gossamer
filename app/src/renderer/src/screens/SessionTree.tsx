import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Center, Loader, Text, ScrollArea, Box, Badge, Group, UnstyledButton } from "@mantine/core";
import { fetchSessions, subscribeToUpdates, type Session } from "../api";

interface FlatNode {
  session: Session;
  depth: number;
  hasChildren: boolean;
  isLast: boolean;
}

function buildChildMap(sessions: Session[]): Map<string | null, Session[]> {
  const map = new Map<string | null, Session[]>();
  for (const s of sessions) {
    const key = s.parentSessionId;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }
  return map;
}

function flatten(
  parentId: string | null,
  childMap: Map<string | null, Session[]>,
  depth: number,
  expanded: Set<string>,
  out: FlatNode[],
) {
  const siblings = childMap.get(parentId) ?? [];
  for (let i = 0; i < siblings.length; i++) {
    const session = siblings[i];
    const hasChildren = (childMap.get(session.sessionId) ?? []).length > 0;
    out.push({ session, depth, hasChildren, isLast: i === siblings.length - 1 });
    if (hasChildren && expanded.has(session.sessionId)) {
      flatten(session.sessionId, childMap, depth + 1, expanded, out);
    }
  }
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function activityColor(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 2 * 60 * 1000) return "#22c55e";
  if (diff < 15 * 60 * 1000) return "#f59e0b";
  return "#d1d5db";
}

const INDENT = 22;

function TreeNode({
  node,
  isExpanded,
  onPress,
  onToggle,
}: {
  node: FlatNode;
  isExpanded: boolean;
  onPress: () => void;
  onToggle: () => void;
}) {
  const { session, depth, hasChildren } = node;
  const dotColor = activityColor(session.updatedAt);

  return (
    <UnstyledButton
      onClick={onPress}
      style={{ width: "100%", display: "flex", flexDirection: "row", alignItems: "flex-start", paddingTop: 10, paddingBottom: 10, paddingRight: 16, paddingLeft: 12 + depth * INDENT, borderBottom: "1px solid var(--mantine-color-gray-1)", gap: 8 }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => { e.stopPropagation(); hasChildren ? onToggle() : onPress(); }}
        onKeyDown={(e) => e.key === "Enter" && (hasChildren ? onToggle() : onPress())}
        style={{ width: 18, display: "flex", alignItems: "center", paddingTop: 2, flexShrink: 0, cursor: "pointer" }}
      >
        {hasChildren ? (
          <Text size="xs" c="dimmed">{isExpanded ? "▼" : "▶"}</Text>
        ) : (
          <div style={{ width: 7, height: 7, borderRadius: "50%", backgroundColor: dotColor, marginTop: 4 }} />
        )}
      </div>

      {hasChildren && <div style={{ width: 8, height: 8, borderRadius: "50%", backgroundColor: dotColor, marginTop: 3, flexShrink: 0 }} />}

      <Box style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
        <Group gap={6} wrap="wrap">
          <Text ff="monospace" size="xs" fw={600}>{session.sessionId.slice(0, 8)}</Text>
          {session.repoName && <Badge variant="light" color="violet" size="xs">{session.repoName}</Badge>}
          <Text size="xs" c="dimmed" style={{ marginLeft: "auto" }}>{relativeTime(session.updatedAt)}</Text>
        </Group>
        {session.summary && (
          <Text size="xs" c="dimmed" lineClamp={2} style={{ lineHeight: "17px" }}>{session.summary}</Text>
        )}
        {session.keywords.length > 0 && (
          <Group gap={4} mt={2}>
            {session.keywords.slice(0, 5).map((k) => (
              <Badge key={k} variant="light" color="violet" size="xs" radius="sm">{k}</Badge>
            ))}
          </Group>
        )}
      </Box>
    </UnstyledButton>
  );
}

export function SessionTree() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const data = await fetchSessions();
      setSessions(data);
      setError(null);
      setExpanded((prev) => {
        const next = new Set(prev);
        const parentIds = new Set(data.map((sess) => sess.parentSessionId).filter(Boolean));
        for (const id of parentIds) if (id) next.add(id);
        return next;
      });
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    load().finally(() => setLoading(false));
    return subscribeToUpdates(() => { load().catch(() => undefined); });
  }, [load]);

  const childMap = useMemo(() => buildChildMap(sessions), [sessions]);
  const nodes = useMemo(() => {
    const out: FlatNode[] = [];
    flatten(null, childMap, 0, expanded, out);
    return out;
  }, [childMap, expanded]);

  function toggle(sessionId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }

  if (loading) return <Center style={{ flex: 1 }}><Loader size="md" color="indigo" /></Center>;
  if (error) return <Center style={{ flex: 1 }}><Text c="red">{error}</Text></Center>;
  if (nodes.length === 0) return <Center style={{ flex: 1 }}><Text c="dimmed" size="sm">No sessions yet.</Text></Center>;

  return (
    <ScrollArea style={{ flex: 1 }}>
      {nodes.map((node) => (
        <div key={node.session.sessionId} style={{ position: "relative" }}>
          {node.depth > 0 && (
            <div style={{
              position: "absolute",
              top: 0,
              left: 12 + (node.depth - 1) * INDENT + 9,
              width: 1,
              height: "100%",
              backgroundColor: "var(--mantine-color-gray-3)",
            }} />
          )}
          <TreeNode
            node={node}
            isExpanded={expanded.has(node.session.sessionId)}
            onPress={() =>
              navigate(`/sessions/${node.session.sessionId}`, {
                state: { title: node.session.summary ?? node.session.sessionId.slice(0, 8) + "…" },
              })
            }
            onToggle={() => toggle(node.session.sessionId)}
          />
        </div>
      ))}
    </ScrollArea>
  );
}
