import React, { useEffect, useState, useCallback } from "react";
import { Center, Loader, Alert, Text, Table, Box, SegmentedControl, Group, Anchor } from "@mantine/core";
import { fetchSessions, fetchRepoStatuses, subscribeToUpdates, type Session, type RepoStatus } from "../api";
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
];

const REPO_COLUMNS = ["Repo", "User", "Branch"] as const;

const SESSION_TOTAL_WIDTH = Object.values(COL_WIDTHS).reduce((a, b) => a + b, 0) + 16;

export function ActiveSessions() {
  const { openSessionTab, openBranchLogTab } = useTabs();
  const [view, setView] = useState<"sessions" | "repos">("sessions");
  const [sessions, setSessions] = useState<Session[]>([]);
  const [repoStatuses, setRepoStatuses] = useState<RepoStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { setCrumbs } = useBreadcrumb();

  const load = useCallback(async () => {
    try {
      const [data, statuses] = await Promise.all([fetchSessions(), fetchRepoStatuses()]);
      setSessions(data);
      setRepoStatuses(statuses);
      setError(null);
      return data;
    } catch (err) {
      setError(String(err));
      return [] as Session[];
    }
  }, []);

  useEffect(() => {
    load().then((data) => {
      const first = data[0];
      const user = first?.gitUserName ?? first?.gitUserEmail ?? null;
      setCrumbs([
        ...(user ? [{ label: user }] : []),
      ]);
    }).finally(() => setLoading(false));
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

  return (
    <Box style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <Group px={12} py={8} style={{ borderBottom: "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))", flexShrink: 0 }}>
        <SegmentedControl
          size="xs"
          value={view}
          onChange={(v) => setView(v as "sessions" | "repos")}
          data={[
            { label: "Sessions", value: "sessions" },
            { label: "Repos",    value: "repos"    },
          ]}
        />
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
