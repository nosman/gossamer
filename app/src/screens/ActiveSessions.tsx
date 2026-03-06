import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  useWindowDimensions,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { useHeaderHeight } from "@react-navigation/elements";
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
  const router = useRouter();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { height } = useWindowDimensions();
  const headerHeight = useHeaderHeight();
  const contentHeight = height - headerHeight;

  const load = useCallback(async () => {
    try {
      const data = await fetchSessions();
      setSessions(data);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    load().finally(() => setLoading(false));
    const unsubscribe = subscribeToUpdates(() => {
      load().catch(() => undefined);
    });
    return unsubscribe;
  }, [load]);

  if (loading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#6366f1" />
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centered}>
        <Text style={styles.errorTitle}>Cannot reach API server</Text>
        <Text style={styles.errorBody}>
          Start the server with:{"\n"}
          <Text style={styles.code}>claude-hook-handler serve</Text>
        </Text>
        <Text style={styles.errorDetail}>{error}</Text>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: "Claude Sessions",
          headerRight: () => (
            <React.Fragment>
              <TouchableOpacity
                onPress={() => router.push("/checkpoints")}
                style={{ marginRight: 10 }}
              >
                <Text style={{ fontSize: 16 }}>⬛</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => router.push("/session-tree")}
                style={{ marginRight: 14 }}
              >
                <Text style={{ fontSize: 18 }}>⬡</Text>
              </TouchableOpacity>
            </React.Fragment>
          ),
        }}
      />
      <View style={[styles.scroll, { height: contentHeight }]}>
        <View style={[styles.row, styles.headerRow]}>
          {COLUMNS.map(({ label, width }) => (
            <Text key={label} style={[styles.headerCell, { width }]}>
              {label}
            </Text>
          ))}
        </View>
        <View style={styles.rowsScroll}>
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
                  router.push({
                    pathname: "/sessions/[sessionId]",
                    params: {
                      sessionId: item.sessionId,
                      title: item.summary ?? item.sessionId.slice(0, 8) + "…",
                    },
                  })
                }
              />
            ))
          )}
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  scroll: {
    overflow: "scroll",
    minWidth: TOTAL_WIDTH,
  },
  centered: {
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    minHeight: 80,
  },
  row: {
    flexDirection: "row",
  },
  headerRow: {
    backgroundColor: "#f9fafb",
    borderBottomWidth: 2,
    borderBottomColor: "#e5e7eb",
    paddingVertical: 8,
    paddingHorizontal: 8,
    minWidth: TOTAL_WIDTH,
  },
  headerCell: {
    fontSize: 12,
    fontWeight: "700",
    color: "#6b7280",
    paddingHorizontal: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  rowsScroll: {
    minWidth: TOTAL_WIDTH,
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: "700",
    color: "#ef4444",
    marginBottom: 12,
  },
  errorBody: {
    fontSize: 14,
    color: "#374151",
    textAlign: "center",
    marginBottom: 8,
    lineHeight: 22,
  },
  code: {
    fontFamily: "monospace",
    backgroundColor: "#f3f4f6",
    paddingHorizontal: 6,
  },
  errorDetail: {
    fontSize: 12,
    color: "#9ca3af",
    textAlign: "center",
  },
  emptyText: {
    fontSize: 14,
    color: "#9ca3af",
  },
});
