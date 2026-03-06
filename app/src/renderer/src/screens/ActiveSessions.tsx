import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { View, Text, ActivityIndicator, StyleSheet } from "../primitives";
import { fetchSessions, subscribeToUpdates, type Session } from "../api";
import { SessionRow, COL_WIDTHS } from "../components/SessionRow";

const COLUMNS: { label: string; width: number }[] = [
  { label: "Session",  width: COL_WIDTHS.session  },
  { label: "User",     width: COL_WIDTHS.user     },
  { label: "Repo",     width: COL_WIDTHS.repo     },
  { label: "Summary",  width: COL_WIDTHS.summary  },
  { label: "Keywords", width: COL_WIDTHS.keywords },
  { label: "Started",  width: COL_WIDTHS.started  },
  { label: "Updated",  width: COL_WIDTHS.updated  },
];

const TOTAL_WIDTH = Object.values(COL_WIDTHS).reduce((a, b) => a + b, 0) + 16;

export function ActiveSessions() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSessions(await fetchSessions());
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
      <View style={styles.centered}>
        <ActivityIndicator color="#6366f1" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorTitle}>Cannot reach API server</Text>
        <Text style={styles.errorBody}>
          Start the server with:{" "}
          <span style={{ fontFamily: "monospace", background: "#f3f4f6", padding: "0 6px" }}>
            claude-hook-handler serve
          </span>
        </Text>
        <Text style={styles.errorDetail}>{error}</Text>
      </View>
    );
  }

  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <div style={{ minWidth: TOTAL_WIDTH }}>
        {/* Sticky header */}
        <div style={{ ...styles.headerRow, position: "sticky", top: 0, zIndex: 1 }}>
          {COLUMNS.map(({ label, width }) => (
            <Text key={label} style={{ ...styles.headerCell, width }}>
              {label}
            </Text>
          ))}
        </div>

        {/* Rows */}
        {sessions.length === 0 ? (
          <View style={styles.centered}>
            <Text style={styles.emptyText}>No sessions yet.</Text>
          </View>
        ) : (
          sessions.map((item) => (
            <SessionRow
              key={item.sessionId}
              session={item}
              onPress={() =>
                navigate(`/sessions/${item.sessionId}`, {
                  state: { title: item.summary ?? item.sessionId.slice(0, 8) + "…" },
                })
              }
            />
          ))
        )}
      </div>
    </div>
  );
}

const styles = StyleSheet.create({
  centered: {
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    minHeight: 80,
    flex: 1,
  } as React.CSSProperties,
  headerRow: {
    display: "flex",
    flexDirection: "row",
    backgroundColor: "#f9fafb",
    borderBottom: "2px solid #e5e7eb",
    paddingTop: 8,
    paddingBottom: 8,
    paddingLeft: 8,
    paddingRight: 8,
  } as React.CSSProperties,
  headerCell: {
    fontSize: 12,
    fontWeight: 700,
    color: "#6b7280",
    paddingLeft: 4,
    paddingRight: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    flexShrink: 0,
  } as React.CSSProperties,
  errorTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: "#ef4444",
    marginBottom: 12,
  } as React.CSSProperties,
  errorBody: {
    fontSize: 14,
    color: "#374151",
    textAlign: "center",
    marginBottom: 8,
    lineHeight: "22px",
  } as React.CSSProperties,
  errorDetail: {
    fontSize: 12,
    color: "#9ca3af",
    textAlign: "center",
  } as React.CSSProperties,
  emptyText: {
    fontSize: 14,
    color: "#9ca3af",
  } as React.CSSProperties,
});
