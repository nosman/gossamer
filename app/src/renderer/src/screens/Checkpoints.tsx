import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { View, Text, TouchableOpacity, ActivityIndicator, StyleSheet } from "../primitives";
import { fetchCheckpoints, subscribeToUpdates, type Checkpoint } from "../api";

const COL = { id: 130, branch: 140, intent: 300, sessions: 70, files: 70, tokens: 90 } as const;
const TOTAL_WIDTH = Object.values(COL).reduce((a, b) => a + b, 0) + 16;
const COLUMNS = [
  { label: "Checkpoint", width: COL.id },
  { label: "Branch",     width: COL.branch },
  { label: "Intent",     width: COL.intent },
  { label: "Sessions",   width: COL.sessions },
  { label: "Files",      width: COL.files },
  { label: "Out tokens", width: COL.tokens },
];

function CheckpointRow({ checkpoint, onPress }: { checkpoint: Checkpoint; onPress: () => void }) {
  const outTokens = checkpoint.tokenUsage?.outputTokens ?? 0;
  return (
    <TouchableOpacity onPress={onPress} style={s.row}>
      <span style={{ ...s.cell, ...s.idCell, width: COL.id }}>{checkpoint.checkpointId}</span>
      <span style={{ ...s.cell, ...s.cellText, width: COL.branch }}>{checkpoint.branch ?? "—"}</span>
      <span style={{ ...s.cell, ...s.intentCell, width: COL.intent, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as React.CSSProperties}>{checkpoint.summary?.intent ?? "—"}</span>
      <span style={{ ...s.cell, ...s.numCell, width: COL.sessions }}>{checkpoint.sessionCount}</span>
      <span style={{ ...s.cell, ...s.numCell, width: COL.files }}>{checkpoint.filesTouched.length}</span>
      <span style={{ ...s.cell, ...s.numCell, width: COL.tokens }}>{outTokens > 0 ? outTokens.toLocaleString() : "—"}</span>
    </TouchableOpacity>
  );
}

export function Checkpoints() {
  const navigate = useNavigate();
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  if (loading) return <View style={s.centered}><ActivityIndicator color="#6366f1" /></View>;
  if (error) return <View style={s.centered}><span style={{ color: "#ef4444" }}>{error}</span></View>;

  return (
    <div style={{ flex: 1, overflow: "auto", backgroundColor: "#fff" }}>
      <div style={{ minWidth: TOTAL_WIDTH }}>
        {/* Sticky header */}
        <div style={{ ...s.headerRow, position: "sticky", top: 0, zIndex: 1 }}>
          {COLUMNS.map(({ label, width }) => (
            <span key={label} style={{ ...s.headerCell, width }}>{label}</span>
          ))}
        </div>

        {checkpoints.length === 0 ? (
          <View style={s.centered}><span style={{ color: "#9ca3af" }}>No checkpoints indexed yet.</span></View>
        ) : (
          checkpoints.map((cp) => (
            <CheckpointRow
              key={cp.checkpointId}
              checkpoint={cp}
              onPress={() =>
                navigate(`/checkpoints/${cp.checkpointId}`, {
                  state: { title: cp.branch ? `${cp.branch} · ${cp.checkpointId}` : cp.checkpointId },
                })
              }
            />
          ))
        )}
      </div>
    </div>
  );
}

const s = StyleSheet.create({
  centered: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24, minHeight: 80 } as React.CSSProperties,
  headerRow: { display: "flex", flexDirection: "row", backgroundColor: "#f9fafb", borderBottom: "2px solid #e5e7eb", padding: "8px" } as React.CSSProperties,
  headerCell: { fontSize: 12, fontWeight: 700, color: "#6b7280", padding: "0 4px", textTransform: "uppercase", letterSpacing: 0.5, flexShrink: 0 } as React.CSSProperties,
  row: { display: "flex", flexDirection: "row", alignItems: "center", padding: "8px", borderBottom: "1px solid #e5e7eb", cursor: "pointer" } as React.CSSProperties,
  cell: { padding: "0 4px", overflow: "hidden", flexShrink: 0 } as React.CSSProperties,
  idCell: { fontFamily: "monospace", fontSize: 13, color: "#059669", fontWeight: 600 } as React.CSSProperties,
  cellText: { fontSize: 13, color: "#374151" } as React.CSSProperties,
  intentCell: { fontSize: 12, color: "#6b7280", fontStyle: "italic" } as React.CSSProperties,
  numCell: { fontSize: 13, color: "#6b7280", textAlign: "right" } as React.CSSProperties,
});
