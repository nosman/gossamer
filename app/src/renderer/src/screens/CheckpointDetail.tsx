import React, { useEffect, useMemo, useState } from "react";
import { useParams, useLocation } from "react-router-dom";
import {
  Center, Loader, Text, ScrollArea, Box, Badge, Group, UnstyledButton, Collapse, Button,
} from "@mantine/core";
import {
  fetchCheckpoint,
  fetchCheckpointMessages,
  type Checkpoint,
  type CheckpointMessage,
  type CheckpointSummary,
} from "../api";
import { CheckpointMessageItem, type ToolResultBlock } from "../components/CheckpointMessageItem";

function SummarySection({ label, items }: { label: string; items: string[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <Box>
      <UnstyledButton onClick={() => setOpen((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
        <Text size="xs" fw={600}>{label} ({items.length})</Text>
        <Text size="xs" c="dimmed">{open ? "▲" : "▼"}</Text>
      </UnstyledButton>
      <Collapse in={open}>
        {items.map((item, i) => <Text key={i} size="xs" c="dimmed" pl={8} style={{ lineHeight: "18px" }}>· {item}</Text>)}
      </Collapse>
    </Box>
  );
}

function CodeLearningSections({ items }: { items: Array<{ path: string; finding: string }> }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  return (
    <Box>
      <UnstyledButton onClick={() => setOpen((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 6, width: "100%" }}>
        <Text size="xs" fw={600}>Code learnings ({items.length})</Text>
        <Text size="xs" c="dimmed">{open ? "▲" : "▼"}</Text>
      </UnstyledButton>
      <Collapse in={open}>
        {items.map((item, i) => (
          <Box key={i} pl={8} mb={4}>
            <Text size="xs" ff="monospace" c="violet" fw={600}>{item.path}</Text>
            <Text size="xs" c="dimmed">{item.finding}</Text>
          </Box>
        ))}
      </Collapse>
    </Box>
  );
}

function SummaryCard({ summary }: { summary: CheckpointSummary }) {
  return (
    <Box style={{ backgroundColor: "light-dark(var(--mantine-color-teal-0), var(--mantine-color-dark-7))", borderBottom: "1px solid light-dark(var(--mantine-color-teal-2), var(--mantine-color-teal-8))", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
      <Text size="xs" fw={700} c="teal" tt="uppercase" style={{ letterSpacing: 0.6 }}>Summary</Text>
      <Box>
        <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={2}>Intent</Text>
        <Text size="sm">{summary.intent}</Text>
      </Box>
      <Box>
        <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={2}>Outcome</Text>
        <Text size="sm">{summary.outcome}</Text>
      </Box>
      <SummarySection label="Repo learnings"     items={summary.repoLearnings} />
      <CodeLearningSections                        items={summary.codeLearnings} />
      <SummarySection label="Workflow learnings"  items={summary.workflowLearnings} />
      <SummarySection label="Friction"            items={summary.friction} />
      <SummarySection label="Open items"          items={summary.openItems.map((it) => it.text)} />
    </Box>
  );
}

export function CheckpointDetail() {
  const { checkpointId } = useParams<{ checkpointId: string }>();
  const { state } = useLocation();
  const [checkpoint, setCheckpoint] = useState<Checkpoint | null>(null);
  const [messages, setMessages] = useState<CheckpointMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCompact, setShowCompact] = useState(false);

  const id = checkpointId!;

  useEffect(() => {
    Promise.all([fetchCheckpoint(id), fetchCheckpointMessages(id)])
      .then(([cp, msgs]) => { setCheckpoint(cp); setMessages(msgs); setError(null); })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [id]);

  const toolResults = useMemo(() => {
    const map = new Map<string, ToolResultBlock>();
    for (const msg of messages) {
      if (msg.type !== "user") continue;
      const d = msg.data as Record<string, unknown>;
      const content = (d.message as Record<string, unknown> | undefined)?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as ToolResultBlock[]) {
        if (block.type === "tool_result" && block.tool_use_id) map.set(block.tool_use_id, block);
      }
    }
    return map;
  }, [messages]);

  if (loading) return <Center style={{ flex: 1 }}><Loader size="md" color="teal" /></Center>;
  if (error) return <Center style={{ flex: 1 }}><Text c="red">{error}</Text></Center>;

  const counts = messages.reduce<Record<string, number>>((acc, m) => {
    acc[m.type] = (acc[m.type] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <ScrollArea style={{ flex: 1 }}>
      <Group gap={6} p="xs" style={{ backgroundColor: "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-7))", borderBottom: "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-5))" }} wrap="wrap">
        {Object.entries(counts).map(([type, count]) => (
          <Badge key={type} variant="light" color="gray" size="sm" ff="monospace">{type} {count}</Badge>
        ))}
        <Button
          variant={showCompact ? "filled" : "outline"}
          color="dark"
          size="xs"
          ml="auto"
          onClick={() => setShowCompact((v) => !v)}
        >
          {showCompact ? "▲ hide system" : "▼ show system"}
        </Button>
      </Group>

      {checkpoint?.summary && <SummaryCard summary={checkpoint.summary} />}

      {messages.length === 0 ? (
        <Center p="xl"><Text c="dimmed" size="sm">No messages in this checkpoint.</Text></Center>
      ) : (
        messages.map((msg) => (
          <CheckpointMessageItem key={msg.uuid} msg={msg} toolResults={toolResults} showCompact={showCompact} />
        ))
      )}
    </ScrollArea>
  );
}
