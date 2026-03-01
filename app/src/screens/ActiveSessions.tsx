import React, { useEffect, useState, useCallback } from "react";
import {
  View,
  Text,
  FlatList,
  RefreshControl,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
} from "react-native";
import type { StackScreenProps } from "@react-navigation/stack";
import type { RootStackParamList } from "../../App";
import { fetchSessions, subscribeToUpdates, type Session } from "../api";
import { SessionRow, COL_WIDTHS } from "../components/SessionRow";

type Props = StackScreenProps<RootStackParamList, "ActiveSessions">;

const COLUMNS: { label: string; width: number }[] = [
  { label: "Session",  width: COL_WIDTHS.session  },
  { label: "User",     width: COL_WIDTHS.user     },
  { label: "Repo",     width: COL_WIDTHS.repo     },
  { label: "Summary",  width: COL_WIDTHS.summary  },
  { label: "Keywords", width: COL_WIDTHS.keywords },
  { label: "Started",  width: COL_WIDTHS.started  },
  { label: "Updated",  width: COL_WIDTHS.updated  },
];

export function ActiveSessions({ navigation }: Props) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load().finally(() => setRefreshing(false));
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
    <ScrollView horizontal contentContainerStyle={styles.tableWrapper}>
      <View style={styles.table}>
        {/* Header row */}
        <View style={[styles.row, styles.headerRow]}>
          {COLUMNS.map(({ label, width }) => (
            <Text
              key={label}
              style={[styles.headerCell, { width }]}
            >
              {label}
            </Text>
          ))}
        </View>

        <FlatList
          data={sessions}
          keyExtractor={(item) => item.sessionId}
          renderItem={({ item }) => (
            <SessionRow
              session={item}
              onPress={() =>
                navigation.navigate("SessionDetail", {
                  sessionId: item.sessionId,
                  title: item.summary ?? item.sessionId.slice(0, 8) + "…",
                })
              }
            />
          )}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
          }
          ListEmptyComponent={
            <View style={styles.centered}>
              <Text style={styles.emptyText}>No sessions yet.</Text>
            </View>
          }
        />
      </View>
    </ScrollView>
  );
}

const TOTAL_WIDTH = Object.values(COL_WIDTHS).reduce((a, b) => a + b, 0) + 16; // +16 for row padding

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  tableWrapper: {
    flexGrow: 1,
  },
  table: {
    flex: 1,
    minWidth: TOTAL_WIDTH,
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
  },
  headerCell: {
    fontSize: 12,
    fontWeight: "700",
    color: "#6b7280",
    paddingHorizontal: 4,
    textTransform: "uppercase",
    letterSpacing: 0.5,
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
