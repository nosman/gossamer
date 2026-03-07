import React, { useEffect, useState } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { Center, Loader, Text, ScrollArea, Box, Badge, Group, UnstyledButton, Collapse } from "@mantine/core";
import {
  fetchSession,
  fetchSessionEvents,
  fetchSessionOverview,
  fetchSessionCheckpoints,
  type Session,
  type Event,
  type InteractionOverview,
  type SessionCheckpoint,
} from "../api";
import { EventItem } from "../components/EventItem";
import { ToolGroupItem, type ToolUseData } from "../components/ToolGroupItem";

type DisplayItem =
  | { kind: "event"; event: Event }
  | { kind: "toolGroup"; tools: ToolUseData[] }
  | { kind: "checkpoint"; checkpoint: SessionCheckpoint };

function groupEvents(events: Event[]): DisplayItem[] {
  const postMap = new Map<string, Event>();
  for (const event of events) {
    if (event.event === "PostToolUse" || event.event === "PostToolUseFailure") {
      const d = event.data as Record<string, unknown>;
      const id = typeof d.tool_use_id === "string" ? d.tool_use_id : null;
      if (id) postMap.set(id, event);
    }
  }

  type RawItem =
    | { kind: "event"; event: Event }
    | { kind: "toolUse"; pre: Event; post?: Event; failed: boolean };

  const raw: RawItem[] = [];
  const consumed = new Set<number>();

  for (const event of events) {
    if ((event.event === "PostToolUse" || event.event === "PostToolUseFailure") && consumed.has(event.id)) continue;
    if (event.event === "PreToolUse") {
      const d = event.data as Record<string, unknown>;
      const toolUseId = typeof d.tool_use_id === "string" ? d.tool_use_id : null;
      const post = toolUseId ? postMap.get(toolUseId) : undefined;
      if (post) consumed.add(post.id);
      raw.push({ kind: "toolUse", pre: event, post, failed: post?.event === "PostToolUseFailure" });
      continue;
    }
    raw.push({ kind: "event", event });
  }

  const isGroupable = (item: RawItem) =>
    item.kind === "toolUse" || (item.kind === "event" && item.event.event === "Notification");

  const result: DisplayItem[] = [];
  let i = 0;
  while (i < raw.length) {
    if (isGroupable(raw[i])) {
      const group: ToolUseData[] = [];
      while (i < raw.length && isGroupable(raw[i])) {
        const item = raw[i];
        if (item.kind === "toolUse") group.push({ pre: item.pre, post: item.post, failed: item.failed });
        i++;
      }
      if (group.length > 0) result.push({ kind: "toolGroup", tools: group });
    } else {
      result.push({ kind: "event", event: (raw[i] as { kind: "event"; event: Event }).event });
      i++;
    }
  }
  return result;
}

function CheckpointRow({ checkpoint, onPress }: { checkpoint: SessionCheckpoint; onPress: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const outTokens = checkpoint.tokenUsage?.outputTokens ?? 0;
  const fileCount = checkpoint.filesTouched.length;
  const sum = checkpoint.summary;

  return (
    <Box style={{ borderLeft: "4px solid var(--mantine-color-teal-6)" }}>
      <UnstyledButton
        onClick={() => setExpanded((v) => !v)}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", backgroundColor: "var(--mantine-color-teal-0)" }}
      >
        <Box style={{ flex: 1 }}>
          <Group gap={8} mb={2}>
            <Text size="xs" fw={700} c="teal" tt="uppercase">Checkpoint</Text>
            <Text ff="monospace" size="xs" c="green" fw={600}>{checkpoint.checkpointId}</Text>
            {checkpoint.branch && <Badge variant="light" color="teal" size="xs">{checkpoint.branch}</Badge>}
          </Group>
          {sum?.intent && (
            <Text size="xs" c="dimmed" fs="italic" lineClamp={expanded ? undefined : 1}>{sum.intent}</Text>
          )}
        </Box>
        <Box style={{ textAlign: "right", flexShrink: 0 }}>
          {fileCount > 0 && <Text size="xs" c="dimmed" ff="monospace">{fileCount} file{fileCount !== 1 ? "s" : ""}</Text>}
          {outTokens > 0 && <Text size="xs" c="dimmed" ff="monospace">{outTokens.toLocaleString()} tok</Text>}
        </Box>
      </UnstyledButton>

      <Collapse in={expanded}>
        <Box style={{ backgroundColor: "#f8fffe", borderTop: "1px solid var(--mantine-color-teal-2)", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          {sum?.outcome && (
            <Box>
              <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={2}>✓ Outcome</Text>
              <Text size="xs">{sum.outcome}</Text>
            </Box>
          )}
          {sum?.repoLearnings?.length ? (
            <Box>
              <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={2}>◎ Repo learnings</Text>
              {sum.repoLearnings.map((it, i) => <Text key={i} size="xs">· {it}</Text>)}
            </Box>
          ) : null}
          {sum?.codeLearnings?.length ? (
            <Box>
              <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={2}>{"</>"} Code learnings</Text>
              {sum.codeLearnings.map((it, i) => (
                <Box key={i} pl={4} mb={2}>
                  <Text size="xs" ff="monospace" c="violet" fw={600}>{it.path}</Text>
                  <Text size="xs">· {it.finding}</Text>
                </Box>
              ))}
            </Box>
          ) : null}
          {sum?.workflowLearnings?.length ? (
            <Box>
              <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={2}>↺ Workflow learnings</Text>
              {sum.workflowLearnings.map((it, i) => <Text key={i} size="xs">· {it}</Text>)}
            </Box>
          ) : null}
          {sum?.friction?.length ? (
            <Box>
              <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={2}>△ Friction</Text>
              {sum.friction.map((it, i) => <Text key={i} size="xs">· {it}</Text>)}
            </Box>
          ) : null}
          {sum?.openItems?.length ? (
            <Box>
              <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={2}>◇ Open items</Text>
              {sum.openItems.map((it, i) => <Text key={i} size="xs">· {it}</Text>)}
            </Box>
          ) : null}
          {fileCount > 0 && (
            <Box>
              <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={2}>Files touched</Text>
              {checkpoint.filesTouched.map((f, i) => <Text key={i} size="xs" ff="monospace" c="dimmed" pl={4}>{f}</Text>)}
            </Box>
          )}
          <UnstyledButton
            onClick={onPress}
            style={{ alignSelf: "flex-start", marginTop: 4, padding: "5px 10px", borderRadius: 4, border: "1px solid var(--mantine-color-teal-3)" }}
          >
            <Text size="xs" c="teal" ff="monospace">Open checkpoint →</Text>
          </UnstyledButton>
        </Box>
      </Collapse>
    </Box>
  );
}

export function SessionDetail() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();
  const { state } = useLocation();
  const [session, setSession] = useState<Session | null>(null);
  const [overview, setOverview] = useState<InteractionOverview | null>(null);
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const id = sessionId!;

  useEffect(() => {
    Promise.all([fetchSession(id), fetchSessionEvents(id), fetchSessionOverview(id), fetchSessionCheckpoints(id)])
      .then(([s, evs, ov, checkpoints]) => {
        setSession(s);
        setOverview(ov);
        const grouped = groupEvents(evs);
        const merged: DisplayItem[] = [];
        let cpIdx = 0;
        const sortedCps = [...checkpoints].sort((a, b) => (a.createdAt ?? "") < (b.createdAt ?? "") ? -1 : 1);

        for (const item of grouped) {
          const itemTime = item.kind === "event" ? item.event.timestamp : item.kind === "toolGroup" ? item.tools[0]?.pre.timestamp ?? "" : "";
          while (cpIdx < sortedCps.length && (sortedCps[cpIdx].createdAt ?? "") <= itemTime) {
            merged.push({ kind: "checkpoint", checkpoint: sortedCps[cpIdx++] });
          }
          merged.push(item);
        }
        while (cpIdx < sortedCps.length) merged.push({ kind: "checkpoint", checkpoint: sortedCps[cpIdx++] });

        setItems(merged);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <Center style={{ flex: 1 }}><Loader size="md" color="indigo" /></Center>;
  if (error) return <Center style={{ flex: 1 }}><Text c="red">{error}</Text></Center>;

  return (
    <ScrollArea style={{ flex: 1 }}>
      {session?.parentSessionId && (
        <UnstyledButton
          onClick={() => navigate(`/sessions/${session.parentSessionId}`, { state: { title: session.parentSessionId!.slice(0, 8) + "…" } })}
          style={{ width: "100%", display: "flex", alignItems: "center", gap: 6, backgroundColor: "var(--mantine-color-blue-0)", borderBottom: "1px solid var(--mantine-color-blue-2)", padding: "8px 14px" }}
        >
          <Text size="xs" c="blue">↑ Continuation of</Text>
          <Text size="xs" c="blue" ff="monospace" fw={600} td="underline">{session.parentSessionId.slice(0, 8)}…</Text>
        </UnstyledButton>
      )}
      {session?.childSessionIds?.map((childId) => (
        <UnstyledButton
          key={childId}
          onClick={() => navigate(`/sessions/${childId}`, { state: { title: childId.slice(0, 8) + "…" } })}
          style={{ width: "100%", display: "flex", alignItems: "center", gap: 6, backgroundColor: "var(--mantine-color-green-0)", borderBottom: "1px solid var(--mantine-color-green-2)", padding: "8px 14px" }}
        >
          <Text size="xs" c="green">↓ Continued as</Text>
          <Text size="xs" c="green" ff="monospace" fw={600} td="underline">{childId.slice(0, 8)}…</Text>
        </UnstyledButton>
      ))}

      {overview && (
        <Box style={{ backgroundColor: "var(--mantine-color-gray-0)", borderBottom: "1px solid var(--mantine-color-gray-3)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6 }}>
          <Text size="xs" fw={700} c="dimmed" tt="uppercase" style={{ letterSpacing: 0.6 }}>Overview</Text>
          <Text size="sm">{overview.summary}</Text>
          {overview.keywords.length > 0 && (
            <Group gap={5}>
              {overview.keywords.map((kw) => (
                <Badge key={kw} variant="light" color="gray" size="xs" radius="sm" ff="monospace">{kw}</Badge>
              ))}
            </Group>
          )}
          <Text size="xs" c="dimmed">
            {new Date(overview.startedAt).toLocaleString()} → {new Date(overview.endedAt).toLocaleString()}
          </Text>
        </Box>
      )}

      {items.length === 0 ? (
        <Center p="xl"><Text c="dimmed" size="sm">No events for this session.</Text></Center>
      ) : (
        items.map((item, idx) =>
          item.kind === "toolGroup" ? (
            <ToolGroupItem key={`grp-${idx}`} tools={item.tools} />
          ) : item.kind === "checkpoint" ? (
            <CheckpointRow
              key={`cp-${item.checkpoint.checkpointId}`}
              checkpoint={item.checkpoint}
              onPress={() => navigate(`/checkpoints/${item.checkpoint.checkpointId}`, {
                state: { title: item.checkpoint.branch ? `${item.checkpoint.branch} · ${item.checkpoint.checkpointId}` : item.checkpoint.checkpointId },
              })}
            />
          ) : (
            <EventItem key={`evt-${item.event.id}`} event={item.event} />
          )
        )
      )}
    </ScrollArea>
  );
}
