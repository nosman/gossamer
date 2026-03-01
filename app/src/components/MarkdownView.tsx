import React, { useMemo } from "react";
import { View, Text, StyleSheet } from "react-native";

// ─── Inline types ─────────────────────────────────────────────────────────────

type InlineNode =
  | { t: "text"; s: string }
  | { t: "bold"; s: string }
  | { t: "italic"; s: string }
  | { t: "code"; s: string };

function parseInline(raw: string): InlineNode[] {
  const nodes: InlineNode[] = [];
  // Match **bold**, *italic*, `code` — non-greedy, no newlines inside delimiters
  const re = /(\*\*(?:[^*]|\*(?!\*))+?\*\*|\*(?:[^*\n])+?\*|`[^`\n]+?`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    if (m.index > last) nodes.push({ t: "text", s: raw.slice(last, m.index) });
    const tok = m[1];
    if (tok.startsWith("**")) nodes.push({ t: "bold", s: tok.slice(2, -2) });
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
  | { kind: "para"; inline: InlineNode[] };

function parseBlocks(md: string): Block[] {
  const lines = md.split("\n");
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) codeLines.push(lines[i++]);
      if (i < lines.length) i++; // skip closing ```
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
      let num = 1;
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^\d+\. /, "")));
        i++;
        num++;
      }
      out.push({ kind: "numbered", items });
      continue;
    }

    // Empty line
    if (line.trim() === "") { i++; continue; }

    // Paragraph — accumulate until empty line or block-level element
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("```") &&
      !/^#{1,3} /.test(lines[i]) &&
      !/^[-*+] /.test(lines[i]) &&
      !/^\d+\. /.test(lines[i]) &&
      !/^([-*_])\1{2,}$/.test(lines[i].trim())
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
        if (n.t === "bold") return <Text key={i} style={s.bold}>{n.s}</Text>;
        if (n.t === "italic") return <Text key={i} style={s.italic}>{n.s}</Text>;
        if (n.t === "code") return <Text key={i} style={s.inlineCode}>{n.s}</Text>;
        return <Text key={i}>{n.s}</Text>;
      })}
    </>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

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
  list: { marginBottom: 6 },
  listItem: { flexDirection: "row", gap: 6, marginBottom: 3, alignItems: "flex-start" },
  marker: { fontSize: 13, color: "#6b7280", lineHeight: 20, minWidth: 16 },
  listText: { flex: 1, fontSize: 13, color: "#374151", lineHeight: 20 },
});
