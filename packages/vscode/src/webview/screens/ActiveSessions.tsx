import React, { useEffect, useState, useCallback, useMemo } from "react";
import {
  Center, Loader, Alert, Text, Table, Box, Group, Button, Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  fetchSessions, subscribeToUpdates, archiveSession, unarchiveSession, syncSessions, repoPath,
  type Session,
} from "../api";
import { SessionRow, COL_WIDTHS } from "../components/SessionRow";
import { postToExtension } from "../vscodeApi";

// "default" preserves the order the server returned (workspace tier,
// then same-repo, then everything else, by updatedAt desc within each tier).
type SortKey = "default" | "updated" | "user" | "branch";
type SortDir = "asc" | "desc";

const SESSION_COLUMNS: { label: string; width: number; sortKey?: SortKey }[] = [
  { label: "Name",       width: COL_WIDTHS.sessionId                    },
  { label: "Branch",     width: COL_WIDTHS.branch,     sortKey: "branch"  },
  { label: "Updated",    width: COL_WIDTHS.updated,    sortKey: "updated" },
  { label: "User",       width: COL_WIDTHS.user,       sortKey: "user"    },
  { label: "Intent",     width: COL_WIDTHS.intent                       },
  { label: "Parent",     width: COL_WIDTHS.parentSessionId              },
  { label: "Started",    width: COL_WIDTHS.started                      },
  { label: "",           width: COL_WIDTHS.actions                      },
];

function sortSessions(sessions: Session[], key: SortKey, dir: SortDir): Session[] {
  if (key === "default") return sessions;
  const sorted = [...sessions].sort((a, b) => {
    let av = "", bv = "";
    if (key === "updated") { av = a.updatedAt; bv = b.updatedAt; }
    else if (key === "user")  { av = a.gitUserName ?? a.gitUserEmail ?? ""; bv = b.gitUserName ?? b.gitUserEmail ?? ""; }
    else if (key === "branch"){ av = a.branch ?? ""; bv = b.branch ?? ""; }
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
  return dir === "desc" ? sorted.reverse() : sorted;
}

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
  const [syncing, setSyncing]       = useState(false);
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey]       = useState<SortKey>("default");
  const [sortDir, setSortDir]       = useState<SortDir>("desc");

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

  const load = useCallback(async () => {
    try {
      const [data, archivedData] = await Promise.all([
        fetchSessions(false),
        fetchSessions(true),
      ]);
      setSessions(data);
      setArchivedIds(new Set(archivedData.map((s) => s.sessionId)));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }, []);

  // Fetch + subscribe only after server is ready
  useEffect(() => {
    if (startup !== "ready") return;
    load().finally(() => setLoading(false));
    return subscribeToUpdates(() => { load().catch(() => undefined); });
  }, [startup, load]);

  async function handleArchive(sessionId: string) {
    const isCurrentlyArchived = archivedIds.has(sessionId);
    try {
      if (isCurrentlyArchived) await unarchiveSession(sessionId);
      else await archiveSession(sessionId);
      await load();
    } catch { /* ignore */ }
  }

  const sortedSessions = useMemo(
    () => sortSessions(sessions, sortKey, sortDir),
    [sessions, sortKey, sortDir],
  );

  function handleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "updated" ? "desc" : "asc");
    }
  }

  async function handleSync() {
    setSyncing(true);
    try {
      await syncSessions();
      await load();
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
        wrap="nowrap"
        style={{
          borderBottom: "1px solid var(--vscode-panel-border)",
          flexShrink: 0,
        }}
      >
        {(() => {
          const cwd  = repoPath();
          const name = cwd ? (cwd.split("/").filter(Boolean).pop() ?? cwd) : null;
          return (
            <Group gap={10} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
              {name && <Text size="sm" fw={600} style={{ flexShrink: 0 }}>{name}</Text>}
              {cwd && (
                <Text size="xs" c="dimmed" ff="monospace" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                  {cwd}
                </Text>
              )}
            </Group>
          );
        })()}
        <Group gap={8} wrap="nowrap">
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
                  {SESSION_COLUMNS.map(({ label, width, sortKey: colKey }) => (
                    <Table.Th
                      key={label || "_actions"}
                      style={{ width, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5, padding: 0 }}
                    >
                      {colKey ? (
                        <UnstyledButton
                          onClick={() => handleSort(colKey)}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                            width: "100%",
                            padding: "var(--table-vertical-spacing) var(--table-horizontal-spacing, 10px)",
                            fontSize: "inherit",
                            textTransform: "inherit",
                            letterSpacing: "inherit",
                            color: sortKey === colKey
                              ? "var(--mantine-color-indigo-5)"
                              : "inherit",
                            userSelect: "none",
                          }}
                        >
                          {label}
                          <span style={{ opacity: sortKey === colKey ? 1 : 0.3, fontSize: 10 }}>
                            {sortKey === colKey ? (sortDir === "asc" ? " ↑" : " ↓") : " ↕"}
                          </span>
                        </UnstyledButton>
                      ) : (
                        <span style={{ padding: "var(--table-vertical-spacing) var(--table-horizontal-spacing, 10px)", display: "block" }}>
                          {label}
                        </span>
                      )}
                    </Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {sortedSessions.map((item) => (
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
