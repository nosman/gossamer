import React, { useState } from "react";
import { StyleSheet } from "../primitives";
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
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {oldStr && (
        <div style={ts.diffDel}>
          <pre style={ts.diffText}>{oldStr.split("\n").map((l) => "− " + l).join("\n")}</pre>
        </div>
      )}
      {newStr && (
        <div style={ts.diffAdd}>
          <pre style={ts.diffText}>{newStr.split("\n").map((l) => "+ " + l).join("\n")}</pre>
        </div>
      )}
    </div>
  );
}

function renderInput(toolName: string, inp: Record<string, unknown>): React.ReactNode {
  switch (toolName) {
    case "Edit": {
      const fp = str(inp.file_path), old = str(inp.old_string), newS = str(inp.new_string);
      return <div>{fp ? <div style={ts.filePath}>{fp}</div> : null}<DiffView oldStr={old} newStr={newS} /></div>;
    }
    case "Write": {
      const fp = str(inp.file_path), content = str(inp.content);
      return <div>{fp ? <div style={ts.filePath}>{fp}</div> : null}<pre style={ts.code}>{content.length > 1200 ? content.slice(0, 1200) + "\n…" : content}</pre></div>;
    }
    case "Read": {
      const fp = str(inp.file_path);
      const extra = (inp.offset != null ? `  offset: ${inp.offset}` : "") + (inp.limit != null ? `  limit: ${inp.limit}` : "");
      return <div style={ts.filePath}>{fp}{extra}</div>;
    }
    case "Bash": return <pre style={ts.code}>{str(inp.command)}</pre>;
    case "Glob": case "Grep": {
      const pattern = str(inp.pattern), extra = str(inp.path || inp.glob || inp.type || "");
      return <pre style={ts.code}>{pattern}{extra ? "\n" + extra : ""}</pre>;
    }
    case "WebFetch": {
      const url = str(inp.url), prompt = str(inp.prompt);
      return <div><div style={ts.filePath}>{url}</div>{prompt ? <pre style={ts.code}>{prompt}</pre> : null}</div>;
    }
    case "WebSearch": return <pre style={ts.code}>{str(inp.query)}</pre>;
    default: {
      const raw = JSON.stringify(inp, null, 2);
      return <pre style={ts.code}>{raw.length > 1200 ? raw.slice(0, 1200) + "\n…" : raw}</pre>;
    }
  }
}

export function ToolUseItem({ pre, post, failed }: Props) {
  const [expanded, setExpanded] = useState(false);
  const preData = pre.data as Record<string, unknown>;
  const toolName = typeof preData.tool_name === "string" ? preData.tool_name : "?";
  const hint = toolHint(toolName, pre.data);
  const sym = !post ? "▶" : failed ? "✗" : "✓";
  const color = !post ? "#3b82f6" : failed ? "#ef4444" : "#22c55e";
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
    <div onClick={() => setExpanded((v) => !v)} style={ts.container}>
      <div style={ts.header}>
        <span style={{ ...ts.sym, color } as React.CSSProperties}>{sym}</span>
        <span style={{ ...ts.toolName, color } as React.CSSProperties}>{toolName}</span>
        {hint && <span style={ts.hint}>{hint}</span>}
        <span style={ts.time}>{timeStart}{showRange ? ` → ${timeEnd}` : ""}</span>
        {pre.blocked && <span style={ts.blockedBadge}>BLOCKED</span>}
        <span style={ts.chevron}>{expanded ? "▲" : "▼"}</span>
      </div>
      {expanded && (
        <div style={ts.body}>
          {toolInput !== undefined && (
            <>
              <div style={ts.sectionLabel}>input</div>
              {renderInput(toolName, toolInput)}
            </>
          )}
          {outputStr !== undefined && (
            <>
              <div style={{ ...ts.sectionLabel, ...(failed ? { color: "#ef4444" } : {}) } as React.CSSProperties}>
                {failed ? "error" : "output"}
              </div>
              <pre style={ts.code}>{outputStr}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const ts = StyleSheet.create({
  container: { padding: "5px 12px", borderBottom: "1px solid #f1f5f9", cursor: "pointer" } as React.CSSProperties,
  header: { display: "flex", flexDirection: "row", alignItems: "center", gap: 6 } as React.CSSProperties,
  sym: { fontSize: 12, fontWeight: "bold", width: 14, textAlign: "center" } as React.CSSProperties,
  toolName: { fontSize: 12, fontWeight: 600, fontFamily: "monospace", flexShrink: 0 } as React.CSSProperties,
  hint: { fontSize: 11, color: "#6b7280", fontFamily: "monospace", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as React.CSSProperties,
  time: { fontSize: 10, color: "#9ca3af", flexShrink: 0 } as React.CSSProperties,
  blockedBadge: { backgroundColor: "#ef4444", borderRadius: 3, padding: "1px 4px", color: "#fff", fontSize: 9, fontWeight: "bold" } as React.CSSProperties,
  chevron: { fontSize: 9, color: "#9ca3af", flexShrink: 0 } as React.CSSProperties,
  body: { marginTop: 4, marginLeft: 20, marginBottom: 4 } as React.CSSProperties,
  sectionLabel: { fontSize: 10, color: "#6b7280", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginTop: 6, marginBottom: 2 } as React.CSSProperties,
  filePath: { fontFamily: "monospace", fontSize: 11, color: "#4338ca", marginBottom: 4, fontWeight: 600 } as React.CSSProperties,
  code: { fontFamily: "monospace", fontSize: 11, color: "#1e293b", backgroundColor: "#f8fafc", padding: 6, borderRadius: 3, lineHeight: "15px", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" } as React.CSSProperties,
  diffDel: { backgroundColor: "#fef2f2", borderLeft: "3px solid #fca5a5", padding: "4px 6px", borderRadius: 2 } as React.CSSProperties,
  diffAdd: { backgroundColor: "#f0fdf4", borderLeft: "3px solid #86efac", padding: "4px 6px", borderRadius: 2 } as React.CSSProperties,
  diffText: { fontFamily: "monospace", fontSize: 11, lineHeight: "16px", color: "#1e293b", margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-all" } as React.CSSProperties,
});
