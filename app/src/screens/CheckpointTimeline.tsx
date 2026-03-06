import React, { useCallback, useEffect, useState } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  useWindowDimensions,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { useHeaderHeight } from "@react-navigation/elements";
import { fetchCheckpoints, subscribeToUpdates, type Checkpoint } from "../api";

// ─── Timeline node ────────────────────────────────────────────────────────────

const BRANCH_COLORS: string[] = [
  "#6366f1", // indigo
  "#059669", // emerald
  "#d97706", // amber
  "#dc2626", // red
  "#7c3aed", // violet
  "#0891b2", // cyan
  "#db2777", // pink
];

function branchColor(branch: string | null): string {
  if (!branch) return "#9ca3af";
  let hash = 0;
  for (let i = 0; i < branch.length; i++) {
    hash = (hash * 31 + branch.charCodeAt(i)) >>> 0;
  }
  return BRANCH_COLORS[hash % BRANCH_COLORS.length];
}

interface TimelineNodeProps {
  checkpoint: Checkpoint;
  isLast: boolean;
  onPress: () => void;
}

function TimelineNode({ checkpoint, isLast, onPress }: TimelineNodeProps) {
  const color = branchColor(checkpoint.branch);
  const outTokens = checkpoint.tokenUsage?.outputTokens ?? 0;
  const fileCount = checkpoint.filesTouched.length;

  return (
    <TouchableOpacity style={s.node} onPress={onPress} activeOpacity={0.75}>
      {/* Left rail */}
      <View style={s.rail}>
        <View style={[s.dot, { backgroundColor: color, borderColor: color }]} />
        {!isLast && <View style={s.line} />}
      </View>

      {/* Card */}
      <View style={[s.card, { borderLeftColor: color }]}>
        {/* Top row: branch + id */}
        <View style={s.cardTop}>
          {checkpoint.branch ? (
            <View style={[s.branchChip, { backgroundColor: color + "22", borderColor: color + "55" }]}>
              <Text style={[s.branchText, { color }]} numberOfLines={1}>{checkpoint.branch}</Text>
            </View>
          ) : null}
          <Text style={s.checkpointId} numberOfLines={1}>{checkpoint.checkpointId}</Text>
        </View>

        {/* Intent */}
        {checkpoint.summary?.intent ? (
          <Text style={s.intent} numberOfLines={2}>{checkpoint.summary.intent}</Text>
        ) : null}

        {/* Stats row */}
        <View style={s.statsRow}>
          {fileCount > 0 && (
            <Text style={s.stat}>{fileCount} file{fileCount !== 1 ? "s" : ""}</Text>
          )}
          {outTokens > 0 && (
            <Text style={s.stat}>{outTokens.toLocaleString()} tok</Text>
          )}
          {checkpoint.sessionCount > 0 && (
            <Text style={s.stat}>{checkpoint.sessionCount} session{checkpoint.sessionCount !== 1 ? "s" : ""}</Text>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export function CheckpointTimeline() {
  const router = useRouter();
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { height } = useWindowDimensions();
  const headerHeight = useHeaderHeight();
  const contentHeight = height - headerHeight;

  const load = useCallback(async () => {
    try {
      const data = await fetchCheckpoints();
      // Sort ascending by id so earliest checkpoint is at top
      setCheckpoints([...data].sort((a, b) => a.id - b.id));
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
      <>
        <Stack.Screen options={{ title: "Checkpoint Timeline" }} />
        <View style={s.centered}>
          <ActivityIndicator size="large" color="#059669" />
        </View>
      </>
    );
  }

  if (error) {
    return (
      <>
        <Stack.Screen options={{ title: "Checkpoint Timeline" }} />
        <View style={s.centered}>
          <Text style={s.errorText}>{error}</Text>
        </View>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: "Checkpoint Timeline" }} />
      <View style={[s.scroll, { height: contentHeight }]}>
        {checkpoints.length === 0 ? (
          <View style={s.centered}>
            <Text style={s.emptyText}>No checkpoints indexed yet.</Text>
          </View>
        ) : (
          <View style={s.list}>
            {checkpoints.map((cp, idx) => (
              <TimelineNode
                key={cp.checkpointId}
                checkpoint={cp}
                isLast={idx === checkpoints.length - 1}
                onPress={() =>
                  router.push({
                    pathname: "/checkpoints/[checkpointId]",
                    params: {
                      checkpointId: cp.checkpointId,
                      title: cp.branch ? `${cp.branch} · ${cp.checkpointId}` : cp.checkpointId,
                    },
                  })
                }
              />
            ))}
          </View>
        )}
      </View>
    </>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const DOT_SIZE = 14;
const RAIL_WIDTH = 32;

const s = StyleSheet.create({
  scroll: {
    overflow: "scroll",
    backgroundColor: "#fff",
  },
  centered: {
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    minHeight: 120,
  },
  list: {
    paddingTop: 16,
    paddingBottom: 32,
    paddingRight: 16,
  },

  // ── Node layout ────────────────────────────────────────────────────────────
  node: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: 0,
  },

  // ── Rail (dot + vertical line) ─────────────────────────────────────────────
  rail: {
    width: RAIL_WIDTH,
    alignItems: "center",
    flexShrink: 0,
  },
  dot: {
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_SIZE / 2,
    borderWidth: 2,
    marginTop: 14,
    zIndex: 1,
  },
  line: {
    width: 2,
    flex: 1,
    minHeight: 20,
    backgroundColor: "#e5e7eb",
    marginTop: 2,
  },

  // ── Card ───────────────────────────────────────────────────────────────────
  card: {
    flex: 1,
    borderLeftWidth: 3,
    borderRadius: 6,
    backgroundColor: "#f9fafb",
    marginTop: 8,
    marginBottom: 8,
    marginLeft: 6,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 5,
  },
  cardTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  branchChip: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  branchText: {
    fontSize: 11,
    fontWeight: "600",
  },
  checkpointId: {
    fontFamily: "monospace",
    fontSize: 12,
    color: "#374151",
    fontWeight: "600",
    flex: 1,
  },
  intent: {
    fontSize: 12,
    color: "#6b7280",
    fontStyle: "italic",
    lineHeight: 17,
  },
  statsRow: {
    flexDirection: "row",
    gap: 10,
    flexWrap: "wrap",
  },
  stat: {
    fontSize: 11,
    color: "#9ca3af",
    fontFamily: "monospace",
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
