import React, { useState } from "react";
import { Box, Group, Text, Badge, Code, Collapse } from "@mantine/core";
import type { CheckpointMessage } from "../api";
import { MarkdownView } from "./MarkdownView";

interface TextBlock    { type: "text";        text: string }
interface ToolUseBlock  { type: "tool_use";   id: string; name: string; input: unknown }
export interface ToolResultBlock { type: "tool_result"; tool_use_id: string; content: unknown }
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | { type: string; [k: string]: unknown };

function blocks(content: unknown): ContentBlock[] { return Array.isArray(content) ? content as ContentBlock[] : []; }
function str(v: unknown): string { return typeof v === "string" ? v : ""; }
function fmt(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0") + ":" + String(d.getSeconds()).padStart(2, "0");
}
function truncate(v: unknown, max = 800): string {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.length > max ? s.slice(0, max) + "\n…" : s;
}

function ToolUseRow({ block, result }: { block: ToolUseBlock; result?: ToolResultBlock }) {
  const [expanded, setExpanded] = useState(false);
  const inp = block.input as Record<string, unknown>;
  const hint = (() => {
    if (!inp) return "";
    switch (block.name) {
      case "Read": case "Write": case "Edit": return str(inp.file_path);
      case "Bash":      return str(inp.command).replace(/\s+/g, " ").slice(0, 80);
      case "Glob":      return str(inp.pattern);
      case "Grep":      return str(inp.pattern);
      case "WebFetch":  return str(inp.url);
      case "WebSearch": return str(inp.query);
      default: return "";
    }
  })();

  return (
    <Box onClick={() => setExpanded((v) => !v)} style={{ padding: "4px 0", borderBottom: "1px solid var(--mantine-color-gray-1)", cursor: "pointer" }}>
      <Group gap={6}>
        <Text size="xs" c={result ? "green" : "blue"} fw={700} style={{ width: 14, textAlign: "center" }}>{result ? "✓" : "▶"}</Text>
        <Text size="xs" fw={600} ff="monospace" style={{ flexShrink: 0 }}>{block.name}</Text>
        {hint && <Text size="xs" c="dimmed" ff="monospace" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{hint}</Text>}
        <Text size="xs" c="dimmed">{expanded ? "▲" : "▼"}</Text>
      </Group>
      <Collapse in={expanded}>
        <Box mt={4} ml={20}>
          <Text size="xs" c="dimmed" fw={700} tt="uppercase" mb={2}>input</Text>
          <Code block style={{ fontSize: 11 }}>{truncate(block.input)}</Code>
          {result && (
            <>
              <Text size="xs" c="dimmed" fw={700} tt="uppercase" mt={4} mb={2}>output</Text>
              <Code block style={{ fontSize: 11 }}>{truncate(result.content)}</Code>
            </>
          )}
        </Box>
      </Collapse>
    </Box>
  );
}

function UserCard({ msg }: { msg: CheckpointMessage }) {
  const d = msg.data as Record<string, unknown>;
  const content = (d.message as Record<string, unknown> | undefined)?.content;
  const text = typeof content === "string"
    ? content
    : blocks(content).filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("\n");
  if (!text.trim()) return null;

  const [expanded, setExpanded] = useState(false);
  const preview = text.slice(0, 120).replace(/\n+/g, " ");
  const hasMore = text.length > 120;

  return (
    <Box
      onClick={hasMore ? () => setExpanded((v) => !v) : undefined}
      style={{ borderLeft: "4px solid var(--mantine-color-indigo-5)", backgroundColor: "var(--mantine-color-indigo-0)", padding: "8px 12px", cursor: hasMore ? "pointer" : "default" }}
    >
      <Group gap={8} mb={2}>
        <Text size="xs" fw={700} c="indigo" tt="uppercase" style={{ letterSpacing: 0.5, flexShrink: 0 }}>→ User</Text>
        <Text size="xs" fw={600} style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{preview}</Text>
        <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>{fmt(msg.timestamp)}</Text>
        {hasMore && <Text size="xs" c="dimmed">{expanded ? "▲" : "▼"}</Text>}
      </Group>
      <Collapse in={expanded}>
        <MarkdownView text={text} />
      </Collapse>
    </Box>
  );
}

function AssistantCard({ msg, toolResults }: { msg: CheckpointMessage; toolResults: Map<string, ToolResultBlock> }) {
  const d = msg.data as Record<string, unknown>;
  const content = (d.message as Record<string, unknown> | undefined)?.content;
  const allBlocks = blocks(content);
  const textBlocks = allBlocks.filter((b): b is TextBlock => b.type === "text");
  const toolUses   = allBlocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
  const fullText = textBlocks.map((b) => b.text).join("\n");
  const preview = fullText.slice(0, 120).replace(/\n+/g, " ");
  const hasMore = fullText.length > 120;
  const [expanded, setExpanded] = useState(false);

  return (
    <Box style={{ borderLeft: "4px solid var(--mantine-color-orange-4)", backgroundColor: "#fff", padding: "8px 12px" }}>
      <Group
        gap={8}
        mb={2}
        onClick={fullText ? () => setExpanded((v) => !v) : undefined}
        style={{ cursor: fullText ? "pointer" : "default" }}
      >
        <Text size="xs" fw={700} c="orange" tt="uppercase" style={{ letterSpacing: 0.5, flexShrink: 0 }}>■ Assistant</Text>
        {preview && <Text size="xs" fw={600} style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{preview}</Text>}
        <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>{fmt(msg.timestamp)}</Text>
        {hasMore && <Text size="xs" c="dimmed">{expanded ? "▲" : "▼"}</Text>}
      </Group>
      <Collapse in={expanded}>
        {fullText && <MarkdownView text={fullText} />}
      </Collapse>
      {toolUses.length > 0 && (
        <Box mt={4} style={{ borderTop: "1px solid var(--mantine-color-gray-1)" }}>
          {toolUses.map((tu) => (
            <ToolUseRow key={tu.id} block={tu} result={toolResults.get(tu.id)} />
          ))}
        </Box>
      )}
    </Box>
  );
}

const TYPE_STYLE: Record<string, { sym: string; color: string }> = {
  progress: { sym: "◆", color: "#94a3b8" },
  system:   { sym: "⚙", color: "#94a3b8" },
  "file-history-snapshot": { sym: "📄", color: "#94a3b8" },
};

function CompactRow({ msg }: { msg: CheckpointMessage }) {
  const style = TYPE_STYLE[msg.type] ?? { sym: "◆", color: "#64748b" };
  const d = msg.data as Record<string, unknown>;
  const hookEvent = str((d.data as Record<string, unknown> | undefined)?.hookEvent);
  return (
    <Group gap={6} px={12} py="3px" style={{ borderBottom: "1px solid var(--mantine-color-gray-0)" }}>
      <Text size="xs" style={{ color: style.color, width: 14, textAlign: "center" }}>{style.sym}</Text>
      <Text size="xs" style={{ color: style.color, flex: 1 }}>{msg.type}{hookEvent ? ` · ${hookEvent}` : ""}</Text>
      <Text size="xs" c="dimmed">{fmt(msg.timestamp)}</Text>
    </Group>
  );
}

interface Props {
  msg: CheckpointMessage;
  toolResults: Map<string, ToolResultBlock>;
  showCompact: boolean;
}

export function CheckpointMessageItem({ msg, toolResults, showCompact }: Props) {
  if (msg.type === "user") {
    const d = msg.data as Record<string, unknown>;
    const content = (d.message as Record<string, unknown> | undefined)?.content;
    if (Array.isArray(content) && content.every((b: ContentBlock) => b.type === "tool_result")) return null;
    return <UserCard msg={msg} />;
  }
  if (msg.type === "assistant") return <AssistantCard msg={msg} toolResults={toolResults} />;
  if (!showCompact) return null;
  return <CompactRow msg={msg} />;
}
