import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Center, Loader, Alert, Text, Table, Box, Badge } from "@mantine/core";
import { fetchCheckpoints, subscribeToUpdates, type Checkpoint } from "../api";

const COL = { id: 130, branch: 140, intent: 300, sessions: 70, files: 70, tokens: 90 } as const;
const TOTAL_WIDTH = Object.values(COL).reduce((a, b) => a + b, 0) + 16;
const COLUMNS = [
  { label: "Checkpoint", width: COL.id },
  { label: "Branch",     width: COL.branch },
  { label: "Intent",     width: COL.intent },
  { label: "Sessions",   width: COL.sessions },
  { label: "Files",      width: COL.files },
  { label: "Out tokens", width: COL.tokens },
];

function CheckpointRow({ checkpoint, onPress }: { checkpoint: Checkpoint; onPress: () => void }) {
  const outTokens = checkpoint.tokenUsage?.outputTokens ?? 0;
  return (
    <Table.Tr onClick={onPress} style={{ cursor: "pointer" }}>
      <Table.Td style={{ width: COL.id }}>
        <Text ff="monospace" size="sm" c="teal" fw={600}>{checkpoint.checkpointId}</Text>
      </Table.Td>
      <Table.Td style={{ width: COL.branch }}>
        {checkpoint.branch
          ? <Badge variant="light" color="gray" size="sm">{checkpoint.branch}</Badge>
          : <Text size="sm" c="dimmed">—</Text>}
      </Table.Td>
      <Table.Td style={{ width: COL.intent, overflow: "hidden" }}>
        <Text size="sm" c="dimmed" fs="italic" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {checkpoint.summary?.intent ?? "—"}
        </Text>
      </Table.Td>
      <Table.Td style={{ width: COL.sessions, textAlign: "right" }}>
        <Text size="sm" c="dimmed">{checkpoint.sessionCount}</Text>
      </Table.Td>
      <Table.Td style={{ width: COL.files, textAlign: "right" }}>
        <Text size="sm" c="dimmed">{checkpoint.filesTouched.length}</Text>
      </Table.Td>
      <Table.Td style={{ width: COL.tokens, textAlign: "right" }}>
        <Text size="sm" c="dimmed" ff="monospace">{outTokens > 0 ? outTokens.toLocaleString() : "—"}</Text>
      </Table.Td>
    </Table.Tr>
  );
}

export function Checkpoints() {
  const navigate = useNavigate();
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setCheckpoints(await fetchCheckpoints());
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    load().finally(() => setLoading(false));
    return subscribeToUpdates(() => { load().catch(() => undefined); });
  }, [load]);

  if (loading) return <Center style={{ flex: 1 }}><Loader size="md" color="teal" /></Center>;
  if (error) return <Center style={{ flex: 1, padding: 24 }}><Alert color="red" title="Error" maw={480}>{error}</Alert></Center>;
  if (checkpoints.length === 0) return <Center style={{ flex: 1 }}><Text c="dimmed" size="sm">No checkpoints indexed yet.</Text></Center>;

  return (
    <Box style={{ flex: 1, overflow: "hidden" }}>
      <Table.ScrollContainer minWidth={TOTAL_WIDTH} h="100%">
        <Table stickyHeader highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              {COLUMNS.map(({ label, width }) => (
                <Table.Th key={label} style={{ width, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  {label}
                </Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {checkpoints.map((cp) => (
              <CheckpointRow
                key={cp.checkpointId}
                checkpoint={cp}
                onPress={() =>
                  navigate(`/checkpoints/${cp.checkpointId}`, {
                    state: { title: cp.branch ? `${cp.branch} · ${cp.checkpointId}` : cp.checkpointId },
                  })
                }
              />
            ))}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
    </Box>
  );
}
