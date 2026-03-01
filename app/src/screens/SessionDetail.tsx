import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
} from "react-native";
import type { StackScreenProps } from "@react-navigation/stack";
import type { RootStackParamList } from "../../App";
import { fetchSession, fetchSessionEvents, type Session, type Event } from "../api";
import { EventItem } from "../components/EventItem";

type Props = StackScreenProps<RootStackParamList, "SessionDetail">;

export function SessionDetail({ route, navigation }: Props) {
  const { sessionId } = route.params;
  const [session, setSession] = useState<Session | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetchSession(sessionId), fetchSessionEvents(sessionId)])
      .then(([s, evs]) => {
        setSession(s);
        setEvents(evs);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [sessionId]);

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
        <Text style={styles.errorText}>{error}</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      {session?.parentSessionId && (
        <TouchableOpacity
          style={styles.parentBanner}
          onPress={() =>
            navigation.push("SessionDetail", {
              sessionId: session.parentSessionId!,
              title: session.parentSessionId!.slice(0, 8) + "…",
            })
          }
        >
          <Text style={styles.parentLabel}>↑ Continuation of</Text>
          <Text style={styles.parentId}>{session.parentSessionId.slice(0, 8)}…</Text>
        </TouchableOpacity>
      )}

      {events.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyText}>No events for this session.</Text>
        </View>
      ) : (
        events.map((event) => <EventItem key={event.id} event={event} />)
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#fff",
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },
  parentBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#f0f9ff",
    borderBottomWidth: 1,
    borderBottomColor: "#bae6fd",
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  parentLabel: {
    fontSize: 12,
    color: "#0369a1",
  },
  parentId: {
    fontSize: 12,
    color: "#0369a1",
    fontFamily: "monospace",
    fontWeight: "600",
    textDecorationLine: "underline",
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
