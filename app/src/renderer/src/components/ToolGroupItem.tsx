import React, { useState } from "react";
import { Box, Badge, Group, Text, Collapse } from "@mantine/core";
import type { Event } from "../api";
import { ToolUseItem } from "./ToolUseItem";

export interface ToolUseData {
  pre: Event;
  post?: Event;
  failed: boolean;
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
}

function toolName(pre: Event): string {
  const d = pre.data as Record<string, unknown>;
  return typeof d.tool_name === "string" ? d.tool_name : "?";
}

export function ToolGroupItem({ tools }: { tools: ToolUseData[] }) {
  const [expanded, setExpanded] = useState(false);

  const names = tools.map((t) => toolName(t.pre));
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  const summary = [...counts.entries()].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(", ");

  const anyFailed  = tools.some((t) => t.failed);
  const anyPending = tools.some((t) => !t.post);
  const anyBlocked = tools.some((t) => t.pre.blocked);
  const sym   = anyFailed ? "✗" : anyPending ? "▶" : "✓";
  const color = anyFailed ? "red" : anyPending ? "blue" : "green";

  const timeStart = fmt(tools[0].pre.timestamp);
  const lastPost  = [...tools].reverse().find((t) => t.post)?.post;
  const timeEnd   = lastPost ? fmt(lastPost.timestamp) : undefined;
  const showRange = timeEnd && timeEnd !== timeStart;

  return (
    <Box style={{ borderLeft: "4px solid var(--mantine-color-gray-4)", backgroundColor: "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-7))" }}>
      <Group
        gap={6}
        px={12}
        py={6}
        onClick={() => setExpanded((v) => !v)}
        style={{ cursor: "pointer" }}
      >
        <Text size="xs" fw={700} c={color} style={{ width: 14, textAlign: "center" }}>{sym}</Text>
        <Text size="xs" fw={600}>({tools.length}) tool uses</Text>
        <Text size="xs" c="dimmed" ff="monospace" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{summary}</Text>
        <Text size="xs" c="dimmed">{timeStart}{showRange ? ` → ${timeEnd}` : ""}</Text>
        {anyBlocked && <Badge color="red" size="xs" variant="filled" fw={700}>BLOCKED</Badge>}
        <Text size="xs" c="dimmed">{expanded ? "▲" : "▼"}</Text>
      </Group>
      <Collapse in={expanded}>
        <Box style={{ borderTop: "1px solid var(--mantine-color-gray-3)" }}>
          {tools.map((t, i) => (
            <ToolUseItem key={i} pre={t.pre} post={t.post} failed={t.failed} />
          ))}
        </Box>
      </Collapse>
    </Box>
  );
}
