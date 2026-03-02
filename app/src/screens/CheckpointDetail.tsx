import React, { useEffect, useMemo, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  useWindowDimensions,
} from "react-native";
import { useHeaderHeight } from "@react-navigation/elements";
import type { StackScreenProps } from "@react-navigation/stack";
import type { RootStackParamList } from "../../App";
import { fetchCheckpoint, fetchCheckpointMessages, type Checkpoint, type CheckpointMessage, type CheckpointSummary } from "../api";
import { CheckpointMessageItem, type ToolResultBlock } from "../components/CheckpointMessageItem";

type Props = StackScreenProps<RootStackParamList, "CheckpointDetail">;

// ─── Screen ───────────────────────────────────────────────────────────────────

// ─── Summary card ─────────────────────────────────────────────────────────────

function SummarySection({ label, items }: { label: string; items: string[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <View style={s.section}>
      <TouchableOpacity onPress={() => setOpen((v) => !v)} style={s.sectionHeader}>
        <Text style={s.sectionLabel}>{label} ({items.length})</Text>
        <Text style={s.sectionChevron}>{open ? "▲" : "▼"}</Text>
      </TouchableOpacity>
      {open && items.map((item, i) => (
        <Text key={i} style={s.sectionItem} selectable>{"· "}{item}</Text>
      ))}
    </View>
  );
}

function CodeLearningSections({ items }: { items: Array<{ path: string; finding: string }> }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <View style={s.section}>
      <TouchableOpacity onPress={() => setOpen((v) => !v)} style={s.sectionHeader}>
        <Text style={s.sectionLabel}>Code learnings ({items.length})</Text>
        <Text style={s.sectionChevron}>{open ? "▲" : "▼"}</Text>
      </TouchableOpacity>
      {open && items.map((item, i) => (
        <View key={i} style={s.codeLearningItem}>
          <Text style={s.codePath}>{item.path}</Text>
          <Text style={s.sectionItem} selectable>{item.finding}</Text>
        </View>
      ))}
    </View>
  );
}

function SummaryCard({ summary }: { summary: CheckpointSummary }) {
  return (
    <View style={s.summaryCard}>
      <Text style={s.summaryCardLabel}>Summary</Text>
      <View style={s.summaryBlock}>
        <Text style={s.fieldLabel}>Intent</Text>
        <Text style={s.fieldText} selectable>{summary.intent}</Text>
      </View>
      <View style={s.summaryBlock}>
        <Text style={s.fieldLabel}>Outcome</Text>
        <Text style={s.fieldText} selectable>{summary.outcome}</Text>
      </View>
      <SummarySection label="Repo learnings"     items={summary.learningsRepo} />
      <CodeLearningSections                       items={summary.learningsCode} />
      <SummarySection label="Workflow learnings"  items={summary.learningsWorkflow} />
      <SummarySection label="Friction"            items={summary.friction} />
      <SummarySection label="Open items"          items={summary.openItems} />
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export function CheckpointDetail({ route }: Props) {
  const { checkpointId } = route.params;
  const [checkpoint, setCheckpoint] = useState<Checkpoint | null>(null);
  const [messages, setMessages] = useState<CheckpointMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCompact, setShowCompact] = useState(false);

  const { height } = useWindowDimensions();
  const headerHeight = useHeaderHeight();
  const contentHeight = height - headerHeight;

  useEffect(() => {
    Promise.all([fetchCheckpoint(checkpointId), fetchCheckpointMessages(checkpointId)])
      .then(([cp, msgs]) => { setCheckpoint(cp); setMessages(msgs); setError(null); })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [checkpointId]);

  // Build a map from tool_use_id → tool_result block for rendering paired outputs
  const toolResults = useMemo(() => {
    const map = new Map<string, ToolResultBlock>();
    for (const msg of messages) {
      if (msg.type !== "user") continue;
      const d = msg.data as Record<string, unknown>;
      const content = (d.message as Record<string, unknown> | undefined)?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as ToolResultBlock[]) {
        if (block.type === "tool_result" && block.tool_use_id) {
          map.set(block.tool_use_id, block);
        }
      }
    }
    return map;
  }, [messages]);

  if (loading) {
    return (
      <View style={s.centered}>
        <ActivityIndicator size="large" color="#059669" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={s.centered}>
        <Text style={s.errorText}>{error}</Text>
      </View>
    );
  }

  const counts = messages.reduce<Record<string, number>>((acc, m) => {
    acc[m.type] = (acc[m.type] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <View style={[s.scroll, { height: contentHeight }]}>
      {/* Stats bar */}
      <View style={s.statsBar}>
        {Object.entries(counts).map(([type, count]) => (
          <View key={type} style={s.statChip}>
            <Text style={s.statText}>{type} {count}</Text>
          </View>
        ))}
        <TouchableOpacity
          style={[s.filterBtn, showCompact && s.filterBtnActive]}
          onPress={() => setShowCompact((v) => !v)}
        >
          <Text style={[s.filterBtnText, showCompact && s.filterBtnTextActive]}>
            {showCompact ? "▲ hide system" : "▼ show system"}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Summary card */}
      {checkpoint?.summary && <SummaryCard summary={checkpoint.summary} />}

      {/* Message list */}
      {messages.length === 0 ? (
        <View style={s.centered}>
          <Text style={s.emptyText}>No messages in this checkpoint.</Text>
        </View>
      ) : (
        messages.map((msg) => (
          <CheckpointMessageItem
            key={msg.uuid}
            msg={msg}
            toolResults={toolResults}
            showCompact={showCompact}
          />
        ))
      )}
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  scroll: {
    backgroundColor: "#fff",
    overflow: "scroll",
  },
  centered: {
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    minHeight: 120,
  },
  statsBar: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "#f8fafc",
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
  },
  statChip: {
    backgroundColor: "#e2e8f0",
    borderRadius: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  statText: {
    fontSize: 11,
    color: "#475569",
    fontFamily: "monospace",
  },
  filterBtn: {
    marginLeft: "auto",
    borderRadius: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderWidth: 1,
    borderColor: "#cbd5e1",
  },
  filterBtnActive: {
    backgroundColor: "#0f172a",
    borderColor: "#0f172a",
  },
  filterBtnText: {
    fontSize: 11,
    color: "#64748b",
  },
  filterBtnTextActive: {
    color: "#f8fafc",
  },
  errorText: {
    fontSize: 14,
    color: "#ef4444",
    textAlign: "center",
  },
  emptyText: {
    fontSize: 14,
    color: "#9ca3af",
  },
  summaryCard: {
    backgroundColor: "#f0fdf4",
    borderBottomWidth: 1,
    borderBottomColor: "#bbf7d0",
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 8,
  },
  summaryCardLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#166534",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  summaryBlock: {
    gap: 2,
  },
  fieldLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#4b5563",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  fieldText: {
    fontSize: 13,
    color: "#111827",
    lineHeight: 19,
  },
  section: {
    gap: 4,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  sectionLabel: {
    fontSize: 11,
    fontWeight: "600",
    color: "#374151",
  },
  sectionChevron: {
    fontSize: 9,
    color: "#9ca3af",
  },
  sectionItem: {
    fontSize: 12,
    color: "#4b5563",
    lineHeight: 18,
    paddingLeft: 8,
  },
  codeLearningItem: {
    paddingLeft: 8,
    gap: 1,
    marginBottom: 4,
  },
  codePath: {
    fontSize: 11,
    fontFamily: "monospace",
    color: "#4338ca",
    fontWeight: "600",
  },
});
