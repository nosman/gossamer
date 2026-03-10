import React, { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Center, Loader, Alert, Text, Box, Badge, Group, UnstyledButton, Code, ScrollArea,
} from "@mantine/core";
import { fetchCheckpoints, subscribeToUpdates, type Checkpoint } from "../api";
import { TimeAgo } from "../components/TimeAgo";
import { usePinContextMenu } from "../components/usePinContextMenu";

function CheckpointCard({ checkpoint, onPress }: { checkpoint: Checkpoint; onPress: () => void }) {
  const { onContextMenu, menuElement } = usePinContextMenu("checkpoint", checkpoint.checkpointId);
  const title = checkpoint.summary?.intent ?? checkpoint.checkpointId;
  const shortId = checkpoint.checkpointId.slice(0, 12);
  const outTokens = checkpoint.tokenUsage?.outputTokens ?? 0;
  const tokStr = outTokens >= 1000
    ? `${(outTokens / 1000).toFixed(1)}k tokens`
    : outTokens > 0 ? `${outTokens} tokens` : null;
  const fileCount = checkpoint.filesTouched.length;

  return (
    <UnstyledButton
      onClick={onPress}
      onContextMenu={onContextMenu}
      style={{ width: "100%", display: "block", padding: "16px 20px", borderBottom: "1px solid var(--mantine-color-dark-4)" }}
      styles={{ root: { "&:hover": { backgroundColor: "var(--mantine-color-dark-5)" } } }}
    >
      {menuElement}
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="xl">
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Text fw={600} size="sm" mb={6} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {title}
          </Text>
          <Group gap={6} wrap="wrap" align="center">
            <Code fz={11} style={{ borderRadius: 4, padding: "1px 6px" }}>{shortId}</Code>
            {checkpoint.createdAt && (
              <>
                <Text size="xs" c="dimmed">·</Text>
                <TimeAgo iso={checkpoint.createdAt} />
              </>
            )}
            {checkpoint.branch && (
              <>
                <Text size="xs" c="dimmed">·</Text>
                <Badge variant="outline" color="teal" size="xs" radius="sm">{checkpoint.branch}</Badge>
              </>
            )}
            <Text size="xs" c="dimmed">·</Text>
            <Badge variant="outline" color="orange" size="xs" radius="sm" ff="monospace">Claude Code</Badge>
          </Group>
        </Box>

        <Group gap={6} style={{ flexShrink: 0, alignSelf: "center" }} wrap="nowrap">
          {fileCount > 0 && (
            <Text size="xs" c="dimmed">{fileCount} file{fileCount !== 1 ? "s" : ""}</Text>
          )}
          {checkpoint.sessionCount > 0 && (
            <>
              <Text size="xs" c="dimmed">·</Text>
              <Text size="xs" c="dimmed">{checkpoint.sessionCount} session{checkpoint.sessionCount !== 1 ? "s" : ""}</Text>
            </>
          )}
          {tokStr && (
            <>
              <Text size="xs" c="dimmed">·</Text>
              <Text size="xs" c="dimmed">{tokStr}</Text>
            </>
          )}
        </Group>
      </Group>
    </UnstyledButton>
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
    <ScrollArea style={{ flex: 1 }}>
      <Box>
        {checkpoints.map((cp) => (
          <CheckpointCard
            key={cp.checkpointId}
            checkpoint={cp}
            onPress={() =>
              navigate(`/checkpoints/${cp.checkpointId}`, {
                state: { title: cp.branch ? `${cp.branch} · ${cp.checkpointId}` : cp.checkpointId },
              })
            }
          />
        ))}
      </Box>
    </ScrollArea>
  );
}
