import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { View, Text, TouchableOpacity, StyleSheet } from "../primitives";
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
    <TouchableOpacity
      style={{ ...s.row, paddingLeft: 12 + depth * INDENT } as React.CSSProperties}
      onPress={onPress}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={(e) => { e.stopPropagation(); hasChildren ? onToggle() : onPress(); }}
        onKeyDown={(e) => e.key === "Enter" && (hasChildren ? onToggle() : onPress())}
        style={s.toggleWrap}
      >
        {hasChildren ? (
          <span style={s.chevron}>{isExpanded ? "▼" : "▶"}</span>
        ) : (
          <div style={{ ...s.leaf, backgroundColor: dotColor } as React.CSSProperties} />
        )}
      </div>

      {hasChildren && <div style={{ ...s.dot, backgroundColor: dotColor } as React.CSSProperties} />}

      <View style={s.content}>
        <View style={s.titleRow}>
          <span style={s.sessionId}>{session.sessionId.slice(0, 8)}</span>
          {session.repoName && <span style={s.repoChip}>{session.repoName}</span>}
          <span style={s.time}>{relativeTime(session.updatedAt)}</span>
        </View>
        {session.summary && (
          <div style={s.summary}>{session.summary}</div>
        )}
        {session.keywords.length > 0 && (
          <View style={s.keywords}>
            {session.keywords.slice(0, 5).map((k) => (
              <span key={k} style={s.keyword}>{k}</span>
            ))}
          </View>
        )}
      </View>
    </TouchableOpacity>
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

  if (loading) return <View style={s.centered}><div style={{ color: "#9ca3af" }}>Loading…</div></View>;
  if (error) return <View style={s.centered}><div style={{ color: "#ef4444" }}>{error}</div></View>;
  if (nodes.length === 0) return <View style={s.centered}><div style={{ color: "#9ca3af" }}>No sessions yet.</div></View>;

  return (
    <div style={{ flex: 1, overflow: "auto", backgroundColor: "#fff" }}>
      {nodes.map((node) => (
        <div key={node.session.sessionId} style={{ position: "relative" }}>
          {node.depth > 0 && (
            <div style={{
              position: "absolute",
              top: 0,
              left: 12 + (node.depth - 1) * INDENT + 9,
              width: 1,
              height: "100%",
              backgroundColor: "#e5e7eb",
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
    </div>
  );
}

const s = StyleSheet.create({
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 } as React.CSSProperties,
  row: {
    display: "flex",
    flexDirection: "row",
    alignItems: "flex-start",
    paddingTop: 10,
    paddingBottom: 10,
    paddingRight: 16,
    borderBottom: "1px solid #f1f5f9",
    gap: 8,
    cursor: "pointer",
  } as React.CSSProperties,
  toggleWrap: { width: 18, display: "flex", alignItems: "center", paddingTop: 2, flexShrink: 0, cursor: "pointer" } as React.CSSProperties,
  chevron: { fontSize: 10, color: "#9ca3af" } as React.CSSProperties,
  leaf: { width: 7, height: 7, borderRadius: "50%", marginTop: 4 } as React.CSSProperties,
  dot: { width: 8, height: 8, borderRadius: "50%", marginTop: 3, flexShrink: 0 } as React.CSSProperties,
  content: { flex: 1, gap: 3 } as React.CSSProperties,
  titleRow: { flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" } as React.CSSProperties,
  sessionId: { fontFamily: "monospace", fontSize: 12, fontWeight: 600, color: "#374151" } as React.CSSProperties,
  repoChip: { fontSize: 11, color: "#6d28d9", backgroundColor: "#ede9fe", padding: "1px 5px", borderRadius: 4 } as React.CSSProperties,
  time: { fontSize: 11, color: "#9ca3af", marginLeft: "auto" } as React.CSSProperties,
  summary: { fontSize: 12, color: "#6b7280", lineHeight: "17px", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" } as React.CSSProperties,
  keywords: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 2 } as React.CSSProperties,
  keyword: { fontSize: 10, color: "#7c3aed", backgroundColor: "#f5f3ff", padding: "1px 4px", borderRadius: 3 } as React.CSSProperties,
});
