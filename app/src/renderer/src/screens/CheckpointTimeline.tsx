import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { View, ActivityIndicator, StyleSheet } from "../primitives";
import { fetchCheckpoints, subscribeToUpdates, type Checkpoint } from "../api";

const BRANCH_COLORS = ["#6366f1", "#059669", "#d97706", "#dc2626", "#7c3aed", "#0891b2", "#db2777"];

function branchColor(branch: string | null): string {
  if (!branch) return "#9ca3af";
  let hash = 0;
  for (let i = 0; i < branch.length; i++) hash = (hash * 31 + branch.charCodeAt(i)) >>> 0;
  return BRANCH_COLORS[hash % BRANCH_COLORS.length];
}

function TimelineNode({ checkpoint, isLast, onPress }: { checkpoint: Checkpoint; isLast: boolean; onPress: () => void }) {
  const color = branchColor(checkpoint.branch);
  const outTokens = checkpoint.tokenUsage?.outputTokens ?? 0;
  const fileCount = checkpoint.filesTouched.length;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onPress}
      onKeyDown={(e) => e.key === "Enter" && onPress()}
      style={s.node}
    >
      {/* Rail */}
      <div style={s.rail}>
        <div style={{ ...s.dot, backgroundColor: color, borderColor: color } as React.CSSProperties} />
        {!isLast && <div style={s.line} />}
      </div>

      {/* Card */}
      <div style={{ ...s.card, borderLeftColor: color } as React.CSSProperties}>
        <div style={s.cardTop}>
          {checkpoint.branch && (
            <span style={{ ...s.branchChip, backgroundColor: color + "22", borderColor: color + "55", color } as React.CSSProperties}>
              {checkpoint.branch}
            </span>
          )}
          <span style={s.checkpointId}>{checkpoint.checkpointId}</span>
        </div>
        {checkpoint.summary?.intent && (
          <div style={s.intent}>{checkpoint.summary.intent}</div>
        )}
        <div style={s.statsRow}>
          {fileCount > 0 && <span style={s.stat}>{fileCount} file{fileCount !== 1 ? "s" : ""}</span>}
          {outTokens > 0 && <span style={s.stat}>{outTokens.toLocaleString()} tok</span>}
          {checkpoint.sessionCount > 0 && <span style={s.stat}>{checkpoint.sessionCount} session{checkpoint.sessionCount !== 1 ? "s" : ""}</span>}
        </div>
      </div>
    </div>
  );
}

export function CheckpointTimeline() {
  const navigate = useNavigate();
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchCheckpoints();
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

  if (loading) return <View style={s.centered}><ActivityIndicator color="#059669" /></View>;
  if (error) return <View style={s.centered}><span style={{ color: "#ef4444" }}>{error}</span></View>;

  return (
    <div style={{ flex: 1, overflow: "auto", backgroundColor: "#fff" }}>
      {checkpoints.length === 0 ? (
        <View style={s.centered}><span style={{ color: "#9ca3af" }}>No checkpoints indexed yet.</span></View>
      ) : (
        <div style={{ paddingTop: 16, paddingBottom: 32, paddingRight: 16 }}>
          {checkpoints.map((cp, idx) => (
            <TimelineNode
              key={cp.checkpointId}
              checkpoint={cp}
              isLast={idx === checkpoints.length - 1}
              onPress={() =>
                navigate(`/checkpoints/${cp.checkpointId}`, {
                  state: { title: cp.branch ? `${cp.branch} · ${cp.checkpointId}` : cp.checkpointId },
                })
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

const DOT = 14;
const RAIL = 32;

const s = StyleSheet.create({
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, minHeight: 120 } as React.CSSProperties,
  node: { display: "flex", flexDirection: "row", alignItems: "flex-start", cursor: "pointer" } as React.CSSProperties,
  rail: { width: RAIL, display: "flex", flexDirection: "column", alignItems: "center", flexShrink: 0 } as React.CSSProperties,
  dot: { width: DOT, height: DOT, borderRadius: "50%", border: "2px solid", marginTop: 14, zIndex: 1 } as React.CSSProperties,
  line: { width: 2, flex: 1, minHeight: 20, backgroundColor: "#e5e7eb", marginTop: 2 } as React.CSSProperties,
  card: { flex: 1, borderLeft: "3px solid", borderRadius: 6, backgroundColor: "#f9fafb", margin: "8px 0 8px 6px", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 5 } as React.CSSProperties,
  cardTop: { display: "flex", flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" } as React.CSSProperties,
  branchChip: { border: "1px solid", borderRadius: 4, padding: "2px 6px", fontSize: 11, fontWeight: 600 } as React.CSSProperties,
  checkpointId: { fontFamily: "monospace", fontSize: 12, color: "#374151", fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as React.CSSProperties,
  intent: { fontSize: 12, color: "#6b7280", fontStyle: "italic", lineHeight: "17px", overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" } as React.CSSProperties,
  statsRow: { display: "flex", flexDirection: "row", gap: 10, flexWrap: "wrap" } as React.CSSProperties,
  stat: { fontSize: 11, color: "#9ca3af", fontFamily: "monospace" } as React.CSSProperties,
});
