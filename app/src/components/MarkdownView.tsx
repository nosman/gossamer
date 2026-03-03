import React, { useMemo } from "react";
import { View, Text, StyleSheet, type TextStyle } from "react-native";

// ─── Inline types ─────────────────────────────────────────────────────────────

type InlineNode =
  | { t: "text"; s: string }
  | { t: "bold"; s: string }
  | { t: "italic"; s: string }
  | { t: "code"; s: string };

function parseInline(raw: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  // Match **bold**, *italic*, ``double-backtick code``, `code` — in priority order
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

// ─── Block types ─────────────────────────────────────────────────────────────

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

    // Fenced code block (``` or ~~~), with optional leading whitespace
    const trimmedLine = line.trimStart();
    if (trimmedLine.startsWith("```") || trimmedLine.startsWith("~~~")) {
      const fence = trimmedLine.slice(0, 3);
      const lang = trimmedLine.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(fence)) codeLines.push(lines[i++]);
      if (i < lines.length) i++; // skip closing fence
      out.push({ kind: "code", lang, code: codeLines.join("\n") });
      continue;
    }

    // ATX heading
    const hm = line.match(/^(#{1,3}) (.+)/);
    if (hm) {
      out.push({ kind: "h", level: hm[1].length as 1 | 2 | 3, inline: parseInline(hm[2]) });
      i++;
      continue;
    }

    // Horizontal rule
    if (/^([-*_])\1{2,}$/.test(line.trim())) {
      out.push({ kind: "hr" });
      i++;
      continue;
    }

    // Bullet list
    if (/^[-*+] /.test(line)) {
      const items: InlineNode[][] = [];
      while (i < lines.length && /^[-*+] /.test(lines[i])) {
        items.push(parseInline(lines[i].slice(2)));
        i++;
      }
      out.push({ kind: "bullets", items });
      continue;
    }

    // Numbered list
    if (/^\d+\. /.test(line)) {
      const items: InlineNode[][] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^\d+\. /, "")));
        i++;
      }
      out.push({ kind: "numbered", items });
      continue;
    }

    // GFM table — header row followed by separator row (|---|---|)
    if (line.includes("|") && i + 1 < lines.length && /^\|?[\s|:=-]*-+[\s|:=-]*\|?$/.test(lines[i + 1])) {
      const parseCells = (l: string): InlineNode[][] =>
        l.replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => parseInline(c.trim()));
      const headers = parseCells(line);
      i += 2; // skip separator
      const rows: InlineNode[][][] = [];
      while (i < lines.length && lines[i].includes("|")) {
        rows.push(parseCells(lines[i]));
        i++;
      }
      out.push({ kind: "table", headers, rows });
      continue;
    }

    // Empty line
    if (line.trim() === "") { i++; continue; }

    // Paragraph — accumulate until empty line or block-level element
    const isTableStart = (j: number) =>
      lines[j].includes("|") &&
      j + 1 < lines.length &&
      /^\|?[\s|:=-]*-+[\s|:=-]*\|?$/.test(lines[j + 1]);
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].trimStart().startsWith("```") &&
      !lines[i].trimStart().startsWith("~~~") &&
      !/^#{1,3} /.test(lines[i]) &&
      !/^[-*+] /.test(lines[i]) &&
      !/^\d+\. /.test(lines[i]) &&
      !/^([-*_])\1{2,}$/.test(lines[i].trim()) &&
      !isTableStart(i)
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      out.push({ kind: "para", inline: parseInline(paraLines.join(" ")) });
    }
  }

  return out;
}

// ─── Inline renderer ─────────────────────────────────────────────────────────

function Inline({ nodes }: { nodes: InlineNode[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        if (n.t === "bold") return <Text key={i} style={s.bold}><Inline nodes={parseInline(n.s)} /></Text>;
        if (n.t === "italic") return <Text key={i} style={s.italic}><Inline nodes={parseInline(n.s)} /></Text>;
        if (n.t === "code") return <Text key={i} style={s.inlineCode}>{n.s}</Text>;
        return <Text key={i}>{n.s}</Text>;
      })}
    </>
  );
}

// ─── Public components ────────────────────────────────────────────────────────

// Renders a single line of inline markdown (bold, italic, code) inside a Text.
export function InlineMarkdown({
  text,
  style,
  numberOfLines,
}: {
  text: string;
  style?: TextStyle;
  numberOfLines?: number;
}) {
  const nodes = useMemo(() => parseInline(text), [text]);
  return (
    <Text style={style} numberOfLines={numberOfLines}>
      <Inline nodes={nodes} />
    </Text>
  );
}

export function MarkdownView({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);

  return (
    <View>
      {blocks.map((block, idx) => {
        if (block.kind === "code") {
          return (
            <View key={idx} style={s.codeBlock}>
              {block.lang ? <Text style={s.codeLang}>{block.lang}</Text> : null}
              <Text style={s.codeText} selectable>{block.code}</Text>
            </View>
          );
        }

        if (block.kind === "h") {
          const hs = block.level === 1 ? s.h1 : block.level === 2 ? s.h2 : s.h3;
          return (
            <Text key={idx} style={hs}>
              <Inline nodes={block.inline} />
            </Text>
          );
        }

        if (block.kind === "hr") {
          return <View key={idx} style={s.hr} />;
        }

        if (block.kind === "table") {
          const colCount = block.headers.length;
          return (
            <View key={idx} style={s.table}>
              <View style={[s.tableRow, s.tableHeaderRow]}>
                {block.headers.map((h, j) => (
                  <Text key={j} style={[s.tableCell, s.tableHeaderCell, { flex: 1 / colCount }]}>
                    <Inline nodes={h} />
                  </Text>
                ))}
              </View>
              {block.rows.map((row, j) => (
                <View key={j} style={[s.tableRow, j % 2 === 1 && s.tableRowAlt]}>
                  {row.map((cell, k) => (
                    <Text key={k} selectable style={[s.tableCell, { flex: 1 / colCount }]}>
                      <Inline nodes={cell} />
                    </Text>
                  ))}
                </View>
              ))}
            </View>
          );
        }

        if (block.kind === "bullets" || block.kind === "numbered") {
          return (
            <View key={idx} style={s.list}>
              {block.items.map((item, j) => (
                <View key={j} style={s.listItem}>
                  <Text style={s.marker}>
                    {block.kind === "numbered" ? `${j + 1}.` : "•"}
                  </Text>
                  <Text style={s.listText}>
                    <Inline nodes={item} />
                  </Text>
                </View>
              ))}
            </View>
          );
        }

        // paragraph
        return (
          <Text key={idx} style={s.para}>
            <Inline nodes={block.inline} />
          </Text>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  h1: { fontSize: 16, fontWeight: "700", color: "#111827", marginTop: 14, marginBottom: 6, lineHeight: 24 },
  h2: { fontSize: 14, fontWeight: "700", color: "#1f2937", marginTop: 10, marginBottom: 4, lineHeight: 20 },
  h3: { fontSize: 13, fontWeight: "700", color: "#374151", marginTop: 8, marginBottom: 2, lineHeight: 18 },
  para: { fontSize: 13, color: "#374151", lineHeight: 20, marginBottom: 6 },
  bold: { fontWeight: "700" },
  italic: { fontStyle: "italic" },
  inlineCode: {
    fontFamily: "monospace",
    fontSize: 12,
    backgroundColor: "#f1f5f9",
    color: "#0f172a",
  },
  codeBlock: {
    backgroundColor: "#1e293b",
    borderRadius: 6,
    padding: 10,
    marginVertical: 6,
  },
  codeLang: {
    fontSize: 10,
    color: "#64748b",
    fontFamily: "monospace",
    marginBottom: 6,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  codeText: {
    fontFamily: "monospace",
    fontSize: 12,
    color: "#e2e8f0",
    lineHeight: 18,
  },
  hr: {
    height: 1,
    backgroundColor: "#e5e7eb",
    marginVertical: 10,
  },
  table: { marginVertical: 6, borderWidth: 1, borderColor: "#e5e7eb", borderRadius: 4, overflow: "hidden" },
  tableRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#e5e7eb" },
  tableHeaderRow: { backgroundColor: "#f3f4f6" },
  tableRowAlt: { backgroundColor: "#f9fafb" },
  tableCell: { fontSize: 12, color: "#374151", lineHeight: 18, padding: 6 },
  tableHeaderCell: { fontWeight: "700", color: "#111827" },
  list: { marginBottom: 6 },
  listItem: { flexDirection: "row", gap: 6, marginBottom: 3, alignItems: "flex-start" },
  marker: { fontSize: 13, color: "#6b7280", lineHeight: 20, minWidth: 16 },
  listText: { flex: 1, fontSize: 13, color: "#374151", lineHeight: 20 },
});
