import React from "react";
import { Table, Badge, Text, Anchor, Group } from "@mantine/core";
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
    <Table.Tr onClick={onPress} style={{ cursor: "pointer" }}>
      <Table.Td style={{ width: COL_WIDTHS.session }}>
        <Group gap={3} wrap="nowrap">
          {session.parentSessionId && <Text size="xs" c="blue" fw={700}>↳</Text>}
          <Text ff="monospace" size="sm" c="indigo" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {session.sessionId.slice(0, 8)}…
          </Text>
        </Group>
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
          <Text size="sm" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {session.gitUserName ?? "—"}
          </Text>
        )}
      </Table.Td>

      <Table.Td style={{ width: COL_WIDTHS.repo, overflow: "hidden" }}>
        <Text size="sm" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{repo}</Text>
      </Table.Td>

      <Table.Td style={{ width: COL_WIDTHS.summary, overflow: "hidden" }}>
        <Text size="sm" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary}</Text>
      </Table.Td>

      <Table.Td style={{ width: COL_WIDTHS.keywords, overflow: "hidden" }}>
        <Group gap={4} wrap="nowrap" style={{ overflow: "hidden" }}>
          {session.keywords.length > 0 ? (
            session.keywords.map((kw) => (
              <Badge key={kw} variant="light" color="violet" size="xs" radius="xl">{kw}</Badge>
            ))
          ) : (
            <Text size="sm" c="dimmed">—</Text>
          )}
        </Group>
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
