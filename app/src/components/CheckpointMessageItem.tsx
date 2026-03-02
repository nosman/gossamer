import React, { useState } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import type { CheckpointMessage } from "../api";
import { MarkdownView } from "./MarkdownView";

// ─── Content block shapes ─────────────────────────────────────────────────────

interface TextBlock   { type: "text";       text: string }
interface ToolUseBlock { type: "tool_use";  id: string; name: string; input: unknown }
interface ToolResultBlock { type: "tool_result"; tool_use_id: string; content: unknown }
type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | { type: string; [k: string]: unknown };

function blocks(content: unknown): ContentBlock[] {
  if (Array.isArray(content)) return content as ContentBlock[];
  return [];
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function fmt(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return (
    String(d.getHours()).padStart(2, "0") + ":" +
    String(d.getMinutes()).padStart(2, "0") + ":" +
    String(d.getSeconds()).padStart(2, "0")
  );
}

function truncate(v: unknown, max = 800): string {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.length > max ? s.slice(0, max) + "\n…" : s;
}

// ─── Tool use row ─────────────────────────────────────────────────────────────

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
    <TouchableOpacity onPress={() => setExpanded((v) => !v)} style={s.toolRow} activeOpacity={0.7}>
      <View style={s.toolHeader}>
        <Text style={s.toolSym}>{result ? "✓" : "▶"}</Text>
        <Text style={s.toolName}>{block.name}</Text>
        {hint ? <Text style={s.toolHint} numberOfLines={1}>{hint}</Text> : null}
        <Text style={s.chevron}>{expanded ? "▲" : "▼"}</Text>
      </View>
      {expanded && (
        <View style={s.toolBody}>
          <Text style={s.sectionLabel}>input</Text>
          <Text style={s.code} selectable>
            {truncate(block.input)}
          </Text>
          {result && (
            <>
              <Text style={s.sectionLabel}>output</Text>
              <Text style={s.code} selectable>
                {truncate(result.content)}
              </Text>
            </>
          )}
        </View>
      )}
    </TouchableOpacity>
  );
}

// ─── User message card ────────────────────────────────────────────────────────

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
    <TouchableOpacity
      onPress={hasMore ? () => setExpanded((v) => !v) : undefined}
      activeOpacity={hasMore ? 0.7 : 1}
      style={s.userCard}
    >
      <View style={s.cardHeader}>
        <Text style={s.userLabel}>→ User</Text>
        <Text style={s.headerText} numberOfLines={1}>{preview}</Text>
        <Text style={s.time}>{fmt(msg.timestamp)}</Text>
        {hasMore && <Text style={s.chevron}>{expanded ? "▲" : "▼"}</Text>}
      </View>
      {expanded && <MarkdownView text={text} />}
    </TouchableOpacity>
  );
}

// ─── Assistant message card ───────────────────────────────────────────────────

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
    <View style={s.assistantCard}>
      <TouchableOpacity
        onPress={fullText ? () => setExpanded((v) => !v) : undefined}
        activeOpacity={fullText ? 0.7 : 1}
        style={s.cardHeader}
      >
        <Text style={s.assistantLabel}>■ Assistant</Text>
        {preview ? <Text style={s.headerText} numberOfLines={1}>{preview}</Text> : null}
        <Text style={s.time}>{fmt(msg.timestamp)}</Text>
        {hasMore && <Text style={s.chevron}>{expanded ? "▲" : "▼"}</Text>}
      </TouchableOpacity>

      {expanded && fullText && <MarkdownView text={fullText} />}

      {toolUses.length > 0 && (
        <View style={s.toolList}>
          {toolUses.map((tu) => (
            <ToolUseRow key={tu.id} block={tu} result={toolResults.get(tu.id)} />
          ))}
        </View>
      )}
    </View>
  );
}

// ─── Compact row (progress, system, etc.) ────────────────────────────────────

const TYPE_STYLE: Record<string, { sym: string; color: string }> = {
  progress:              { sym: "◆", color: "#94a3b8" },
  system:                { sym: "⚙", color: "#94a3b8" },
  "file-history-snapshot": { sym: "📄", color: "#94a3b8" },
};

function CompactRow({ msg }: { msg: CheckpointMessage }) {
  const style = TYPE_STYLE[msg.type] ?? { sym: "◆", color: "#64748b" };
  const d = msg.data as Record<string, unknown>;
  const hookEvent = str((d.data as Record<string, unknown> | undefined)?.hookEvent);
  return (
    <View style={s.compactRow}>
      <Text style={[s.compactSym, { color: style.color }]}>{style.sym}</Text>
      <Text style={[s.compactType, { color: style.color }]}>
        {msg.type}{hookEvent ? ` · ${hookEvent}` : ""}
      </Text>
      <Text style={s.time}>{fmt(msg.timestamp)}</Text>
    </View>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

interface Props {
  msg: CheckpointMessage;
  toolResults: Map<string, ToolResultBlock>;
  showCompact: boolean;
}

export function CheckpointMessageItem({ msg, toolResults, showCompact }: Props) {
  if (msg.type === "user") {
    // Skip pure tool-result messages (they're paired with the tool use above)
    const d = msg.data as Record<string, unknown>;
    const content = (d.message as Record<string, unknown> | undefined)?.content;
    if (Array.isArray(content) && content.every((b: ContentBlock) => b.type === "tool_result")) {
      return null;
    }
    return <UserCard msg={msg} />;
  }
  if (msg.type === "assistant") return <AssistantCard msg={msg} toolResults={toolResults} />;
  if (!showCompact) return null;
  return <CompactRow msg={msg} />;
}

// Re-export the ToolResultBlock type so the detail screen can use it
export type { ToolResultBlock };

// ─── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  // User card
  userCard: {
    borderLeftWidth: 4,
    borderLeftColor: "#6366f1",
    backgroundColor: "#f5f3ff",
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 2,
  },
  userLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "#4338ca",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    flexShrink: 0,
  },
  assistantLabel: {
    fontSize: 11,
    fontWeight: "700",
    color: "#b45309",
    textTransform: "uppercase",
    letterSpacing: 0.5,
    flexShrink: 0,
  },
  headerText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#111827",
    flex: 1,
  },
  time: {
    fontSize: 10,
    color: "#9ca3af",
    marginLeft: "auto",
    flexShrink: 0,
  },
  chevron: {
    fontSize: 9,
    color: "#9ca3af",
    flexShrink: 0,
  },

  // Assistant card
  assistantCard: {
    borderLeftWidth: 4,
    borderLeftColor: "#f59e0b",
    backgroundColor: "#fff",
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  toolList: {
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: "#f1f5f9",
  },

  // Tool row
  toolRow: {
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: "#f1f5f9",
  },
  toolHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  toolSym: {
    fontSize: 11,
    color: "#22c55e",
    fontWeight: "bold",
    width: 14,
    textAlign: "center",
  },
  toolName: {
    fontSize: 11,
    fontWeight: "600",
    color: "#374151",
    fontFamily: "monospace",
    flexShrink: 0,
  },
  toolHint: {
    fontSize: 11,
    color: "#6b7280",
    fontFamily: "monospace",
    flex: 1,
  },
  toolBody: {
    marginTop: 4,
    marginLeft: 20,
  },
  sectionLabel: {
    fontSize: 10,
    color: "#6b7280",
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.4,
    marginTop: 4,
    marginBottom: 2,
  },
  code: {
    fontFamily: "monospace",
    fontSize: 11,
    color: "#1e293b",
    backgroundColor: "#f8fafc",
    padding: 6,
    borderRadius: 3,
    lineHeight: 15,
  },

  // Compact row
  compactRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 3,
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#f8fafc",
  },
  compactSym: {
    fontSize: 11,
    width: 14,
    textAlign: "center",
  },
  compactType: {
    fontSize: 11,
    flex: 1,
  },
});
