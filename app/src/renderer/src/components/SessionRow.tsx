import React from "react";
import { Table, Text, Anchor } from "@mantine/core";
import type { Session } from "../api";

interface Props {
  session: Session;
  onPress: () => void;
}

export const COL_WIDTHS = {
  sessionId:      140,
  user:           160,
  branch:         120,
  summary:        340,
  parentSessionId: 120,
  started:        110,
  updated:        110,
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
  const summary = session.summary ?? session.prompt?.slice(0, 160) ?? "—";

  return (
    <Table.Tr onClick={onPress} style={{ cursor: "pointer" }}>
      <Table.Td style={{ width: COL_WIDTHS.sessionId }}>
        <Text ff="monospace" size="sm" c="indigo" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {session.sessionId}
        </Text>
      </Table.Td>

      <Table.Td style={{ width: COL_WIDTHS.user, overflow: "hidden" }}>
        {session.gitUserEmail ? (
          <Anchor
            size="sm"
            href={`mailto:${session.gitUserEmail}`}
            onClick={(e) => e.stopPropagation()}
            style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}
          >
            {session.gitUserName ?? session.gitUserEmail}
          </Anchor>
        ) : (
          <Text size="sm" c={session.gitUserName ? undefined : "dimmed"} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {session.gitUserName ?? "—"}
          </Text>
        )}
      </Table.Td>

      <Table.Td style={{ width: COL_WIDTHS.branch, overflow: "hidden" }}>
        <Text size="sm" ff="monospace" c={session.branch ? "teal" : "dimmed"} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {session.branch ?? "—"}
        </Text>
      </Table.Td>

      <Table.Td style={{ width: COL_WIDTHS.summary, overflow: "hidden" }}>
        <Text size="sm" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary}</Text>
      </Table.Td>

      <Table.Td style={{ width: COL_WIDTHS.parentSessionId }}>
        {session.parentSessionId ? (
          <Text ff="monospace" size="sm" c="blue" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {session.parentSessionId}
          </Text>
        ) : (
          <Text size="sm" c="dimmed">—</Text>
        )}
      </Table.Td>

      <Table.Td style={{ width: COL_WIDTHS.started }}>
        <Text size="sm">{fmt(session.startedAt)}</Text>
      </Table.Td>

      <Table.Td style={{ width: COL_WIDTHS.updated }}>
        <Text size="sm">{fmt(session.updatedAt)}</Text>
      </Table.Td>
    </Table.Tr>
  );
}
