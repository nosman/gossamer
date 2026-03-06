import React, { useState } from "react";
import { StyleSheet } from "../primitives";
import type { CheckpointMessage } from "../api";
import { MarkdownView } from "./MarkdownView";

interface TextBlock   { type: "text";        text: string }
interface ToolUseBlock { type: "tool_use";   id: string; name: string; input: unknown }
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
    <div onClick={() => setExpanded((v) => !v)} style={s.toolRow}>
      <div style={s.toolHeader}>
        <span style={s.toolSym}>{result ? "✓" : "▶"}</span>
        <span style={s.toolName}>{block.name}</span>
        {hint && <span style={s.toolHint}>{hint}</span>}
        <span style={s.chevron}>{expanded ? "▲" : "▼"}</span>
      </div>
      {expanded && (
        <div style={s.toolBody}>
          <div style={s.sectionLabel}>input</div>
          <pre style={s.code}>{truncate(block.input)}</pre>
          {result && (
            <>
              <div style={s.sectionLabel}>output</div>
              <pre style={s.code}>{truncate(result.content)}</pre>
            </>
          )}
        </div>
      )}
    </div>
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
    <div onClick={hasMore ? () => setExpanded((v) => !v) : undefined} style={{ ...s.userCard, cursor: hasMore ? "pointer" : "default" } as React.CSSProperties}>
      <div style={s.cardHeader}>
        <span style={s.userLabel}>→ User</span>
        <span style={s.headerText}>{preview}</span>
        <span style={s.time}>{fmt(msg.timestamp)}</span>
        {hasMore && <span style={s.chevron}>{expanded ? "▲" : "▼"}</span>}
      </div>
      {expanded && <MarkdownView text={text} />}
    </div>
  );
}

function AssistantCard({ msg, toolResults }: { msg: CheckpointMessage; toolResults: Map<string, ToolResultBlock> }) {
  const d = msg.data as Record<string, unknown>;
  const content = (d.message as Record<string, unknown> | undefined)?.content;
  const allBlocks = blocks(content);
  const textBlocks = allBlocks.filter((b): b is TextBlock => b.type === "text");
  const toolUses  = allBlocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
  const fullText = textBlocks.map((b) => b.text).join("\n");
  const preview = fullText.slice(0, 120).replace(/\n+/g, " ");
  const hasMore = fullText.length > 120;
  const [expanded, setExpanded] = useState(false);

  return (
    <div style={s.assistantCard}>
      <div onClick={fullText ? () => setExpanded((v) => !v) : undefined} style={{ ...s.cardHeader, cursor: fullText ? "pointer" : "default" } as React.CSSProperties}>
        <span style={s.assistantLabel}>■ Assistant</span>
        {preview && <span style={s.headerText}>{preview}</span>}
        <span style={s.time}>{fmt(msg.timestamp)}</span>
        {hasMore && <span style={s.chevron}>{expanded ? "▲" : "▼"}</span>}
      </div>
      {expanded && fullText && <MarkdownView text={fullText} />}
      {toolUses.length > 0 && (
        <div style={s.toolList}>
          {toolUses.map((tu) => (
            <ToolUseRow key={tu.id} block={tu} result={toolResults.get(tu.id)} />
          ))}
        </div>
      )}
    </div>
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
    <div style={s.compactRow}>
      <span style={{ ...s.compactSym, color: style.color } as React.CSSProperties}>{style.sym}</span>
      <span style={{ ...s.compactType, color: style.color } as React.CSSProperties}>{msg.type}{hookEvent ? ` · ${hookEvent}` : ""}</span>
      <span style={s.time}>{fmt(msg.timestamp)}</span>
    </div>
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

const s = StyleSheet.create({
  userCard: { borderLeft: "4px solid #6366f1", backgroundColor: "#f5f3ff", padding: "8px 12px" } as React.CSSProperties,
  cardHeader: { display: "flex", flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 2 } as React.CSSProperties,
  userLabel: { fontSize: 11, fontWeight: 700, color: "#4338ca", textTransform: "uppercase", letterSpacing: 0.5, flexShrink: 0 } as React.CSSProperties,
  assistantLabel: { fontSize: 11, fontWeight: 700, color: "#b45309", textTransform: "uppercase", letterSpacing: 0.5, flexShrink: 0 } as React.CSSProperties,
  headerText: { fontSize: 12, fontWeight: 600, color: "#111827", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as React.CSSProperties,
  time: { fontSize: 10, color: "#9ca3af", marginLeft: "auto", flexShrink: 0 } as React.CSSProperties,
  chevron: { fontSize: 9, color: "#9ca3af", flexShrink: 0 } as React.CSSProperties,
  assistantCard: { borderLeft: "4px solid #f59e0b", backgroundColor: "#fff", padding: "8px 12px" } as React.CSSProperties,
  toolList: { marginTop: 4, borderTop: "1px solid #f1f5f9" } as React.CSSProperties,
  toolRow: { padding: "4px 0", borderBottom: "1px solid #f1f5f9", cursor: "pointer" } as React.CSSProperties,
  toolHeader: { display: "flex", flexDirection: "row", alignItems: "center", gap: 6 } as React.CSSProperties,
  toolSym: { fontSize: 11, color: "#22c55e", fontWeight: "bold", width: 14, textAlign: "center" } as React.CSSProperties,
  toolName: { fontSize: 11, fontWeight: 600, color: "#374151", fontFamily: "monospace", flexShrink: 0 } as React.CSSProperties,
  toolHint: { fontSize: 11, color: "#6b7280", fontFamily: "monospace", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as React.CSSProperties,
  toolBody: { marginTop: 4, marginLeft: 20 } as React.CSSProperties,
  sectionLabel: { fontSize: 10, color: "#6b7280", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.4, marginTop: 4, marginBottom: 2 } as React.CSSProperties,
  code: { fontFamily: "monospace", fontSize: 11, color: "#1e293b", backgroundColor: "#f8fafc", padding: 6, borderRadius: 3, lineHeight: "15px", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" } as React.CSSProperties,
  compactRow: { display: "flex", flexDirection: "row", alignItems: "center", gap: 6, padding: "3px 12px", borderBottom: "1px solid #f8fafc" } as React.CSSProperties,
  compactSym: { fontSize: 11, width: 14, textAlign: "center" } as React.CSSProperties,
  compactType: { fontSize: 11, flex: 1 } as React.CSSProperties,
});
