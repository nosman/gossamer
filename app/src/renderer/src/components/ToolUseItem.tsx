import React, { useState } from "react";
import { Box, Badge, Group, Text, Collapse, Code } from "@mantine/core";
import type { Event } from "../api";

interface Props {
  pre: Event;
  post?: Event;
  failed: boolean;
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
}
function str(v: unknown): string { return typeof v === "string" ? v : ""; }

function toolHint(toolName: string, data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const inp = (data as Record<string, unknown>).tool_input;
  if (!inp || typeof inp !== "object") return "";
  const i = inp as Record<string, unknown>;
  const s = (k: string) => (typeof i[k] === "string" ? String(i[k]) : undefined);
  switch (toolName) {
    case "Read": case "Write": case "Edit": return s("file_path") ?? "";
    case "Bash":      return (s("command") ?? "").replace(/\s+/g, " ").slice(0, 80);
    case "Glob":      return s("pattern") ?? "";
    case "Grep":      return s("pattern") ?? "";
    case "WebFetch":  return s("url") ?? "";
    case "WebSearch": return s("query") ?? "";
    default: return "";
  }
}

function truncated(val: unknown, max = 1200): string | undefined {
  if (val === undefined) return undefined;
  const s = typeof val === "string" ? val : JSON.stringify(val, null, 2);
  return s.length > max ? s.slice(0, max) + "\n…" : s;
}

function DiffView({ oldStr, newStr }: { oldStr: string; newStr: string }) {
  return (
    <Box style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {oldStr && (
        <Box style={{ backgroundColor: "var(--mantine-color-red-0)", borderLeft: "3px solid var(--mantine-color-red-3)", padding: "4px 6px", borderRadius: 2 }}>
          <Code block style={{ fontSize: 11, lineHeight: "16px", background: "transparent", padding: 0 }}>
            {oldStr.split("\n").map((l) => "− " + l).join("\n")}
          </Code>
        </Box>
      )}
      {newStr && (
        <Box style={{ backgroundColor: "var(--mantine-color-green-0)", borderLeft: "3px solid var(--mantine-color-green-3)", padding: "4px 6px", borderRadius: 2 }}>
          <Code block style={{ fontSize: 11, lineHeight: "16px", background: "transparent", padding: 0 }}>
            {newStr.split("\n").map((l) => "+ " + l).join("\n")}
          </Code>
        </Box>
      )}
    </Box>
  );
}

function renderInput(toolName: string, inp: Record<string, unknown>): React.ReactNode {
  switch (toolName) {
    case "Edit": {
      const fp = str(inp.file_path), old = str(inp.old_string), newS = str(inp.new_string);
      return <div>{fp ? <Text size="xs" ff="monospace" c="violet" fw={600} mb={4}>{fp}</Text> : null}<DiffView oldStr={old} newStr={newS} /></div>;
    }
    case "Write": {
      const fp = str(inp.file_path), content = str(inp.content);
      return <div>{fp ? <Text size="xs" ff="monospace" c="violet" fw={600} mb={4}>{fp}</Text> : null}<Code block style={{ fontSize: 11 }}>{content.length > 1200 ? content.slice(0, 1200) + "\n…" : content}</Code></div>;
    }
    case "Read": {
      const fp = str(inp.file_path);
      const extra = (inp.offset != null ? `  offset: ${inp.offset}` : "") + (inp.limit != null ? `  limit: ${inp.limit}` : "");
      return <Text size="xs" ff="monospace" c="violet" fw={600}>{fp}{extra}</Text>;
    }
    case "Bash": return <Code block style={{ fontSize: 11 }}>{str(inp.command)}</Code>;
    case "Glob": case "Grep": {
      const pattern = str(inp.pattern), extra = str(inp.path || inp.glob || inp.type || "");
      return <Code block style={{ fontSize: 11 }}>{pattern}{extra ? "\n" + extra : ""}</Code>;
    }
    case "WebFetch": {
      const url = str(inp.url), prompt = str(inp.prompt);
      return <div><Text size="xs" ff="monospace" c="violet" fw={600} mb={4}>{url}</Text>{prompt ? <Code block style={{ fontSize: 11 }}>{prompt}</Code> : null}</div>;
    }
    case "WebSearch": return <Code block style={{ fontSize: 11 }}>{str(inp.query)}</Code>;
    default: {
      const raw = JSON.stringify(inp, null, 2);
      return <Code block style={{ fontSize: 11 }}>{raw.length > 1200 ? raw.slice(0, 1200) + "\n…" : raw}</Code>;
    }
  }
}

export function ToolUseItem({ pre, post, failed }: Props) {
  const [expanded, setExpanded] = useState(false);
  const preData = pre.data as Record<string, unknown>;
  const toolName = typeof preData.tool_name === "string" ? preData.tool_name : "?";
  const hint = toolHint(toolName, pre.data);
  const sym = !post ? "▶" : failed ? "✗" : "✓";
  const color = !post ? "blue" : failed ? "red" : "green";
  const toolInput = preData.tool_input as Record<string, unknown> | undefined;
  let outputStr: string | undefined;
  if (post) {
    const postData = post.data as Record<string, unknown>;
    outputStr = failed ? truncated(postData.error) : truncated(postData.tool_response);
  }
  const timeStart = fmt(pre.timestamp);
  const timeEnd = post ? fmt(post.timestamp) : undefined;
  const showRange = timeEnd && timeEnd !== timeStart;

  return (
    <Box onClick={() => setExpanded((v) => !v)} style={{ padding: "5px 12px", borderBottom: "1px solid var(--mantine-color-gray-1)", cursor: "pointer" }}>
      <Group gap={6}>
        <Text size="xs" fw={700} c={color} style={{ width: 14, textAlign: "center" }}>{sym}</Text>
        <Text size="xs" fw={600} ff="monospace" c={color} style={{ flexShrink: 0 }}>{toolName}</Text>
        {hint && <Text size="xs" c="dimmed" ff="monospace" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{hint}</Text>}
        <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>{timeStart}{showRange ? ` → ${timeEnd}` : ""}</Text>
        {pre.blocked && <Badge color="red" size="xs" variant="filled" fw={700}>BLOCKED</Badge>}
        <Text size="xs" c="dimmed">{expanded ? "▲" : "▼"}</Text>
      </Group>
      <Collapse in={expanded}>
        <Box mt={4} ml={20} mb={4}>
          {toolInput !== undefined && (
            <>
              <Text size="xs" c="dimmed" fw={700} tt="uppercase" style={{ letterSpacing: 0.5, marginTop: 6, marginBottom: 2 }}>input</Text>
              {renderInput(toolName, toolInput)}
            </>
          )}
          {outputStr !== undefined && (
            <>
              <Text size="xs" fw={700} tt="uppercase" style={{ letterSpacing: 0.5, marginTop: 6, marginBottom: 2 }} c={failed ? "red" : "dimmed"}>
                {failed ? "error" : "output"}
              </Text>
              <Code block style={{ fontSize: 11 }}>{outputStr}</Code>
            </>
          )}
        </Box>
      </Collapse>
    </Box>
  );
}
