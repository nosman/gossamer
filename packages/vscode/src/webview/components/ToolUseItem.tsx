import React, { useEffect, useState } from "react";
import { Box, Badge, Group, Text, Collapse, Code, ActionIcon, Tooltip } from "@mantine/core";
import type { Event } from "../api";
import { relativeTime } from "./TimeAgo";

interface Props {
  pre: Event;
  post?: Event;
  failed: boolean;
  autoExpand?: boolean;
  matchTerms?: string[];
}

function str(v: unknown): string { return typeof v === "string" ? v : ""; }

function applyHighlight(text: string, terms: string[] | undefined): React.ReactNode {
  if (!terms?.length) return text;
  const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const parts = text.split(new RegExp(`(${pattern})`, "gi"));
  return parts.map((p, i) =>
    i % 2 === 1
      ? <mark key={i} style={{ background: "rgba(255,200,0,0.45)", borderRadius: 2, padding: "0 1px" }}>{p}</mark>
      : p
  );
}

function HighlightCode({ children, terms, style }: { children: string; terms?: string[] | undefined; style?: React.CSSProperties }) {
  return (
    <Code block style={style}>
      {applyHighlight(children, terms)}
    </Code>
  );
}

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

function DiffView({ oldStr, newStr, terms }: { oldStr: string; newStr: string; terms?: string[] }) {
  return (
    <Box style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {oldStr && (
        <Box style={{ backgroundColor: "var(--vscode-diffEditor-removedLineBackground, rgba(255,0,0,0.1))", borderLeft: "3px solid var(--vscode-diffEditor-removedTextBorder, var(--mantine-color-red-4))", padding: "4px 6px", borderRadius: 2 }}>
          <Code block style={{ fontSize: 11, lineHeight: "16px", background: "transparent", padding: 0 }}>
            {applyHighlight(oldStr.split("\n").map((l) => "− " + l).join("\n"), terms)}
          </Code>
        </Box>
      )}
      {newStr && (
        <Box style={{ backgroundColor: "var(--vscode-diffEditor-insertedLineBackground, rgba(155,185,85,0.2))", borderLeft: "3px solid var(--vscode-diffEditor-insertedTextBorder, var(--mantine-color-green-4))", padding: "4px 6px", borderRadius: 2 }}>
          <Code block style={{ fontSize: 11, lineHeight: "16px", background: "transparent", padding: 0 }}>
            {applyHighlight(newStr.split("\n").map((l) => "+ " + l).join("\n"), terms)}
          </Code>
        </Box>
      )}
    </Box>
  );
}

function renderInput(toolName: string, inp: Record<string, unknown>, terms?: string[]): React.ReactNode {
  switch (toolName) {
    case "Edit": {
      const fp = str(inp.file_path), old = str(inp.old_string), newS = str(inp.new_string);
      return <div>{fp ? <Text size="xs" ff="monospace" c="violet" fw={600} mb={4}>{applyHighlight(fp, terms)}</Text> : null}<DiffView oldStr={old} newStr={newS} terms={terms} /></div>;
    }
    case "Write": {
      const fp = str(inp.file_path), content = str(inp.content);
      const truncContent = content.length > 1200 ? content.slice(0, 1200) + "\n…" : content;
      return <div>{fp ? <Text size="xs" ff="monospace" c="violet" fw={600} mb={4}>{applyHighlight(fp, terms)}</Text> : null}<HighlightCode terms={terms} style={{ fontSize: 11 }}>{truncContent}</HighlightCode></div>;
    }
    case "Read": {
      const fp = str(inp.file_path);
      const extra = (inp.offset != null ? `  offset: ${inp.offset}` : "") + (inp.limit != null ? `  limit: ${inp.limit}` : "");
      return <Text size="xs" ff="monospace" c="violet" fw={600}>{applyHighlight(fp + extra, terms)}</Text>;
    }
    case "Bash": return <HighlightCode terms={terms} style={{ fontSize: 11 }}>{str(inp.command)}</HighlightCode>;
    case "Glob": case "Grep": {
      const pattern = str(inp.pattern), extra = str(inp.path || inp.glob || inp.type || "");
      return <HighlightCode terms={terms} style={{ fontSize: 11 }}>{pattern + (extra ? "\n" + extra : "")}</HighlightCode>;
    }
    case "WebFetch": {
      const url = str(inp.url), prompt = str(inp.prompt);
      return <div><Text size="xs" ff="monospace" c="violet" fw={600} mb={4}>{applyHighlight(url, terms)}</Text>{prompt ? <HighlightCode terms={terms} style={{ fontSize: 11 }}>{prompt}</HighlightCode> : null}</div>;
    }
    case "WebSearch": return <HighlightCode terms={terms} style={{ fontSize: 11 }}>{str(inp.query)}</HighlightCode>;
    default: {
      const raw = JSON.stringify(inp, null, 2);
      return <HighlightCode terms={terms} style={{ fontSize: 11 }}>{raw.length > 1200 ? raw.slice(0, 1200) + "\n…" : raw}</HighlightCode>;
    }
  }
}

function copyableText(toolName: string, inp: Record<string, unknown> | undefined): string {
  if (!inp) return "";
  const s = (k: string) => (typeof inp[k] === "string" ? String(inp[k]) : "");
  switch (toolName) {
    case "Bash": return s("command");
    case "Read": case "Write": case "Glob": return s("file_path") || s("pattern");
    case "Edit": return s("file_path");
    case "Grep": return s("pattern");
    case "WebFetch": return s("url");
    case "WebSearch": return s("query");
    default: return JSON.stringify(inp, null, 2);
  }
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tooltip label={copied ? "Copied!" : "Copy"} withArrow position="top" openDelay={0}>
      <ActionIcon
        size="xs"
        variant="subtle"
        color={copied ? "green" : "gray"}
        onClick={(e) => {
          e.stopPropagation();
          navigator.clipboard.writeText(text).catch(() => undefined);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        }}
        style={{ opacity: copied ? 1 : 0.5, flexShrink: 0 }}
      >
        {copied ? "✓" : "⧉"}
      </ActionIcon>
    </Tooltip>
  );
}

export function ToolUseItem({ pre, post, failed, autoExpand, matchTerms }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (autoExpand) setExpanded(true);
  }, [autoExpand]);

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
  const timeStart = relativeTime(pre.timestamp);
  const timeEnd = post ? relativeTime(post.timestamp) : undefined;
  const showRange = timeEnd && timeEnd !== timeStart;
  const copyText = copyableText(toolName, toolInput);

  return (
    <Box
      onClick={() => setExpanded((v) => !v)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ padding: "5px 12px", borderBottom: "1px solid var(--vscode-panel-border)", cursor: "pointer" }}
    >
      <Group gap={6}>
        <Text size="xs" fw={700} c={color} style={{ width: 14, textAlign: "center" }}>{sym}</Text>
        <Text size="xs" fw={600} ff="monospace" c={color} style={{ flexShrink: 0 }}>{toolName}</Text>
        {hint && <Text size="xs" c="dimmed" ff="monospace" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{hint}</Text>}
        {copyText && (
          <Box style={{ opacity: hovered ? 1 : 0, pointerEvents: hovered ? "auto" : "none", transition: "opacity 120ms", flexShrink: 0 }}>
            <CopyButton text={copyText} />
          </Box>
        )}
        <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>{timeStart}{showRange ? ` → ${timeEnd}` : ""}</Text>
        {pre.blocked && <Badge color="red" size="xs" variant="filled" fw={700}>BLOCKED</Badge>}
        <Text size="xs" c="dimmed">{expanded ? "▲" : "▼"}</Text>
      </Group>
      <Collapse in={expanded}>
        <Box mt={4} ml={20} mb={4}>
          {toolInput !== undefined && (
            <>
              <Text size="xs" c="dimmed" fw={700} tt="uppercase" style={{ letterSpacing: 0.5, marginTop: 6, marginBottom: 2 }}>input</Text>
              {renderInput(toolName, toolInput, matchTerms)}
            </>
          )}
          {outputStr !== undefined && (
            <>
              <Text size="xs" fw={700} tt="uppercase" style={{ letterSpacing: 0.5, marginTop: 6, marginBottom: 2 }} c={failed ? "red" : "dimmed"}>
                {failed ? "error" : "output"}
              </Text>
              <HighlightCode terms={matchTerms} style={{ fontSize: 11 }}>{outputStr}</HighlightCode>
            </>
          )}
        </Box>
      </Collapse>
    </Box>
  );
}
