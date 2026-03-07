import React, { useMemo } from "react";

// ─── Inline parsing ───────────────────────────────────────────────────────────

type InlineNode =
  | { t: "text"; s: string }
  | { t: "bold"; s: string }
  | { t: "italic"; s: string }
  | { t: "code"; s: string };

function parseInline(raw: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  const re = /(\*\*(?:[^*]|\*(?!\*))+?\*\*|\*(?:[^*\n])+?\*|``(?:[^`]|`(?!`))+``|`[^`\n]+?`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) nodes.push({ t: "text", s: raw.slice(last, m.index) });
    const tok = m[1];
    if (tok.startsWith("**")) nodes.push({ t: "bold", s: tok.slice(2, -2) });
    else if (tok.startsWith("``")) nodes.push({ t: "code", s: tok.slice(2, -2).trim() });
    else if (tok.startsWith("`")) nodes.push({ t: "code", s: tok.slice(1, -1) });
    else nodes.push({ t: "italic", s: tok.slice(1, -1) });
    last = m.index + tok.length;
  }
  if (last < raw.length) nodes.push({ t: "text", s: raw.slice(last) });
  return nodes;
}

// ─── Block parsing ────────────────────────────────────────────────────────────

type Block =
  | { kind: "code"; lang: string; code: string }
  | { kind: "h"; level: 1 | 2 | 3; inline: InlineNode[] }
  | { kind: "bullets"; items: InlineNode[][] }
  | { kind: "numbered"; items: InlineNode[][] }
  | { kind: "hr" }
  | { kind: "table"; headers: InlineNode[][]; rows: InlineNode[][][] }
  | { kind: "para"; inline: InlineNode[] };

function parseBlocks(md: string): Block[] {
  const lines = md.split("\n");
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      const fence = trimmed.slice(0, 3);
      const lang = trimmed.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence)) codeLines.push(lines[i++]);
      if (i < lines.length) i++;
      out.push({ kind: "code", lang, code: codeLines.join("\n") });
      continue;
    }
    const hm = line.match(/^(#{1,3}) (.+)/);
    if (hm) { out.push({ kind: "h", level: hm[1].length as 1|2|3, inline: parseInline(hm[2]) }); i++; continue; }
    if (/^([-*_])\1{2,}$/.test(line.trim())) { out.push({ kind: "hr" }); i++; continue; }
    if (/^[-*+] /.test(line)) {
      const items: InlineNode[][] = [];
      while (i < lines.length && /^[-*+] /.test(lines[i])) { items.push(parseInline(lines[i].slice(2))); i++; }
      out.push({ kind: "bullets", items }); continue;
    }
    if (/^\d+\. /.test(line)) {
      const items: InlineNode[][] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) { items.push(parseInline(lines[i].replace(/^\d+\. /, ""))); i++; }
      out.push({ kind: "numbered", items }); continue;
    }
    if (line.includes("|") && i + 1 < lines.length && /^\|?[\s|:=-]*-+[\s|:=-]*\|?$/.test(lines[i + 1])) {
      const parseCells = (l: string): InlineNode[][] =>
        l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => parseInline(c.trim()));
      const headers = parseCells(line);
      i += 2;
      const rows: InlineNode[][][] = [];
      while (i < lines.length && lines[i].includes("|")) { rows.push(parseCells(lines[i])); i++; }
      out.push({ kind: "table", headers, rows }); continue;
    }
    if (line.trim() === "") { i++; continue; }
    const isTableStart = (j: number) => lines[j].includes("|") && j + 1 < lines.length && /^\|?[\s|:=-]*-+[\s|:=-]*\|?$/.test(lines[j + 1]);
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !lines[i].trimStart().startsWith("```") && !lines[i].trimStart().startsWith("~~~") && !/^#{1,3} /.test(lines[i]) && !/^[-*+] /.test(lines[i]) && !/^\d+\. /.test(lines[i]) && !/^([-*_])\1{2,}$/.test(lines[i].trim()) && !isTableStart(i)) {
      paraLines.push(lines[i]); i++;
    }
    if (paraLines.length > 0) out.push({ kind: "para", inline: parseInline(paraLines.join(" ")) });
  }
  return out;
}

// ─── Inline renderer (uses <span>) ───────────────────────────────────────────

function Inline({ nodes }: { nodes: InlineNode[] }): React.ReactElement {
  return (
    <>
      {nodes.map((n, i) => {
        if (n.t === "bold") return <strong key={i}><Inline nodes={parseInline(n.s)} /></strong>;
        if (n.t === "italic") return <em key={i}><Inline nodes={parseInline(n.s)} /></em>;
        if (n.t === "code") return <code key={i} style={{ fontFamily: "monospace", fontSize: 12, backgroundColor: "light-dark(#f1f5f9, var(--mantine-color-dark-5))", color: "light-dark(#0f172a, var(--mantine-color-dark-0))", padding: "0 3px", borderRadius: 3 }}>{n.s}</code>;
        return <React.Fragment key={i}>{n.s}</React.Fragment>;
      })}
    </>
  );
}

// ─── Public components ────────────────────────────────────────────────────────

export function InlineMarkdown({ text, style }: { text: string; style?: React.CSSProperties }) {
  const nodes = useMemo(() => parseInline(text), [text]);
  return <span style={style}><Inline nodes={nodes} /></span>;
}

export function MarkdownView({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);

  return (
    <div style={{ fontSize: 13, color: "light-dark(#374151, var(--mantine-color-dark-0))", lineHeight: "20px" }}>
      {blocks.map((block, idx) => {
        if (block.kind === "code") {
          return (
            <div key={idx} style={{ backgroundColor: "light-dark(#f8fafc, #1e293b)", borderRadius: 6, padding: 10, margin: "6px 0" }}>
              {block.lang && <div style={{ fontSize: 10, color: "#64748b", fontFamily: "monospace", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>{block.lang}</div>}
              <pre style={{ margin: 0, fontFamily: "monospace", fontSize: 12, color: "light-dark(#334155, #e2e8f0)", lineHeight: "18px", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{block.code}</pre>
            </div>
          );
        }
        if (block.kind === "h") {
          const Tag = `h${block.level}` as "h1" | "h2" | "h3";
          const fs = block.level === 1 ? 16 : block.level === 2 ? 14 : 13;
          return <Tag key={idx} style={{ fontSize: fs, fontWeight: 700, color: "light-dark(#111827, var(--mantine-color-dark-0))", margin: "10px 0 4px" }}><Inline nodes={block.inline} /></Tag>;
        }
        if (block.kind === "hr") {
          return <hr key={idx} style={{ border: "none", borderTop: "1px solid light-dark(#e5e7eb, var(--mantine-color-dark-4))", margin: "10px 0" }} />;
        }
        if (block.kind === "table") {
          return (
            <table key={idx} style={{ borderCollapse: "collapse", width: "100%", margin: "6px 0", fontSize: 12 }}>
              <thead>
                <tr style={{ backgroundColor: "light-dark(#f3f4f6, var(--mantine-color-dark-6))" }}>
                  {block.headers.map((h, j) => (
                    <th key={j} style={{ border: "1px solid light-dark(#e5e7eb, var(--mantine-color-dark-4))", padding: 6, fontWeight: 700, textAlign: "left", color: "light-dark(#111827, var(--mantine-color-dark-0))" }}><Inline nodes={h} /></th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, j) => (
                  <tr key={j} style={{ backgroundColor: j % 2 === 1 ? "light-dark(#f9fafb, var(--mantine-color-dark-6))" : undefined }}>
                    {row.map((cell, k) => (
                      <td key={k} style={{ border: "1px solid light-dark(#e5e7eb, var(--mantine-color-dark-4))", padding: 6, color: "light-dark(#374151, var(--mantine-color-dark-0))" }}><Inline nodes={cell} /></td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          );
        }
        if (block.kind === "bullets" || block.kind === "numbered") {
          const Tag = block.kind === "bullets" ? "ul" : "ol";
          return (
            <Tag key={idx} style={{ margin: "4px 0 6px", paddingLeft: 20 }}>
              {block.items.map((item, j) => (
                <li key={j} style={{ marginBottom: 3, lineHeight: "20px" }}><Inline nodes={item} /></li>
              ))}
            </Tag>
          );
        }
        return (
          <p key={idx} style={{ margin: "0 0 6px" }}>
            <Inline nodes={block.inline} />
          </p>
        );
      })}
    </div>
  );
}
