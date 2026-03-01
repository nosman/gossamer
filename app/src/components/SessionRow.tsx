import React from "react";
import { TouchableOpacity, View, Text, StyleSheet } from "react-native";
import type { Session } from "../api";

interface Props {
  session: Session;
  onPress: () => void;
}

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
  const user =
    session.gitUserName && session.gitUserEmail
      ? `${session.gitUserName} <${session.gitUserEmail}>`
      : session.gitUserName ?? session.gitUserEmail ?? "—";
  const repo = session.repoName ?? session.cwd.split("/").pop() ?? session.cwd;
  const summary = session.summary ?? session.prompt?.slice(0, 80) ?? "—";
  const keywords = session.keywords.join(", ") || "—";

  return (
    <TouchableOpacity onPress={onPress} style={styles.row}>
      <Text style={[styles.cell, styles.idCell]} numberOfLines={1}>
        {session.sessionId.slice(0, 8)}…
      </Text>
      <Text style={styles.cell} numberOfLines={1}>{user}</Text>
      <Text style={styles.cell} numberOfLines={1}>{repo}</Text>
      <Text style={[styles.cell, styles.summaryCell]} numberOfLines={1}>{summary}</Text>
      <Text style={styles.cell} numberOfLines={1}>{keywords}</Text>
      <Text style={styles.cell} numberOfLines={1}>{fmt(session.startedAt)}</Text>
      <Text style={styles.cell} numberOfLines={1}>{fmt(session.updatedAt)}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: "#e5e7eb",
  },
  cell: {
    flex: 1,
    fontSize: 13,
    color: "#374151",
    paddingHorizontal: 4,
  },
  idCell: {
    fontFamily: "monospace",
    color: "#6366f1",
  },
  summaryCell: {
    flex: 2,
  },
});
