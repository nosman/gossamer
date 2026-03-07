import React, { useEffect, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Center, Loader, Alert, Text, Table, Box } from "@mantine/core";
import { fetchSessions, subscribeToUpdates, type Session } from "../api";
import { SessionRow, COL_WIDTHS } from "../components/SessionRow";

const COLUMNS: { label: string; width: number }[] = [
  { label: "Session ID",  width: COL_WIDTHS.sessionId      },
  { label: "User",        width: COL_WIDTHS.user            },
  { label: "Branch",      width: COL_WIDTHS.branch          },
  { label: "Summary",     width: COL_WIDTHS.summary         },
  { label: "Parent",      width: COL_WIDTHS.parentSessionId },
  { label: "Started",     width: COL_WIDTHS.started         },
  { label: "Updated",     width: COL_WIDTHS.updated         },
];

const TOTAL_WIDTH = Object.values(COL_WIDTHS).reduce((a, b) => a + b, 0) + 16;

export function ActiveSessions() {
  const navigate = useNavigate();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSessions(await fetchSessions());
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    load().finally(() => setLoading(false));
    return subscribeToUpdates(() => { load().catch(() => undefined); });
  }, [load]);

  if (loading) {
    return <Center style={{ flex: 1 }}><Loader size="md" color="indigo" /></Center>;
  }

  if (error) {
    return (
      <Center style={{ flex: 1, padding: 24 }}>
        <Alert color="red" title="Cannot reach API server" maw={480}>
          <Text size="sm" mb={4}>
            Start the server with:{" "}
            <Text component="span" ff="monospace" size="sm">claude-hook-handler serve</Text>
          </Text>
          <Text size="xs" c="dimmed">{error}</Text>
        </Alert>
      </Center>
    );
  }

  if (sessions.length === 0) {
    return <Center style={{ flex: 1 }}><Text c="dimmed" size="sm">No sessions yet.</Text></Center>;
  }

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
            {sessions.map((item) => (
              <SessionRow
                key={item.sessionId}
                session={item}
                onPress={() =>
                  navigate(`/sessions/${item.sessionId}`, {
                    state: { title: item.summary ?? item.sessionId.slice(0, 8) + "…" },
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
