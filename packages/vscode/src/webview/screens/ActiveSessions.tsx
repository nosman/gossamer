import React, { useEffect, useState, useCallback } from "react";
import {
  Center, Loader, Alert, Text, Table, Box, Group, Button, Switch, Tooltip,
} from "@mantine/core";
import {
  fetchSessions, subscribeToUpdates, archiveSession, unarchiveSession, syncSessions,
  type Session,
} from "../api";
import { SessionRow, COL_WIDTHS } from "../components/SessionRow";
import { postToExtension } from "../vscodeApi";

const SESSION_COLUMNS: { label: string; width: number }[] = [
  { label: "Name",       width: COL_WIDTHS.sessionId       },
  { label: "Branch",     width: COL_WIDTHS.branch          },
  { label: "Repo",       width: COL_WIDTHS.repo            },
  { label: "Updated",    width: COL_WIDTHS.updated         },
  { label: "User",       width: COL_WIDTHS.user            },
  { label: "Intent",     width: COL_WIDTHS.intent          },
  { label: "Parent",     width: COL_WIDTHS.parentSessionId },
  { label: "Started",    width: COL_WIDTHS.started         },
  { label: "",           width: COL_WIDTHS.actions         },
];

const SESSION_TOTAL_WIDTH = Object.values(COL_WIDTHS).reduce((a, b) => a + b, 0) + 16;

type StartupState = "starting" | "ready" | "error";

interface ActiveSessionsProps {
  onSessionPress: (sessionId: string, title: string) => void;
}

interface StartupErrorPayload {
  message: string;
  stderrTail: string;
  logPath: string | null;
  logExists: boolean;
  exit: { code: number | null; signal: string | null } | null;
}

export function ActiveSessions({ onSessionPress }: ActiveSessionsProps) {
  const [startup, setStartup]       = useState<StartupState>("starting");
  const [startupError, setStartupError] = useState<StartupErrorPayload | null>(null);
  const [sessions, setSessions]     = useState<Session[]>([]);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [syncing, setSyncing]       = useState(false);
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());

  // Wait for the extension host to confirm the server is ready
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as {
        type: string;
        error?: string;
        stderrTail?: string;
        logPath?: string;
        logExists?: boolean;
        exit?: { code: number | null; signal: string | null } | null;
      };
      if (msg.type === "server_starting") { setStartupError(null); setStartup("starting"); setLoading(true); }
      if (msg.type === "server_ready") { setStartupError(null); setStartup("ready"); }
      if (msg.type === "server_error") {
        setStartupError({
          message:    msg.error ?? "Unknown error",
          stderrTail: msg.stderrTail ?? "",
          logPath:    msg.logPath ?? null,
          logExists:  msg.logExists ?? false,
          exit:       msg.exit ?? null,
        });
        setStartup("error");
      }
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
    const exitBlurb = startupError?.exit
      ? ` (exit code ${startupError.exit.code ?? "null"}${startupError.exit.signal ? `, signal ${startupError.exit.signal}` : ""})`
      : "";
    return (
      <Center style={{ flex: 1, padding: 24 }}>
        <Box maw={640} w="100%">
          <Alert color="red" title="Gossamer server failed to start" mb={16}>
            <Text size="sm" mb={8}>{startupError?.message ?? "Unknown error"}{exitBlurb}</Text>
            {startupError?.stderrTail ? (
              <Box
                component="pre"
                style={{
                  margin: 0,
                  padding: 10,
                  maxHeight: 240,
                  overflow: "auto",
                  fontFamily: "var(--vscode-editor-font-family, monospace)",
                  fontSize: 11,
                  lineHeight: 1.5,
                  background: "var(--vscode-textCodeBlock-background)",
                  border: "1px solid var(--vscode-panel-border)",
                  borderRadius: 4,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {startupError.stderrTail}
              </Box>
            ) : (
              <Text size="xs" c="dimmed" fs="italic">No output captured from server.</Text>
            )}
          </Alert>
          <Group gap={8}>
            <Button
              size="xs"
              onClick={() => postToExtension({ type: "restart_server" })}
            >
              Restart server
            </Button>
            {startupError?.logExists && (
              <Button
                size="xs"
                variant="default"
                onClick={() => postToExtension({ type: "open_log_file" })}
              >
                Open log file
              </Button>
            )}
          </Group>
          {startupError?.logPath && (
            <Text size="xs" c="dimmed" mt={8} ff="monospace">
              Log: {startupError.logPath}
            </Text>
          )}
        </Box>
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
          borderBottom: "1px solid var(--vscode-panel-border)",
          flexShrink: 0,
        }}
      >
        <Switch
          size="xs"
          label="Archived"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.currentTarget.checked)}
        />
        <Group gap={8}>
          <Button size="xs" variant="filled" onClick={() => postToExtension({ type: "new_session" })}>
            + New Session
          </Button>
          <Tooltip label="Search sessions" withArrow>
            <Button size="xs" variant="default" onClick={() => postToExtension({ type: "search_sessions" })}>
              🔍
            </Button>
          </Tooltip>
          <Tooltip label="Re-index sessions from git" withArrow>
            <Button size="xs" variant="default" loading={syncing} onClick={handleSync}>
              Sync
            </Button>
          </Tooltip>
        </Group>
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
                    onPress={() => onSessionPress(item.sessionId, item.intent ?? item.summary ?? item.customTitle ?? item.slug ?? `${item.sessionId.slice(0, 8)}…`)}
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
