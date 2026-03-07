import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Center, Loader, Alert, Text, ScrollArea, Timeline, Badge, Group } from "@mantine/core";
import { fetchCheckpoints, subscribeToUpdates, type Checkpoint } from "../api";

const BRANCH_COLORS = ["indigo", "teal", "orange", "red", "violet", "cyan", "pink"] as const;
type BranchColor = typeof BRANCH_COLORS[number];

function branchColor(branch: string | null): BranchColor {
  if (!branch) return "indigo";
  let hash = 0;
  for (let i = 0; i < branch.length; i++) hash = (hash * 31 + branch.charCodeAt(i)) >>> 0;
  return BRANCH_COLORS[hash % BRANCH_COLORS.length];
}

export function CheckpointTimeline() {
  const navigate = useNavigate();
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await fetchCheckpoints();
      setCheckpoints([...data].sort((a, b) => a.id - b.id));
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
    <ScrollArea style={{ flex: 1 }} p="md">
      <Timeline active={checkpoints.length - 1} bulletSize={16} lineWidth={2} pl="sm">
        {checkpoints.map((cp) => {
          const color = branchColor(cp.branch);
          const outTokens = cp.tokenUsage?.outputTokens ?? 0;
          const fileCount = cp.filesTouched.length;
          return (
            <Timeline.Item
              key={cp.checkpointId}
              color={color}
              title={
                <Group gap={8} wrap="wrap" mb={2}>
                  {cp.branch && <Badge variant="light" color={color} size="sm">{cp.branch}</Badge>}
                  <Text ff="monospace" size="xs" fw={600}>{cp.checkpointId}</Text>
                </Group>
              }
              onClick={() =>
                navigate(`/checkpoints/${cp.checkpointId}`, {
                  state: { title: cp.branch ? `${cp.branch} · ${cp.checkpointId}` : cp.checkpointId },
                })
              }
              style={{ cursor: "pointer" }}
            >
              {cp.summary?.intent && (
                <Text size="xs" c="dimmed" fs="italic" mb={4}>{cp.summary.intent}</Text>
              )}
              <Group gap={12}>
                {fileCount > 0 && <Text size="xs" c="dimmed" ff="monospace">{fileCount} file{fileCount !== 1 ? "s" : ""}</Text>}
                {outTokens > 0 && <Text size="xs" c="dimmed" ff="monospace">{outTokens.toLocaleString()} tok</Text>}
                {cp.sessionCount > 0 && <Text size="xs" c="dimmed" ff="monospace">{cp.sessionCount} session{cp.sessionCount !== 1 ? "s" : ""}</Text>}
              </Group>
            </Timeline.Item>
          );
        })}
      </Timeline>
    </ScrollArea>
  );
}
