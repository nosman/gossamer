import React, { useEffect, useMemo, useState } from "react";
import { useParams, useLocation } from "react-router-dom";
import { View, TouchableOpacity, ActivityIndicator, StyleSheet } from "../primitives";
import {
  fetchCheckpoint,
  fetchCheckpointMessages,
  type Checkpoint,
  type CheckpointMessage,
  type CheckpointSummary,
} from "../api";
import { CheckpointMessageItem, type ToolResultBlock } from "../components/CheckpointMessageItem";

function SummarySection({ label, items }: { label: string; items: string[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <View style={s.section}>
      <TouchableOpacity onPress={() => setOpen((v) => !v)} style={s.sectionHeader}>
        <span style={s.sectionLabel}>{label} ({items.length})</span>
        <span style={s.sectionChevron}>{open ? "▲" : "▼"}</span>
      </TouchableOpacity>
      {open && items.map((item, i) => <span key={i} style={s.sectionItem}>{"· "}{item}</span>)}
    </View>
  );
}

function CodeLearningSections({ items }: { items: Array<{ path: string; finding: string }> }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <View style={s.section}>
      <TouchableOpacity onPress={() => setOpen((v) => !v)} style={s.sectionHeader}>
        <span style={s.sectionLabel}>Code learnings ({items.length})</span>
        <span style={s.sectionChevron}>{open ? "▲" : "▼"}</span>
      </TouchableOpacity>
      {open && items.map((item, i) => (
        <View key={i} style={s.codeLearningItem}>
          <span style={s.codePath}>{item.path}</span>
          <span style={s.sectionItem}>{item.finding}</span>
        </View>
      ))}
    </View>
  );
}

function SummaryCard({ summary }: { summary: CheckpointSummary }) {
  return (
    <View style={s.summaryCard}>
      <span style={s.summaryCardLabel}>Summary</span>
      <View style={s.summaryBlock}>
        <span style={s.fieldLabel}>Intent</span>
        <span style={s.fieldText}>{summary.intent}</span>
      </View>
      <View style={s.summaryBlock}>
        <span style={s.fieldLabel}>Outcome</span>
        <span style={s.fieldText}>{summary.outcome}</span>
      </View>
      <SummarySection label="Repo learnings"    items={summary.repoLearnings} />
      <CodeLearningSections                      items={summary.codeLearnings} />
      <SummarySection label="Workflow learnings" items={summary.workflowLearnings} />
      <SummarySection label="Friction"           items={summary.friction} />
      <SummarySection label="Open items"         items={summary.openItems} />
    </View>
  );
}

export function CheckpointDetail() {
  const { checkpointId } = useParams<{ checkpointId: string }>();
  const { state } = useLocation();
  const [checkpoint, setCheckpoint] = useState<Checkpoint | null>(null);
  const [messages, setMessages] = useState<CheckpointMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCompact, setShowCompact] = useState(false);

  const id = checkpointId!;

  useEffect(() => {
    Promise.all([fetchCheckpoint(id), fetchCheckpointMessages(id)])
      .then(([cp, msgs]) => { setCheckpoint(cp); setMessages(msgs); setError(null); })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [id]);

  const toolResults = useMemo(() => {
    const map = new Map<string, ToolResultBlock>();
    for (const msg of messages) {
      if (msg.type !== "user") continue;
      const d = msg.data as Record<string, unknown>;
      const content = (d.message as Record<string, unknown> | undefined)?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as ToolResultBlock[]) {
        if (block.type === "tool_result" && block.tool_use_id) map.set(block.tool_use_id, block);
      }
    }
    return map;
  }, [messages]);

  if (loading) return <View style={s.centered}><ActivityIndicator color="#059669" /></View>;
  if (error) return <View style={s.centered}><span style={{ color: "#ef4444" }}>{error}</span></View>;

  const counts = messages.reduce<Record<string, number>>((acc, m) => {
    acc[m.type] = (acc[m.type] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div style={{ flex: 1, overflow: "auto", backgroundColor: "#fff" }}>
      {/* Stats bar */}
      <div style={s.statsBar}>
        {Object.entries(counts).map(([type, count]) => (
          <span key={type} style={s.statChip}>{type} {count}</span>
        ))}
        <TouchableOpacity
          style={{ ...s.filterBtn, ...(showCompact ? s.filterBtnActive : {}) } as React.CSSProperties}
          onPress={() => setShowCompact((v) => !v)}
        >
          <span style={{ ...s.filterBtnText, ...(showCompact ? s.filterBtnTextActive : {}) } as React.CSSProperties}>
            {showCompact ? "▲ hide system" : "▼ show system"}
          </span>
        </TouchableOpacity>
      </div>

      {checkpoint?.summary && <SummaryCard summary={checkpoint.summary} />}

      {messages.length === 0 ? (
        <View style={s.centered}><span style={{ color: "#9ca3af" }}>No messages in this checkpoint.</span></View>
      ) : (
        messages.map((msg) => (
          <CheckpointMessageItem key={msg.uuid} msg={msg} toolResults={toolResults} showCompact={showCompact} />
        ))
      )}
    </div>
  );
}

const s = StyleSheet.create({
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, minHeight: 120 } as React.CSSProperties,
  statsBar: { display: "flex", flexDirection: "row", flexWrap: "wrap", gap: 6, alignItems: "center", padding: "8px 12px", backgroundColor: "#f8fafc", borderBottom: "1px solid #e5e7eb" } as React.CSSProperties,
  statChip: { backgroundColor: "#e2e8f0", borderRadius: 4, padding: "2px 7px", fontSize: 11, color: "#475569", fontFamily: "monospace" } as React.CSSProperties,
  filterBtn: { marginLeft: "auto", borderRadius: 4, padding: "3px 8px", border: "1px solid #cbd5e1", cursor: "pointer" } as React.CSSProperties,
  filterBtnActive: { backgroundColor: "#0f172a", borderColor: "#0f172a" } as React.CSSProperties,
  filterBtnText: { fontSize: 11, color: "#64748b" } as React.CSSProperties,
  filterBtnTextActive: { color: "#f8fafc" } as React.CSSProperties,
  summaryCard: { backgroundColor: "#f0fdf4", borderBottom: "1px solid #bbf7d0", padding: "12px 14px", gap: 8 } as React.CSSProperties,
  summaryCardLabel: { fontSize: 10, fontWeight: 700, color: "#166534", textTransform: "uppercase", letterSpacing: 0.6 } as React.CSSProperties,
  summaryBlock: { gap: 2 } as React.CSSProperties,
  fieldLabel: { fontSize: 10, fontWeight: 700, color: "#4b5563", textTransform: "uppercase", letterSpacing: 0.4 } as React.CSSProperties,
  fieldText: { fontSize: 13, color: "#111827", lineHeight: "19px" } as React.CSSProperties,
  section: { gap: 4 } as React.CSSProperties,
  sectionHeader: { display: "flex", flexDirection: "row", alignItems: "center", gap: 6, cursor: "pointer" } as React.CSSProperties,
  sectionLabel: { fontSize: 11, fontWeight: 600, color: "#374151" } as React.CSSProperties,
  sectionChevron: { fontSize: 9, color: "#9ca3af" } as React.CSSProperties,
  sectionItem: { fontSize: 12, color: "#4b5563", lineHeight: "18px", paddingLeft: 8 } as React.CSSProperties,
  codeLearningItem: { paddingLeft: 8, gap: 1, marginBottom: 4 } as React.CSSProperties,
  codePath: { fontFamily: "monospace", fontSize: 11, color: "#4338ca", fontWeight: 600 } as React.CSSProperties,
});
