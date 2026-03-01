import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  useWindowDimensions,
} from "react-native";
import { useHeaderHeight } from "@react-navigation/elements";
import type { StackScreenProps } from "@react-navigation/stack";
import type { RootStackParamList } from "../../App";
import { fetchSession, fetchSessionEvents, type Session, type Event } from "../api";
import { EventItem } from "../components/EventItem";
import { ToolGroupItem, type ToolUseData } from "../components/ToolGroupItem";

type Props = StackScreenProps<RootStackParamList, "SessionDetail">;

// ─── Event grouping ───────────────────────────────────────────────────────────

type DisplayItem =
  | { kind: "event"; event: Event }
  | { kind: "toolGroup"; tools: ToolUseData[] };

function groupEvents(events: Event[]): DisplayItem[] {
  // Pass 1: pair PreToolUse with its matching PostToolUse
  const postMap = new Map<string, Event>();
  for (const event of events) {
    if (event.event === "PostToolUse" || event.event === "PostToolUseFailure") {
      const d = event.data as Record<string, unknown>;
      const id = typeof d.tool_use_id === "string" ? d.tool_use_id : null;
      if (id) postMap.set(id, event);
    }
  }

  type RawItem =
    | { kind: "event"; event: Event }
    | { kind: "toolUse"; pre: Event; post?: Event; failed: boolean };

  const raw: RawItem[] = [];
  const consumed = new Set<number>();

  for (const event of events) {
    if (
      (event.event === "PostToolUse" || event.event === "PostToolUseFailure") &&
      consumed.has(event.id)
    ) {
      continue;
    }
    if (event.event === "PreToolUse") {
      const d = event.data as Record<string, unknown>;
      const toolUseId = typeof d.tool_use_id === "string" ? d.tool_use_id : null;
      const post = toolUseId ? postMap.get(toolUseId) : undefined;
      if (post) consumed.add(post.id);
      raw.push({ kind: "toolUse", pre: event, post, failed: post?.event === "PostToolUseFailure" });
      continue;
    }
    raw.push({ kind: "event", event });
  }

  // Pass 2: collapse consecutive toolUse items into toolGroup
  const result: DisplayItem[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i].kind === "toolUse") {
      const group: ToolUseData[] = [];
      while (i < raw.length && raw[i].kind === "toolUse") {
        const t = raw[i] as { kind: "toolUse"; pre: Event; post?: Event; failed: boolean };
        group.push({ pre: t.pre, post: t.post, failed: t.failed });
        i++;
      }
      result.push({ kind: "toolGroup", tools: group });
    } else {
      result.push({ kind: "event", event: (raw[i] as { kind: "event"; event: Event }).event });
      i++;
    }
  }

  return result;
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export function SessionDetail({ route, navigation }: Props) {
  const { sessionId } = route.params;
  const [session, setSession] = useState<Session | null>(null);
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { height } = useWindowDimensions();
  const headerHeight = useHeaderHeight();
  const contentHeight = height - headerHeight;

  useEffect(() => {
    Promise.all([fetchSession(sessionId), fetchSessionEvents(sessionId)])
      .then(([s, evs]) => {
        setSession(s);
        setItems(groupEvents(evs));
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
    <View style={[styles.scroll, { height: contentHeight }]}>
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

      {session?.childSessionIds?.map((childId) => (
        <TouchableOpacity
          key={childId}
          style={styles.childBanner}
          onPress={() =>
            navigation.push("SessionDetail", {
              sessionId: childId,
              title: childId.slice(0, 8) + "…",
            })
          }
        >
          <Text style={styles.childLabel}>↓ Continued as</Text>
          <Text style={styles.childId}>{childId.slice(0, 8)}…</Text>
        </TouchableOpacity>
      ))}

      {items.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyText}>No events for this session.</Text>
        </View>
      ) : (
        items.map((item, idx) =>
          item.kind === "toolGroup" ? (
            <ToolGroupItem key={`grp-${idx}`} tools={item.tools} />
          ) : (
            <EventItem key={`evt-${item.event.id}`} event={item.event} />
          )
        )
      )}
    </View>
  );
}

const styles = StyleSheet.create({
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
  childBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#f0fdf4",
    borderBottomWidth: 1,
    borderBottomColor: "#bbf7d0",
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  childLabel: {
    fontSize: 12,
    color: "#15803d",
  },
  childId: {
    fontSize: 12,
    color: "#15803d",
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
