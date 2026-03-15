import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Center, Loader, Text, ScrollArea, Box, Badge, Group } from "@mantine/core";
import { fetchBranchLog, type BranchLogEntry, type SessionCheckpoint } from "../api";
import { useBreadcrumb } from "../BreadcrumbContext";
import { EventItem } from "../components/EventItem";
import {
  logEventsToEvents,
  groupEvents,
  groupClaudeTurns,
  ClaudeTurnCard,
  CheckpointRow,
  type RenderItem,
} from "./SessionDetail";

function entryToCheckpoint(entry: BranchLogEntry): SessionCheckpoint {
  return {
    checkpointId: entry.checkpointId,
    branch:       entry.branch,
    cliVersion:   null,
    filesTouched: entry.filesTouched,
    tokenUsage:   entry.tokenUsage,
    createdAt:    entry.createdAt,
    summary:      entry.summary,
  };
}

function entryToRenderItems(entry: BranchLogEntry): RenderItem[] {
  return groupClaudeTurns(groupEvents(logEventsToEvents(entry.logEvents)));
}

export function BranchLog() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const localPath = searchParams.get("localPath") ?? "";
  const branch    = searchParams.get("branch")    ?? "";

  const [entries, setEntries] = useState<BranchLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const { setCrumbs } = useBreadcrumb();

  useEffect(() => {
    setCrumbs([{ label: branch }]);
    fetchBranchLog(localPath, branch)
      .then(setEntries)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [localPath, branch]);

  if (loading) return <Center style={{ flex: 1 }}><Loader size="md" color="teal" /></Center>;
  if (error)   return <Center style={{ flex: 1 }}><Text c="red">{error}</Text></Center>;

  if (entries.length === 0) {
    return (
      <Center style={{ flex: 1 }}>
        <Text c="dimmed" size="sm">No checkpoints found on branch <Text span ff="monospace">{branch}</Text>.</Text>
      </Center>
    );
  }

  return (
    <ScrollArea style={{ flex: 1 }}>
      <Box style={{ maxWidth: 860, margin: "0 auto", paddingBottom: 40 }}>

        {/* Branch header */}
        <Group
          px={20} py={12} gap={10}
          style={{ borderBottom: "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))" }}
        >
          <Text size="xs" fw={700} c="dimmed" tt="uppercase" style={{ letterSpacing: 0.5 }}>Branch</Text>
          <Badge variant="light" color="teal" ff="monospace" size="md">{branch}</Badge>
          <Text size="xs" c="dimmed" ff="monospace">{localPath}</Text>
        </Group>

        {entries.map((entry) => {
          const checkpoint = entryToCheckpoint(entry);
          const items      = entryToRenderItems(entry);
          return (
            <React.Fragment key={`${entry.checkpointId}-${entry.sessionId}`}>
              <CheckpointRow
                checkpoint={checkpoint}
                onPress={() => navigate(`/checkpoints/${entry.checkpointId}`)}
              />
              {items.map((item, idx) => {
                const key = item.kind === "claudeTurn"  ? `${entry.sessionId}-turn-${idx}`
                          : item.kind === "checkpoint"  ? `${entry.sessionId}-cp-${(item as { checkpoint: SessionCheckpoint }).checkpoint.checkpointId}`
                          : `${entry.sessionId}-evt-${(item as { event: { id: number } }).event.id}`;
                return (
                  <div key={key}>
                    {item.kind === "claudeTurn" ? (
                      <ClaudeTurnCard toolGroups={item.toolGroups} stop={item.stop} />
                    ) : item.kind === "checkpoint" ? (
                      <CheckpointRow
                        checkpoint={item.checkpoint}
                        onPress={() => navigate(`/checkpoints/${item.checkpoint.checkpointId}`)}
                      />
                    ) : (
                      <EventItem event={item.event} />
                    )}
                  </div>
                );
              })}
            </React.Fragment>
          );
        })}
      </Box>
    </ScrollArea>
  );
}
