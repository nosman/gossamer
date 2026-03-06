import React, { useEffect, useState } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from "../primitives";
import {
  fetchSession,
  fetchSessionEvents,
  fetchSessionOverview,
  fetchSessionCheckpoints,
  type Session,
  type Event,
  type InteractionOverview,
  type SessionCheckpoint,
} from "../api";
import { EventItem } from "../components/EventItem";
import { ToolGroupItem, type ToolUseData } from "../components/ToolGroupItem";

type DisplayItem =
  | { kind: "event"; event: Event }
  | { kind: "toolGroup"; tools: ToolUseData[] }
  | { kind: "checkpoint"; checkpoint: SessionCheckpoint };

function groupEvents(events: Event[]): DisplayItem[] {
  const postMap = new Map<string, Event>();
  for (const event of events) {
    if (event.event === "PostToolUse" || event.event === "PostToolUseFailure") {
      const d = event.data as Record<string, unknown>;
      const id = typeof d.tool_use_id === "string" ? d.tool_use_id : null;
      if (id) postMap.set(id, event);
    }
  }

  type RawItem =
    | { kind: "event"; event: Event }
    | { kind: "toolUse"; pre: Event; post?: Event; failed: boolean };

  const raw: RawItem[] = [];
  const consumed = new Set<number>();

  for (const event of events) {
    if ((event.event === "PostToolUse" || event.event === "PostToolUseFailure") && consumed.has(event.id)) continue;
    if (event.event === "PreToolUse") {
      const d = event.data as Record<string, unknown>;
      const toolUseId = typeof d.tool_use_id === "string" ? d.tool_use_id : null;
      const post = toolUseId ? postMap.get(toolUseId) : undefined;
      if (post) consumed.add(post.id);
      raw.push({ kind: "toolUse", pre: event, post, failed: post?.event === "PostToolUseFailure" });
      continue;
    }
    raw.push({ kind: "event", event });
  }

  const isGroupable = (item: RawItem) =>
    item.kind === "toolUse" || (item.kind === "event" && item.event.event === "Notification");

  const result: DisplayItem[] = [];
  let i = 0;
  while (i < raw.length) {
    if (isGroupable(raw[i])) {
      const group: ToolUseData[] = [];
      while (i < raw.length && isGroupable(raw[i])) {
        const item = raw[i];
        if (item.kind === "toolUse") group.push({ pre: item.pre, post: item.post, failed: item.failed });
        i++;
      }
      if (group.length > 0) result.push({ kind: "toolGroup", tools: group });
    } else {
      result.push({ kind: "event", event: (raw[i] as { kind: "event"; event: Event }).event });
      i++;
    }
  }
  return result;
}

function CheckpointRow({ checkpoint, onPress }: { checkpoint: SessionCheckpoint; onPress: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const outTokens = checkpoint.tokenUsage?.outputTokens ?? 0;
  const fileCount = checkpoint.filesTouched.length;
  const sum = checkpoint.summary;

  return (
    <div style={{ borderLeft: "4px solid #059669" }}>
      <TouchableOpacity onPress={() => setExpanded((v) => !v)} style={styles.cpRow}>
        <View style={styles.cpBody}>
          <View style={styles.cpTop}>
            <span style={styles.cpLabel}>Checkpoint</span>
            <span style={styles.cpId}>{checkpoint.checkpointId}</span>
            {checkpoint.branch && <span style={styles.cpBranch}>{checkpoint.branch}</span>}
          </View>
          {sum?.intent && (
            <div style={{ ...styles.cpIntent, WebkitLineClamp: expanded ? undefined : 1, display: expanded ? "block" : "-webkit-box", WebkitBoxOrient: "vertical", overflow: "hidden" } as React.CSSProperties}>
              {sum.intent}
            </div>
          )}
        </View>
        <View style={styles.cpMeta}>
          {fileCount > 0 && <span style={styles.cpMetaText}>{fileCount} file{fileCount !== 1 ? "s" : ""}</span>}
          {outTokens > 0 && <span style={styles.cpMetaText}>{outTokens.toLocaleString()} tok</span>}
        </View>
      </TouchableOpacity>

      {expanded && (
        <View style={styles.cpDropdown}>
          {sum?.outcome && <View style={styles.cpSection}><span style={styles.cpSectionLabel}>✓ Outcome</span><span style={styles.cpSectionText}>{sum.outcome}</span></View>}
          {sum?.repoLearnings?.length ? <View style={styles.cpSection}><span style={styles.cpSectionLabel}>◎ Repo learnings</span>{sum.repoLearnings.map((it, i) => <span key={i} style={styles.cpBullet}>· {it}</span>)}</View> : null}
          {sum?.codeLearnings?.length ? <View style={styles.cpSection}><span style={styles.cpSectionLabel}>{"</>"} Code learnings</span>{sum.codeLearnings.map((it, i) => <View key={i} style={styles.cpCodeLearning}><span style={styles.cpCodePath}>{it.path}</span><span style={styles.cpBullet}>{it.finding}</span></View>)}</View> : null}
          {sum?.workflowLearnings?.length ? <View style={styles.cpSection}><span style={styles.cpSectionLabel}>↺ Workflow learnings</span>{sum.workflowLearnings.map((it, i) => <span key={i} style={styles.cpBullet}>· {it}</span>)}</View> : null}
          {sum?.friction?.length ? <View style={styles.cpSection}><span style={styles.cpSectionLabel}>△ Friction</span>{sum.friction.map((it, i) => <span key={i} style={styles.cpBullet}>· {it}</span>)}</View> : null}
          {sum?.openItems?.length ? <View style={styles.cpSection}><span style={styles.cpSectionLabel}>◇ Open items</span>{sum.openItems.map((it, i) => <span key={i} style={styles.cpBullet}>· {it}</span>)}</View> : null}
          {fileCount > 0 && <View style={styles.cpSection}><span style={styles.cpSectionLabel}>Files touched</span>{checkpoint.filesTouched.map((f, i) => <span key={i} style={styles.cpFilePath}>{f}</span>)}</View>}
          <TouchableOpacity onPress={onPress} style={styles.cpOpenBtn}>
            <span style={styles.cpOpenBtnText}>Open checkpoint →</span>
          </TouchableOpacity>
        </View>
      )}
    </div>
  );
}

export function SessionDetail() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();
  const { state } = useLocation();
  const [session, setSession] = useState<Session | null>(null);
  const [overview, setOverview] = useState<InteractionOverview | null>(null);
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const id = sessionId!;

  useEffect(() => {
    Promise.all([fetchSession(id), fetchSessionEvents(id), fetchSessionOverview(id), fetchSessionCheckpoints(id)])
      .then(([s, evs, ov, checkpoints]) => {
        setSession(s);
        setOverview(ov);
        const grouped = groupEvents(evs);
        const merged: DisplayItem[] = [];
        let cpIdx = 0;
        const sortedCps = [...checkpoints].sort((a, b) => (a.createdAt ?? "") < (b.createdAt ?? "") ? -1 : 1);

        for (const item of grouped) {
          const itemTime = item.kind === "event" ? item.event.timestamp : item.kind === "toolGroup" ? item.tools[0]?.pre.timestamp ?? "" : "";
          while (cpIdx < sortedCps.length && (sortedCps[cpIdx].createdAt ?? "") <= itemTime) {
            merged.push({ kind: "checkpoint", checkpoint: sortedCps[cpIdx++] });
          }
          merged.push(item);
        }
        while (cpIdx < sortedCps.length) merged.push({ kind: "checkpoint", checkpoint: sortedCps[cpIdx++] });

        setItems(merged);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <View style={styles.centered}><ActivityIndicator color="#6366f1" /></View>;
  if (error) return <View style={styles.centered}><span style={{ color: "#ef4444" }}>{error}</span></View>;

  return (
    <div style={{ flex: 1, overflow: "auto", backgroundColor: "#fff" }}>
      {session?.parentSessionId && (
        <TouchableOpacity style={styles.parentBanner} onPress={() => navigate(`/sessions/${session.parentSessionId}`, { state: { title: session.parentSessionId!.slice(0, 8) + "…" } })}>
          <span style={styles.parentLabel}>↑ Continuation of</span>
          <span style={styles.parentId}>{session.parentSessionId.slice(0, 8)}…</span>
        </TouchableOpacity>
      )}
      {session?.childSessionIds?.map((childId) => (
        <TouchableOpacity key={childId} style={styles.childBanner} onPress={() => navigate(`/sessions/${childId}`, { state: { title: childId.slice(0, 8) + "…" } })}>
          <span style={styles.childLabel}>↓ Continued as</span>
          <span style={styles.childId}>{childId.slice(0, 8)}…</span>
        </TouchableOpacity>
      ))}

      {overview && (
        <View style={styles.overviewCard}>
          <span style={styles.overviewLabel}>Overview</span>
          <span style={styles.overviewSummary}>{overview.summary}</span>
          {overview.keywords.length > 0 && (
            <View style={styles.overviewKeywords}>
              {overview.keywords.map((kw) => <span key={kw} style={styles.keyword}>{kw}</span>)}
            </View>
          )}
          <span style={styles.overviewTime}>
            {new Date(overview.startedAt).toLocaleString()} → {new Date(overview.endedAt).toLocaleString()}
          </span>
        </View>
      )}

      {items.length === 0 ? (
        <View style={styles.centered}><span style={{ color: "#9ca3af" }}>No events for this session.</span></View>
      ) : (
        items.map((item, idx) =>
          item.kind === "toolGroup" ? (
            <ToolGroupItem key={`grp-${idx}`} tools={item.tools} />
          ) : item.kind === "checkpoint" ? (
            <CheckpointRow
              key={`cp-${item.checkpoint.checkpointId}`}
              checkpoint={item.checkpoint}
              onPress={() => navigate(`/checkpoints/${item.checkpoint.checkpointId}`, {
                state: { title: item.checkpoint.branch ? `${item.checkpoint.branch} · ${item.checkpoint.checkpointId}` : item.checkpoint.checkpointId },
              })}
            />
          ) : (
            <EventItem key={`evt-${item.event.id}`} event={item.event} />
          )
        )
      )}
    </div>
  );
}

const styles = StyleSheet.create({
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, minHeight: 120 } as React.CSSProperties,
  parentBanner: { display: "flex", flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#f0f9ff", borderBottom: "1px solid #bae6fd", padding: "8px 14px", cursor: "pointer" } as React.CSSProperties,
  parentLabel: { fontSize: 12, color: "#0369a1" } as React.CSSProperties,
  parentId: { fontSize: 12, color: "#0369a1", fontFamily: "monospace", fontWeight: 600, textDecoration: "underline" } as React.CSSProperties,
  childBanner: { display: "flex", flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: "#f0fdf4", borderBottom: "1px solid #bbf7d0", padding: "8px 14px", cursor: "pointer" } as React.CSSProperties,
  childLabel: { fontSize: 12, color: "#15803d" } as React.CSSProperties,
  childId: { fontSize: 12, color: "#15803d", fontFamily: "monospace", fontWeight: 600, textDecoration: "underline" } as React.CSSProperties,
  overviewCard: { backgroundColor: "#fafaf9", borderBottom: "1px solid #e7e5e4", padding: "12px 14px", gap: 6 } as React.CSSProperties,
  overviewLabel: { fontSize: 10, fontWeight: 700, color: "#78716c", textTransform: "uppercase", letterSpacing: 0.6 } as React.CSSProperties,
  overviewSummary: { fontSize: 13, color: "#292524", lineHeight: "20px" } as React.CSSProperties,
  overviewKeywords: { flexDirection: "row", flexWrap: "wrap", gap: 5 } as React.CSSProperties,
  keyword: { backgroundColor: "#e7e5e4", borderRadius: 4, padding: "2px 6px", fontSize: 11, color: "#57534e", fontFamily: "monospace" } as React.CSSProperties,
  overviewTime: { fontSize: 10, color: "#a8a29e" } as React.CSSProperties,
  cpRow: { display: "flex", flexDirection: "row", alignItems: "center", gap: 10, padding: "8px 12px", backgroundColor: "#f0fdf4", cursor: "pointer" } as React.CSSProperties,
  cpBody: { flex: 1, gap: 2 } as React.CSSProperties,
  cpTop: { flexDirection: "row", alignItems: "center", gap: 8 } as React.CSSProperties,
  cpLabel: { fontSize: 12, fontWeight: 700, color: "#059669", textTransform: "uppercase" } as React.CSSProperties,
  cpId: { fontFamily: "monospace", fontSize: 12, color: "#065f46", fontWeight: 600 } as React.CSSProperties,
  cpBranch: { fontSize: 11, color: "#059669", backgroundColor: "#d1fae5", padding: "1px 5px", borderRadius: 3 } as React.CSSProperties,
  cpIntent: { fontSize: 11, color: "#6b7280", fontStyle: "italic" } as React.CSSProperties,
  cpMeta: { alignItems: "flex-end", gap: 2 } as React.CSSProperties,
  cpMetaText: { fontSize: 10, color: "#6b7280", fontFamily: "monospace" } as React.CSSProperties,
  cpDropdown: { backgroundColor: "#f8fffe", borderTop: "1px solid #d1fae5", padding: "12px 16px", gap: 10 } as React.CSSProperties,
  cpSection: { gap: 3 } as React.CSSProperties,
  cpSectionLabel: { fontSize: 10, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5 } as React.CSSProperties,
  cpSectionText: { fontSize: 12, color: "#374151", lineHeight: "18px" } as React.CSSProperties,
  cpBullet: { fontSize: 12, color: "#374151", lineHeight: "18px", paddingLeft: 4 } as React.CSSProperties,
  cpCodeLearning: { paddingLeft: 4, gap: 1, marginBottom: 2 } as React.CSSProperties,
  cpCodePath: { fontFamily: "monospace", fontSize: 11, color: "#4338ca", fontWeight: 600 } as React.CSSProperties,
  cpFilePath: { fontFamily: "monospace", fontSize: 11, color: "#6b7280", paddingLeft: 4 } as React.CSSProperties,
  cpOpenBtn: { alignSelf: "flex-start", marginTop: 4, padding: "5px 10px", borderRadius: 4, border: "1px solid #bbf7d0", cursor: "pointer" } as React.CSSProperties,
  cpOpenBtnText: { fontSize: 11, color: "#059669", fontFamily: "monospace" } as React.CSSProperties,
});
