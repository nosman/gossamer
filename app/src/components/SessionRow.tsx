import React from "react";
import { TouchableOpacity, View, Text, StyleSheet, Linking, Pressable } from "react-native";
import type { Session } from "../api";

interface Props {
  session: Session;
  onPress: () => void;
}

// Exported so ActiveSessions header can use the same widths
export const COL_WIDTHS = {
  session:  100,
  user:     150,
  repo:     120,
  summary:  280,
  keywords: 220,
  started:  110,
  updated:  110,
} as const;

function fmt(iso: string): string {
  const d = new Date(iso);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(2);
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${dd}/${mm}/${yy} ${hh}:${min}`;
}

export function SessionRow({ session, onPress }: Props) {
  const repo = session.repoName ?? session.cwd.split("/").pop() ?? session.cwd;
  const summary = session.summary ?? session.prompt?.slice(0, 120) ?? "—";

  return (
    <TouchableOpacity onPress={onPress} style={styles.row}>
      {/* Session ID */}
      <Text style={[styles.cell, styles.idCell, { width: COL_WIDTHS.session }]} numberOfLines={1}>
        {session.sessionId.slice(0, 8)}…
      </Text>

      {/* User — name only, mailto link if email available */}
      <View style={[styles.cell, { width: COL_WIDTHS.user }]}>
        {session.gitUserEmail ? (
          <Pressable onPress={() => Linking.openURL(`mailto:${session.gitUserEmail}`)}>
            <Text style={styles.userLink} numberOfLines={1}>
              {session.gitUserName ?? session.gitUserEmail}
            </Text>
          </Pressable>
        ) : (
          <Text style={styles.cellText} numberOfLines={1}>
            {session.gitUserName ?? "—"}
          </Text>
        )}
      </View>

      {/* Repo */}
      <Text style={[styles.cell, styles.cellText, { width: COL_WIDTHS.repo }]} numberOfLines={1}>
        {repo}
      </Text>

      {/* Summary */}
      <Text style={[styles.cell, styles.cellText, { width: COL_WIDTHS.summary }]} numberOfLines={1}>
        {summary}
      </Text>

      {/* Keywords — chips */}
      <View style={[styles.cell, styles.keywordsCell, { width: COL_WIDTHS.keywords }]}>
        {session.keywords.length > 0 ? (
          session.keywords.map((kw) => (
            <View key={kw} style={styles.chip}>
              <Text style={styles.chipText} numberOfLines={1}>{kw}</Text>
            </View>
          ))
        ) : (
          <Text style={styles.cellText}>—</Text>
        )}
      </View>

      {/* Started */}
      <Text style={[styles.cell, styles.cellText, { width: COL_WIDTHS.started }]} numberOfLines={1}>
        {fmt(session.startedAt)}
      </Text>

      {/* Updated */}
      <Text style={[styles.cell, styles.cellText, { width: COL_WIDTHS.updated }]} numberOfLines={1}>
        {fmt(session.updatedAt)}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
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
  cellText: {
    fontSize: 13,
    color: "#374151",
  },
  idCell: {
    fontFamily: "monospace",
    fontSize: 13,
    color: "#6366f1",
  },
  userLink: {
    fontSize: 13,
    color: "#2563eb",
    textDecorationLine: "underline",
  },
  keywordsCell: {
    flexDirection: "row",
    flexWrap: "nowrap",
    alignItems: "center",
    gap: 4,
  },
  chip: {
    backgroundColor: "#ede9fe",
    borderRadius: 10,
    paddingHorizontal: 7,
    paddingVertical: 2,
    flexShrink: 0,
  },
  chipText: {
    fontSize: 11,
    color: "#5b21b6",
    fontWeight: "500",
  },
});
