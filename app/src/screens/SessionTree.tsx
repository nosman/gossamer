import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  useWindowDimensions,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { useHeaderHeight } from "@react-navigation/elements";
import { fetchSessions, subscribeToUpdates, type Session } from "../api";

// ─── Tree building ────────────────────────────────────────────────────────────

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
    const isLast = i === siblings.length - 1;
    out.push({ session, depth, hasChildren, isLast });
    if (hasChildren && expanded.has(session.sessionId)) {
      flatten(session.sessionId, childMap, depth + 1, expanded, out);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60)  return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function activityColor(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 2 * 60 * 1000)  return "#22c55e";
  if (diff < 15 * 60 * 1000) return "#f59e0b";
  return "#d1d5db";
}

// ─── Node row ─────────────────────────────────────────────────────────────────

const INDENT = 22;

interface NodeProps {
  node: FlatNode;
  isExpanded: boolean;
  onPress: () => void;
  onToggle: () => void;
}

function TreeNode({ node, isExpanded, onPress, onToggle }: NodeProps) {
  const { session, depth, hasChildren } = node;
  const dotColor = activityColor(session.updatedAt);

  return (
    <TouchableOpacity
      style={[s.row, { paddingLeft: 12 + depth * INDENT }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <TouchableOpacity
        onPress={hasChildren ? onToggle : onPress}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        style={s.toggleWrap}
      >
        {hasChildren ? (
          <Text style={s.chevron}>{isExpanded ? "▼" : "▶"}</Text>
        ) : (
          <View style={[s.leaf, { backgroundColor: dotColor }]} />
        )}
      </TouchableOpacity>

      {hasChildren && <View style={[s.dot, { backgroundColor: dotColor }]} />}

      <View style={s.content}>
        <View style={s.titleRow}>
          <Text style={s.sessionId}>{session.sessionId.slice(0, 8)}</Text>
          {session.repoName && (
            <Text style={s.repoChip}>{session.repoName}</Text>
          )}
          <Text style={s.time}>{relativeTime(session.updatedAt)}</Text>
        </View>
        {session.summary && (
          <Text style={s.summary} numberOfLines={2}>{session.summary}</Text>
        )}
        {session.keywords.length > 0 && (
          <View style={s.keywords}>
            {session.keywords.slice(0, 5).map((k) => (
              <Text key={k} style={s.keyword}>{k}</Text>
            ))}
          </View>
        )}
      </View>
    </TouchableOpacity>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export function SessionTree() {
  const router = useRouter();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { height } = useWindowDimensions();
  const headerHeight = useHeaderHeight();
  const contentHeight = height - headerHeight;

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

  if (loading) {
    return (
      <>
        <Stack.Screen options={{ title: "Session Tree" }} />
        <View style={s.centered}>
          <Text style={s.loadingText}>Loading…</Text>
        </View>
      </>
    );
  }

  if (error) {
    return (
      <>
        <Stack.Screen options={{ title: "Session Tree" }} />
        <View style={s.centered}>
          <Text style={s.errorText}>{error}</Text>
        </View>
      </>
    );
  }

  if (nodes.length === 0) {
    return (
      <>
        <Stack.Screen options={{ title: "Session Tree" }} />
        <View style={s.centered}>
          <Text style={s.emptyText}>No sessions yet.</Text>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: "Session Tree" }} />
      <View style={[s.scroll, { height: contentHeight }]}>
        {nodes.map((node) => {
          const isExpanded = expanded.has(node.session.sessionId);
          return (
            <View key={node.session.sessionId}>
              {node.depth > 0 && (
                <View
                  style={[
                    s.connector,
                    { left: 12 + (node.depth - 1) * INDENT + 9 },
                  ]}
                />
              )}
              <TreeNode
                node={node}
                isExpanded={isExpanded}
                onPress={() =>
                  router.push({
                    pathname: "/sessions/[sessionId]",
                    params: {
                      sessionId: node.session.sessionId,
                      title: node.session.summary ?? node.session.sessionId.slice(0, 8) + "…",
                    },
                  })
                }
                onToggle={() => toggle(node.session.sessionId)}
              />
            </View>
          );
        })}
      </View>
    </>
  );
}

const s = StyleSheet.create({
  scroll: {
    overflow: "scroll",
    backgroundColor: "#fff",
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  loadingText: { fontSize: 14, color: "#9ca3af" },
  errorText:   { fontSize: 14, color: "#ef4444", textAlign: "center" },
  emptyText:   { fontSize: 14, color: "#9ca3af" },

  row: {
    flexDirection: "row",
    alignItems: "flex-start",
    paddingVertical: 10,
    paddingRight: 16,
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
    gap: 8,
  },

  toggleWrap: {
    width: 18,
    alignItems: "center",
    paddingTop: 2,
    flexShrink: 0,
  },
  chevron: {
    fontSize: 10,
    color: "#9ca3af",
  },
  leaf: {
    width: 7,
    height: 7,
    borderRadius: 4,
    marginTop: 4,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    marginTop: 3,
    flexShrink: 0,
  },

  content: {
    flex: 1,
    gap: 3,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexWrap: "wrap",
  },
  sessionId: {
    fontFamily: "monospace",
    fontSize: 12,
    fontWeight: "600",
    color: "#374151",
  },
  repoChip: {
    fontSize: 11,
    color: "#6d28d9",
    backgroundColor: "#ede9fe",
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
  },
  time: {
    fontSize: 11,
    color: "#9ca3af",
    marginLeft: "auto",
  },
  summary: {
    fontSize: 12,
    color: "#6b7280",
    lineHeight: 17,
  },
  keywords: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 4,
    marginTop: 2,
  },
  keyword: {
    fontSize: 10,
    color: "#7c3aed",
    backgroundColor: "#f5f3ff",
    paddingHorizontal: 4,
    paddingVertical: 1,
    borderRadius: 3,
  },
  connector: {
    position: "absolute",
    top: 0,
    width: 1,
    height: "100%",
    backgroundColor: "#e5e7eb",
  },
});
