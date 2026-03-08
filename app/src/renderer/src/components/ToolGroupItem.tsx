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

  const statusColor = anyFailed ? "red" : anyPending ? "blue" : "teal";
  const statusLabel = anyFailed ? "failed" : anyPending ? "running" : "done";

  const timeStart = fmt(tools[0].pre.timestamp);
  const lastPost  = [...tools].reverse().find((t) => t.post)?.post;
  const timeEnd   = lastPost ? fmt(lastPost.timestamp) : undefined;
  const showRange = timeEnd && timeEnd !== timeStart;

  return (
    <Box style={{ display: "flex", padding: "4px 20px 4px 58px" }}>
      <Box style={{
        flex: 1,
        border: "1px solid light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-4))",
        borderRadius: 8,
        overflow: "hidden",
        backgroundColor: "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-7))",
      }}>
        <Group
          gap={8}
          px={12}
          py={7}
          onClick={() => setExpanded((v) => !v)}
          style={{ cursor: "pointer" }}
        >
          <Badge size="xs" variant="light" color={statusColor}>{statusLabel}</Badge>
          <Text size="xs" c="dimmed" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {tools.length} tool {tools.length === 1 ? "use" : "uses"} — {summary}
          </Text>
          {anyBlocked && <Badge color="red" size="xs" variant="filled" fw={700}>BLOCKED</Badge>}
          <Text size="xs" c="dimmed">{timeStart}{showRange ? ` → ${timeEnd}` : ""}</Text>
          <Text size="xs" c="dimmed">{expanded ? "▲" : "▼"}</Text>
        </Group>
        <Collapse in={expanded}>
          <Box style={{ borderTop: "1px solid light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-4))" }}>
            {tools.map((t, i) => (
              <ToolUseItem key={i} pre={t.pre} post={t.post} failed={t.failed} />
            ))}
          </Box>
        </Collapse>
      </Box>
    </Box>
  );
}
