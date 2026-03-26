import React, { useEffect, useState, useCallback } from "react";
import {
  Center, Loader, Alert, Text, Table, Box, Group, Button, Switch, Tooltip,
} from "@mantine/core";
import {
  fetchSessions, subscribeToUpdates, archiveSession, unarchiveSession, syncSessions,
  type Session,
} from "../api";
import { SessionRow, COL_WIDTHS } from "../components/SessionRow";

const SESSION_COLUMNS: { label: string; width: number }[] = [
  { label: "Intent",     width: COL_WIDTHS.intent          },
  { label: "Session ID", width: COL_WIDTHS.sessionId       },
  { label: "Updated",    width: COL_WIDTHS.updated         },
  { label: "Branch",     width: COL_WIDTHS.branch          },
  { label: "Repo",       width: COL_WIDTHS.repo            },
  { label: "Parent",     width: COL_WIDTHS.parentSessionId },
  { label: "User",       width: COL_WIDTHS.user            },
  { label: "Started",    width: COL_WIDTHS.started         },
  { label: "",           width: COL_WIDTHS.actions         },
];

const SESSION_TOTAL_WIDTH = Object.values(COL_WIDTHS).reduce((a, b) => a + b, 0) + 16;

type StartupState = "starting" | "ready" | "error";

export function ActiveSessions() {
  const [startup, setStartup]       = useState<StartupState>("starting");
  const [startupError, setStartupError] = useState<string | null>(null);
  const [sessions, setSessions]     = useState<Session[]>([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [syncing, setSyncing]       = useState(false);
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());

  // Wait for the extension host to confirm the server is ready
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as { type: string; error?: string };
      if (msg.type === "server_ready") setStartup("ready");
      if (msg.type === "server_error") { setStartupError(msg.error ?? "Unknown error"); setStartup("error"); }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const load = useCallback(async (archived = false) => {
    try {
      const [data, archivedData] = await Promise.all([
        fetchSessions(false),
        fetchSessions(true),
      ]);
      setSessions(archived ? archivedData : data);
      setArchivedIds(new Set(archivedData.map((s) => s.sessionId)));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  // Fetch + subscribe only after server is ready
  useEffect(() => {
    if (startup !== "ready") return;
    load(showArchived).finally(() => setLoading(false));
    return subscribeToUpdates(() => { load(showArchived).catch(() => undefined); });
  }, [startup, load, showArchived]);

  async function handleArchive(sessionId: string) {
    const isCurrentlyArchived = archivedIds.has(sessionId);
    try {
      if (isCurrentlyArchived) await unarchiveSession(sessionId);
      else await archiveSession(sessionId);
      await load(showArchived);
    } catch { /* ignore */ }
  }

  async function handleSync() {
    setSyncing(true);
    try {
      await syncSessions();
      await load(showArchived);
    } catch { /* ignore */ } finally {
      setSyncing(false);
    }
  }

  if (startup === "starting") {
    return (
      <Center style={{ flex: 1, flexDirection: "column", gap: 12 }}>
        <Loader size="md" color="indigo" />
        <Text size="sm" c="dimmed">Starting Gossamer server…</Text>
      </Center>
    );
  }

  if (startup === "error") {
    return (
      <Center style={{ flex: 1, padding: 24 }}>
        <Alert color="red" title="Server failed to start" maw={480}>
          <Text size="xs" c="dimmed">{startupError}</Text>
        </Alert>
      </Center>
    );
  }

  if (loading) {
    return <Center style={{ flex: 1 }}><Loader size="md" color="indigo" /></Center>;
  }

  if (error) {
    return (
      <Center style={{ flex: 1, padding: 24 }}>
        <Alert color="red" title="Error loading sessions" maw={480}>
          <Text size="xs" c="dimmed">{error}</Text>
        </Alert>
      </Center>
    );
  }

  return (
    <Box style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <Group
        px={12}
        py={8}
        justify="space-between"
        style={{
          borderBottom: "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
          flexShrink: 0,
        }}
      >
        <Switch
          size="xs"
          label="Archived"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.currentTarget.checked)}
        />
        <Tooltip label="Re-index sessions from git" withArrow>
          <Button size="xs" variant="default" loading={syncing} onClick={handleSync}>
            Sync
          </Button>
        </Tooltip>
      </Group>

      {sessions.length === 0 ? (
        <Center style={{ flex: 1 }}>
          <Text c="dimmed" size="sm">No sessions yet.</Text>
        </Center>
      ) : (
        <Box style={{ flex: 1, overflow: "hidden" }}>
          <Table.ScrollContainer minWidth={SESSION_TOTAL_WIDTH} h="100%">
            <Table stickyHeader highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  {SESSION_COLUMNS.map(({ label, width }) => (
                    <Table.Th
                      key={label}
                      style={{ width, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }}
                    >
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
                    onPress={() => { /* TODO: open session detail */ }}
                    onArchive={handleArchive}
                    isArchived={archivedIds.has(item.sessionId)}
                  />
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Box>
      )}
    </Box>
  );
}
