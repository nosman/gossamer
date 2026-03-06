import React, { useCallback, useEffect, useState } from "react";
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
import { fetchCheckpoints, subscribeToUpdates, type Checkpoint } from "../api";

type Props = StackScreenProps<RootStackParamList, "Checkpoints">;

// ─── Column config ────────────────────────────────────────────────────────────

const COL = {
  id:       130,
  branch:   140,
  intent:   300,
  sessions:  70,
  files:     70,
  tokens:    90,
} as const;

const TOTAL_WIDTH = Object.values(COL).reduce((a, b) => a + b, 0) + 16;

const COLUMNS: { label: string; width: number }[] = [
  { label: "Checkpoint", width: COL.id },
  { label: "Branch",     width: COL.branch },
  { label: "Intent",     width: COL.intent },
  { label: "Sessions",   width: COL.sessions },
  { label: "Files",      width: COL.files },
  { label: "Out tokens", width: COL.tokens },
];

// ─── Row component ────────────────────────────────────────────────────────────

function CheckpointRow({ checkpoint, onPress }: { checkpoint: Checkpoint; onPress: () => void }) {
  const outTokens = checkpoint.tokenUsage?.outputTokens ?? 0;
  return (
    <TouchableOpacity onPress={onPress} style={s.row}>
      <Text style={[s.cell, s.idCell, { width: COL.id }]} numberOfLines={1}>
        {checkpoint.checkpointId}
      </Text>
      <Text style={[s.cell, s.cellText, { width: COL.branch }]} numberOfLines={1}>
        {checkpoint.branch ?? "—"}
      </Text>
      <Text style={[s.cell, s.intentCell, { width: COL.intent }]} numberOfLines={1}>
        {checkpoint.summary?.intent ?? "—"}
      </Text>
      <Text style={[s.cell, s.numCell, { width: COL.sessions }]} numberOfLines={1}>
        {checkpoint.sessionCount}
      </Text>
      <Text style={[s.cell, s.numCell, { width: COL.files }]} numberOfLines={1}>
        {checkpoint.filesTouched.length}
      </Text>
      <Text style={[s.cell, s.numCell, { width: COL.tokens }]} numberOfLines={1}>
        {outTokens > 0 ? outTokens.toLocaleString() : "—"}
      </Text>
    </TouchableOpacity>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export function Checkpoints({ navigation }: Props) {
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { height } = useWindowDimensions();
  const headerHeight = useHeaderHeight();
  const contentHeight = height - headerHeight;

  const load = useCallback(async () => {
    try {
      setCheckpoints(await fetchCheckpoints());
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    load().finally(() => setLoading(false));
    return subscribeToUpdates(() => { load().catch(() => undefined); });
  }, [load]);

  if (loading) {
    return (
      <View style={s.centered}>
        <ActivityIndicator size="large" color="#6366f1" />
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

  return (
    <View style={[s.scroll, { height: contentHeight }]}>
      {/* Sticky header */}
      <View style={[s.headerRow, { minWidth: TOTAL_WIDTH }]}>
        {COLUMNS.map(({ label, width }) => (
          <Text key={label} style={[s.headerCell, { width }]}>{label}</Text>
        ))}
      </View>

      {/* Rows */}
      <View style={{ minWidth: TOTAL_WIDTH }}>
        {checkpoints.length === 0 ? (
          <View style={s.centered}>
            <Text style={s.emptyText}>No checkpoints indexed yet.</Text>
          </View>
        ) : (
          checkpoints.map((cp) => (
            <CheckpointRow
              key={cp.checkpointId}
              checkpoint={cp}
              onPress={() =>
                navigation.navigate("CheckpointDetail", {
                  checkpointId: cp.checkpointId,
                  title: cp.branch ? `${cp.branch} · ${cp.checkpointId}` : cp.checkpointId,
                })
              }
            />
          ))
        )}
      </View>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  scroll: {
    overflow: "scroll",
    minWidth: TOTAL_WIDTH,
    backgroundColor: "#fff",
  },
  centered: {
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    minHeight: 80,
  },
  headerRow: {
    flexDirection: "row",
    backgroundColor: "#f9fafb",
    borderBottomWidth: 2,
    borderBottomColor: "#e5e7eb",
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  headerCell: {
    fontSize: 12,
    fontWeight: "700",
    color: "#6b7280",
    paddingHorizontal: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
  },
  cell: {
    paddingHorizontal: 4,
    overflow: "hidden",
  },
  idCell: {
    fontFamily: "monospace",
    fontSize: 13,
    color: "#059669",
    fontWeight: "600",
  },
  cellText: {
    fontSize: 13,
    color: "#374151",
  },
  intentCell: {
    fontSize: 12,
    color: "#6b7280",
    fontStyle: "italic",
  },
  numCell: {
    fontSize: 13,
    color: "#6b7280",
    textAlign: "right",
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
});
