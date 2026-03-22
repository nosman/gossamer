import React, { useEffect, useState, useCallback } from "react";
import { Center, Loader, Alert, Text, Table, Box, SegmentedControl, Group, Anchor, Button, Modal, Textarea, Select, Switch, Tooltip } from "@mantine/core";
import { fetchSessions, fetchRepoStatuses, subscribeToUpdates, archiveSession, unarchiveSession, syncSessions, type Session, type RepoStatus } from "../api";
import { SessionRow, COL_WIDTHS } from "../components/SessionRow";
import { useBreadcrumb } from "../BreadcrumbContext";
import { useTabs } from "../TabsContext";

const SESSION_COLUMNS: { label: string; width: number }[] = [
  { label: "Session ID",  width: COL_WIDTHS.sessionId      },
  { label: "User",        width: COL_WIDTHS.user            },
  { label: "Repo",        width: COL_WIDTHS.repo            },
  { label: "Branch",      width: COL_WIDTHS.branch          },
  { label: "Intent",      width: COL_WIDTHS.intent          },
  { label: "Parent",      width: COL_WIDTHS.parentSessionId },
  { label: "Started",     width: COL_WIDTHS.started         },
  { label: "Updated",     width: COL_WIDTHS.updated         },
  { label: "",            width: COL_WIDTHS.actions         },
];

const REPO_COLUMNS = ["Repo", "User", "Branch"] as const;

const SESSION_TOTAL_WIDTH = Object.values(COL_WIDTHS).reduce((a, b) => a + b, 0) + 16;

export function ActiveSessions() {
  const { openSessionTab, openBranchLogTab, openSpawnTab } = useTabs();
  const [view, setView] = useState<"sessions" | "repos">("sessions");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [repoStatuses, setRepoStatuses] = useState<RepoStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { setCrumbs } = useBreadcrumb();

  const [newSessionOpen, setNewSessionOpen] = useState(false);
  const [newPrompt, setNewPrompt] = useState("");
  const [newCwd, setNewCwd] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [archivedIds, setArchivedIds] = useState<Set<string>>(new Set());

  const load = useCallback(async (archived = false) => {
    try {
      const [data, archivedData, statuses] = await Promise.all([
        fetchSessions(false),
        fetchSessions(true),
        fetchRepoStatuses(),
      ]);
      setSessions(archived ? archivedData : data);
      setArchivedIds(new Set(archivedData.map((s) => s.sessionId)));
      setRepoStatuses(statuses);
      setError(null);
      return data;
    } catch (err) {
      setError(String(err));
      return [] as Session[];
    }
  }, []);

  useEffect(() => {
    load(showArchived).then((data) => {
      const first = data[0];
      const user = first?.gitUserName ?? first?.gitUserEmail ?? null;
      setCrumbs([
        ...(user ? [{ label: user }] : []),
      ]);
    }).finally(() => setLoading(false));
    return subscribeToUpdates(() => { load(showArchived).catch(() => undefined); });
  }, [load, showArchived]);

  async function handleArchive(sessionId: string) {
    const isCurrentlyArchived = archivedIds.has(sessionId);
    try {
      if (isCurrentlyArchived) {
        await unarchiveSession(sessionId);
      } else {
        await archiveSession(sessionId);
      }
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

  function handleSpawn() {
    const prompt = newPrompt.trim();
    if (!prompt) return;
    const cwd = newCwd || (repoStatuses[0]?.localPath ?? process.env.HOME ?? "/");
    const escaped = prompt.replace(/'/g, "'\\''");
    setNewSessionOpen(false);
    setNewPrompt("");
    openSpawnTab(cwd, `claude '${escaped}'`, prompt.slice(0, 40) + (prompt.length > 40 ? "…" : ""));
  }

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

  const cwdOptions = repoStatuses.map((r) => ({ value: r.localPath, label: r.name ?? r.localPath }));

  return (
    <Box style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <Modal
        opened={newSessionOpen}
        onClose={() => setNewSessionOpen(false)}
        title="New session"
        size="md"
      >
        {cwdOptions.length > 0 && (
          <Select
            label="Working directory"
            placeholder="Pick a repo…"
            data={cwdOptions}
            value={newCwd || null}
            onChange={(v) => setNewCwd(v ?? "")}
            mb="sm"
            clearable
          />
        )}
        <Textarea
          label="Prompt"
          placeholder="What should Claude do?"
          autosize
          minRows={4}
          maxRows={12}
          value={newPrompt}
          onChange={(e) => setNewPrompt(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSpawn(); }}
          mb="sm"
          data-autofocus
        />
        <Group justify="flex-end">
          <Button variant="default" size="xs" onClick={() => setNewSessionOpen(false)}>Cancel</Button>
          <Button size="xs" color="indigo" disabled={!newPrompt.trim()} onClick={handleSpawn}>
            Start session
          </Button>
        </Group>
      </Modal>

      <Group px={12} py={8} justify="space-between" style={{ borderBottom: "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))", flexShrink: 0 }}>
        <Group gap={8}>
          <SegmentedControl
            size="xs"
            value={view}
            onChange={(v) => setView(v as "sessions" | "repos")}
            data={[
              { label: "Sessions", value: "sessions" },
              { label: "Repos",    value: "repos"    },
            ]}
          />
          {view === "sessions" && (
            <Switch
              size="xs"
              label="Archived"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.currentTarget.checked)}
            />
          )}
        </Group>
        <Group gap={8}>
          {view === "sessions" && (
            <Tooltip label="Sync active sessions" withArrow>
              <Button size="xs" variant="default" loading={syncing} onClick={handleSync}>
                Sync
              </Button>
            </Tooltip>
          )}
          <Button size="xs" color="indigo" onClick={() => setNewSessionOpen(true)}>
            New session
          </Button>
        </Group>
      </Group>

      {view === "sessions" ? (
        sessions.length === 0 ? (
          <Center style={{ flex: 1 }}><Text c="dimmed" size="sm">No sessions yet.</Text></Center>
        ) : (
          <Box style={{ flex: 1, overflow: "hidden" }}>
            <Table.ScrollContainer minWidth={SESSION_TOTAL_WIDTH} h="100%">
              <Table stickyHeader highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    {SESSION_COLUMNS.map(({ label, width }) => (
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
                        openSessionTab(
                          item.sessionId,
                          item.summary ?? item.intent ?? item.sessionId.slice(0, 8) + "…",
                        )
                      }
                      onArchive={handleArchive}
                      isArchived={archivedIds.has(item.sessionId)}
                      onParentPress={(parentId) => {
                        const parent = sessions.find((s) => s.sessionId === parentId);
                        openSessionTab(
                          parentId,
                          parent?.summary ?? parent?.intent ?? parentId.slice(0, 8) + "…",
                        );
                      }}
                    />
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Box>
        )
      ) : (
        repoStatuses.length === 0 ? (
          <Center style={{ flex: 1 }}><Text c="dimmed" size="sm">No repos configured.</Text></Center>
        ) : (
          <Box style={{ flex: 1, overflow: "hidden" }}>
            <Table.ScrollContainer minWidth={600} h="100%">
              <Table stickyHeader highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    {REPO_COLUMNS.map((label) => (
                      <Table.Th key={label} style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>
                        {label}
                      </Table.Th>
                    ))}
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {repoStatuses.map((repo) => (
                    <Table.Tr key={repo.localPath}>
                      <Table.Td>
                        {repo.currentBranch ? (
                          <Anchor
                            size="sm"
                            fw={500}
                            onClick={() =>
                              openBranchLogTab(repo.localPath, repo.currentBranch!, repo.name)
                            }
                            style={{ cursor: "pointer" }}
                            underline="never"
                          >
                            {repo.name}
                          </Anchor>
                        ) : (
                          <Text size="sm" fw={500}>{repo.name}</Text>
                        )}
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" c="dimmed">{repo.gitUserName ?? repo.gitUserEmail ?? "—"}</Text>
                      </Table.Td>
                      <Table.Td>
                        <Text size="sm" ff="monospace" c={repo.currentBranch ? "teal" : "dimmed"}>
                          {repo.currentBranch ?? "—"}
                        </Text>
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Box>
        )
      )}
    </Box>
  );
}
