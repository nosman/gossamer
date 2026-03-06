import React from "react";
import { TouchableOpacity, View, StyleSheet, Linking } from "../primitives";
import type { Session } from "../api";

interface Props {
  session: Session;
  onPress: () => void;
}

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
  return (
    String(d.getDate()).padStart(2, "0") + "/" +
    String(d.getMonth() + 1).padStart(2, "0") + "/" +
    String(d.getFullYear()).slice(2) + " " +
    String(d.getHours()).padStart(2, "0") + ":" +
    String(d.getMinutes()).padStart(2, "0")
  );
}

export function SessionRow({ session, onPress }: Props) {
  const repo = session.repoName ?? session.cwd.split("/").pop() ?? session.cwd;
  const summary = session.summary ?? session.prompt?.slice(0, 120) ?? "—";

  return (
    <TouchableOpacity onPress={onPress} style={styles.row}>
      <View style={{ ...styles.cell, ...styles.idCellWrap, width: COL_WIDTHS.session } as React.CSSProperties}>
        {session.parentSessionId && <span style={styles.continuationMark}>↳</span>}
        <span style={{ ...styles.idCell, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as React.CSSProperties}>
          {session.sessionId.slice(0, 8)}…
        </span>
      </View>

      <div style={{ ...styles.cell, width: COL_WIDTHS.user, overflow: "hidden" } as React.CSSProperties}>
        {session.gitUserEmail ? (
          <span
            role="link"
            onClick={(e) => { e.stopPropagation(); Linking.openURL(`mailto:${session.gitUserEmail}`); }}
            style={{ ...styles.userLink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" } as React.CSSProperties}
          >
            {session.gitUserName ?? session.gitUserEmail}
          </span>
        ) : (
          <span style={{ ...styles.cellText, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" } as React.CSSProperties}>
            {session.gitUserName ?? "—"}
          </span>
        )}
      </div>

      <span style={{ ...styles.cell, ...styles.cellText, width: COL_WIDTHS.repo, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as React.CSSProperties}>
        {repo}
      </span>

      <span style={{ ...styles.cell, ...styles.cellText, width: COL_WIDTHS.summary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as React.CSSProperties}>
        {summary}
      </span>

      <View style={{ ...styles.cell, ...styles.keywordsCell, width: COL_WIDTHS.keywords } as React.CSSProperties}>
        {session.keywords.length > 0 ? (
          session.keywords.map((kw) => (
            <span key={kw} style={styles.chip}>{kw}</span>
          ))
        ) : (
          <span style={styles.cellText}>—</span>
        )}
      </View>

      <span style={{ ...styles.cell, ...styles.cellText, width: COL_WIDTHS.started } as React.CSSProperties}>
        {fmt(session.startedAt)}
      </span>

      <span style={{ ...styles.cell, ...styles.cellText, width: COL_WIDTHS.updated } as React.CSSProperties}>
        {fmt(session.updatedAt)}
      </span>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  row: { display: "flex", flexDirection: "row", alignItems: "center", padding: "8px", borderBottom: "1px solid #e5e7eb", cursor: "pointer" } as React.CSSProperties,
  cell: { padding: "0 4px", overflow: "hidden", flexShrink: 0 } as React.CSSProperties,
  cellText: { fontSize: 13, color: "#374151" } as React.CSSProperties,
  idCellWrap: { display: "flex", flexDirection: "row", alignItems: "center", gap: 3 } as React.CSSProperties,
  idCell: { fontFamily: "monospace", fontSize: 13, color: "#6366f1" } as React.CSSProperties,
  continuationMark: { fontSize: 11, color: "#0369a1", fontWeight: 700 } as React.CSSProperties,
  userLink: { fontSize: 13, color: "#2563eb", textDecoration: "underline", cursor: "pointer" } as React.CSSProperties,
  keywordsCell: { display: "flex", flexDirection: "row", flexWrap: "nowrap", alignItems: "center", gap: 4, overflow: "hidden" } as React.CSSProperties,
  chip: { backgroundColor: "#ede9fe", borderRadius: 10, padding: "2px 7px", fontSize: 11, color: "#5b21b6", fontWeight: 500, flexShrink: 0 } as React.CSSProperties,
});
