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
import { fetchSession, fetchSessionEvents, fetchSessionOverview, fetchSessionCheckpoints, type Session, type Event, type InteractionOverview, type SessionCheckpoint } from "../api";
import { EventItem } from "../components/EventItem";
import { ToolGroupItem, type ToolUseData } from "../components/ToolGroupItem";

type Props = StackScreenProps<RootStackParamList, "SessionDetail">;

// ─── Event grouping ───────────────────────────────────────────────────────────

type DisplayItem =
  | { kind: "event"; event: Event }
  | { kind: "toolGroup"; tools: ToolUseData[] }
  | { kind: "checkpoint"; checkpoint: SessionCheckpoint };

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

  // Pass 2: collapse consecutive toolUse + Notification items into toolGroup.
  // Notifications are absorbed silently (they're mostly "permission needed" noise).
  const isGroupable = (item: RawItem) =>
    item.kind === "toolUse" ||
    (item.kind === "event" && item.event.event === "Notification");

  const result: DisplayItem[] = [];
  let i = 0;
  while (i < raw.length) {
    if (isGroupable(raw[i])) {
      const group: ToolUseData[] = [];
      while (i < raw.length && isGroupable(raw[i])) {
        const item = raw[i];
        if (item.kind === "toolUse") {
          group.push({ pre: item.pre, post: item.post, failed: item.failed });
        }
        // Notifications are swallowed — don't add to group
        i++;
      }
      if (group.length > 0) {
        result.push({ kind: "toolGroup", tools: group });
      }
      // If the run was notifications-only, they're silently dropped
    } else {
      result.push({ kind: "event", event: (raw[i] as { kind: "event"; event: Event }).event });
      i++;
    }
  }

  return result;
}

// ─── Checkpoint row ───────────────────────────────────────────────────────────

function CheckpointRow({
  checkpoint,
  onPress,
}: {
  checkpoint: SessionCheckpoint;
  onPress: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const outTokens = checkpoint.tokenUsage?.output_tokens ?? 0;
  const fileCount = checkpoint.filesTouched.length;
  const s = checkpoint.summary;

  return (
    <View style={styles.cpWrapper}>
      <TouchableOpacity onPress={() => setExpanded((v) => !v)} style={styles.cpRow}>
        <View style={styles.cpBody}>
          <View style={styles.cpTop}>
            <Text style={styles.cpLabel}>Checkpoint</Text>
            <Text style={styles.cpId}>{checkpoint.checkpointId}</Text>
            {checkpoint.branch && (
              <Text style={styles.cpBranch}>{checkpoint.branch}</Text>
            )}
          </View>
          {s?.intent ? (
            <Text style={styles.cpIntent} numberOfLines={expanded ? undefined : 1}>
              {s.intent}
            </Text>
          ) : null}
        </View>
        <View style={styles.cpMeta}>
          {fileCount > 0 && (
            <Text style={styles.cpMetaText}>{fileCount} file{fileCount !== 1 ? "s" : ""}</Text>
          )}
          {outTokens > 0 && (
            <Text style={styles.cpMetaText}>{outTokens.toLocaleString()} tok</Text>
          )}
        </View>
      </TouchableOpacity>

      {expanded && (
        <View style={styles.cpDropdown}>
          {s?.outcome ? (
            <View style={styles.cpSection}>
              <Text style={styles.cpSectionLabel}>✓ Outcome</Text>
              <Text style={styles.cpSectionText} selectable>{s.outcome}</Text>
            </View>
          ) : null}
          {s?.learningsRepo && s.learningsRepo.length > 0 ? (
            <View style={styles.cpSection}>
              <Text style={styles.cpSectionLabel}>◎ Repo learnings</Text>
              {s.learningsRepo.map((item, i) => (
                <Text key={i} style={styles.cpBullet} selectable>· {item}</Text>
              ))}
            </View>
          ) : null}
          {s?.learningsCode && s.learningsCode.length > 0 ? (
            <View style={styles.cpSection}>
              <Text style={styles.cpSectionLabel}>{"</>"} Code learnings</Text>
              {s.learningsCode.map((item, i) => (
                <View key={i} style={styles.cpCodeLearning}>
                  <Text style={styles.cpCodePath}>{item.path}</Text>
                  <Text style={styles.cpBullet} selectable>{item.finding}</Text>
                </View>
              ))}
            </View>
          ) : null}
          {s?.learningsWorkflow && s.learningsWorkflow.length > 0 ? (
            <View style={styles.cpSection}>
              <Text style={styles.cpSectionLabel}>↺ Workflow learnings</Text>
              {s.learningsWorkflow.map((item, i) => (
                <Text key={i} style={styles.cpBullet} selectable>· {item}</Text>
              ))}
            </View>
          ) : null}
          {s?.friction && s.friction.length > 0 ? (
            <View style={styles.cpSection}>
              <Text style={styles.cpSectionLabel}>△ Friction</Text>
              {s.friction.map((item, i) => (
                <Text key={i} style={styles.cpBullet} selectable>· {item}</Text>
              ))}
            </View>
          ) : null}
          {s?.openItems && s.openItems.length > 0 ? (
            <View style={styles.cpSection}>
              <Text style={styles.cpSectionLabel}>◇ Open items</Text>
              {s.openItems.map((item, i) => (
                <Text key={i} style={styles.cpBullet} selectable>· {item}</Text>
              ))}
            </View>
          ) : null}
          {fileCount > 0 ? (
            <View style={styles.cpSection}>
              <Text style={styles.cpSectionLabel}>Files touched</Text>
              {checkpoint.filesTouched.map((f, i) => (
                <Text key={i} style={styles.cpFilePath}>{f}</Text>
              ))}
            </View>
          ) : null}
          <TouchableOpacity onPress={onPress} style={styles.cpOpenBtn}>
            <Text style={styles.cpOpenBtnText}>Open checkpoint →</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// ─── Screen ───────────────────────────────────────────────────────────────────

export function SessionDetail({ route, navigation }: Props) {
  const { sessionId } = route.params;
  const [session, setSession] = useState<Session | null>(null);
  const [overview, setOverview] = useState<InteractionOverview | null>(null);
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { height } = useWindowDimensions();
  const headerHeight = useHeaderHeight();
  const contentHeight = height - headerHeight;

  useEffect(() => {
    Promise.all([
      fetchSession(sessionId),
      fetchSessionEvents(sessionId),
      fetchSessionOverview(sessionId),
      fetchSessionCheckpoints(sessionId),
    ])
      .then(([s, evs, ov, checkpoints]) => {
        setSession(s);
        setOverview(ov);

        // Merge events and checkpoints in chronological order
        const grouped = groupEvents(evs);
        const merged: DisplayItem[] = [];
        let cpIdx = 0;
        const sortedCps = [...checkpoints].sort((a, b) => {
          const ta = a.createdAt ?? a.indexedAt;
          const tb = b.createdAt ?? b.indexedAt;
          return ta < tb ? -1 : ta > tb ? 1 : 0;
        });

        for (const item of grouped) {
          const itemTime =
            item.kind === "event"
              ? item.event.timestamp
              : item.kind === "toolGroup"
              ? item.tools[0]?.pre.timestamp ?? ""
              : "";
          // Insert any checkpoints whose createdAt falls before this item
          while (cpIdx < sortedCps.length) {
            const cp = sortedCps[cpIdx];
            const cpTime = cp.createdAt ?? cp.indexedAt;
            if (cpTime <= itemTime) {
              merged.push({ kind: "checkpoint", checkpoint: cp });
              cpIdx++;
            } else {
              break;
            }
          }
          merged.push(item);
        }
        // Append any remaining checkpoints
        while (cpIdx < sortedCps.length) {
          merged.push({ kind: "checkpoint", checkpoint: sortedCps[cpIdx++] });
        }

        setItems(merged);
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

      {overview && (
        <View style={styles.overviewCard}>
          <Text style={styles.overviewLabel}>Overview</Text>
          <Text style={styles.overviewSummary}>{overview.summary}</Text>
          {overview.keywords.length > 0 && (
            <View style={styles.overviewKeywords}>
              {overview.keywords.map((kw) => (
                <View key={kw} style={styles.keyword}>
                  <Text style={styles.keywordText}>{kw}</Text>
                </View>
              ))}
            </View>
          )}
          <Text style={styles.overviewTime}>
            {new Date(overview.startedAt).toLocaleString()} → {new Date(overview.endedAt).toLocaleString()}
          </Text>
        </View>
      )}

      {items.length === 0 ? (
        <View style={styles.centered}>
          <Text style={styles.emptyText}>No events for this session.</Text>
        </View>
      ) : (
        items.map((item, idx) =>
          item.kind === "toolGroup" ? (
            <ToolGroupItem key={`grp-${idx}`} tools={item.tools} />
          ) : item.kind === "checkpoint" ? (
            <CheckpointRow
              key={`cp-${item.checkpoint.checkpointId}`}
              checkpoint={item.checkpoint}
              onPress={() =>
                navigation.navigate("CheckpointDetail", {
                  checkpointId: item.checkpoint.checkpointId,
                  title: item.checkpoint.branch
                    ? `${item.checkpoint.branch} · ${item.checkpoint.checkpointId}`
                    : item.checkpoint.checkpointId,
                })
              }
            />
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
  overviewCard: {
    backgroundColor: "#fafaf9",
    borderBottomWidth: 1,
    borderBottomColor: "#e7e5e4",
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 6,
  },
  overviewLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#78716c",
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  overviewSummary: {
    fontSize: 13,
    color: "#292524",
    lineHeight: 20,
  },
  overviewKeywords: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 5,
  },
  keyword: {
    backgroundColor: "#e7e5e4",
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  keywordText: {
    fontSize: 11,
    color: "#57534e",
    fontFamily: "monospace",
  },
  overviewTime: {
    fontSize: 10,
    color: "#a8a29e",
  },
  cpWrapper: {
    borderLeftWidth: 4,
    borderLeftColor: "#059669",
  },
  cpRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "#f0fdf4",
  },
  cpLabel: {
    fontSize: 12,
    fontWeight: "700",
    color: "#059669",
    textTransform: "uppercase",
  },
  cpBody: {
    flex: 1,
    gap: 2,
  },
  cpTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  cpId: {
    fontFamily: "monospace",
    fontSize: 12,
    color: "#065f46",
    fontWeight: "600",
  },
  cpBranch: {
    fontSize: 11,
    color: "#059669",
    backgroundColor: "#d1fae5",
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
  },
  cpIntent: {
    fontSize: 11,
    color: "#6b7280",
    fontStyle: "italic",
  },
  cpMeta: {
    alignItems: "flex-end",
    gap: 2,
  },
  cpMetaText: {
    fontSize: 10,
    color: "#6b7280",
    fontFamily: "monospace",
  },
  cpDropdown: {
    backgroundColor: "#f8fffe",
    borderTopWidth: 1,
    borderTopColor: "#d1fae5",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
  },
  cpSection: {
    gap: 3,
  },
  cpSectionLabel: {
    fontSize: 10,
    fontWeight: "700",
    color: "#6b7280",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  cpSectionText: {
    fontSize: 12,
    color: "#374151",
    lineHeight: 18,
  },
  cpBullet: {
    fontSize: 12,
    color: "#374151",
    lineHeight: 18,
    paddingLeft: 4,
  },
  cpCodeLearning: {
    paddingLeft: 4,
    gap: 1,
    marginBottom: 2,
  },
  cpCodePath: {
    fontFamily: "monospace",
    fontSize: 11,
    color: "#4338ca",
    fontWeight: "600",
  },
  cpFilePath: {
    fontFamily: "monospace",
    fontSize: 11,
    color: "#6b7280",
    paddingLeft: 4,
  },
  cpOpenBtn: {
    alignSelf: "flex-start",
    marginTop: 4,
    paddingVertical: 5,
    paddingHorizontal: 10,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: "#bbf7d0",
  },
  cpOpenBtnText: {
    fontSize: 11,
    color: "#059669",
    fontFamily: "monospace",
  },
});
