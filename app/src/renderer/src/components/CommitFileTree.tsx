import React, { useState } from "react";
import parseDiff from "parse-diff";
import { Box, Text, Group, Badge } from "@mantine/core";

interface DiffFile {
  path: string;
  status: "A" | "M" | "D" | "R";
  additions: number;
  deletions: number;
}

interface TreeNode {
  label: string;
  children: Map<string, TreeNode>;
  file?: DiffFile;
}

function compressNode(node: TreeNode): TreeNode {
  const newChildren = new Map<string, TreeNode>();
  for (const [k, child] of node.children) {
    newChildren.set(k, compressNode(child));
  }
  node = { ...node, children: newChildren };

  if (newChildren.size === 1 && !node.file) {
    const [, only] = [...newChildren.entries()][0];
    if (!only.file) {
      return {
        label: node.label ? `${node.label}/${only.label}` : only.label,
        children: only.children,
      };
    }
  }
  return node;
}

function buildTree(files: DiffFile[]): TreeNode {
  const root: TreeNode = { label: "", children: new Map() };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!node.children.has(parts[i])) {
        node.children.set(parts[i], { label: parts[i], children: new Map() });
      }
      node = node.children.get(parts[i])!;
    }
    node.children.set(parts[parts.length - 1], {
      label: parts[parts.length - 1],
      children: new Map(),
      file: f,
    });
  }

  // Compress single-child directory chains
  const compressedChildren = new Map<string, TreeNode>();
  for (const [k, child] of root.children) {
    compressedChildren.set(k, compressNode(child));
  }
  return { ...root, children: compressedChildren };
}

const STATUS_COLOR: Record<string, string> = { A: "green", M: "gray", D: "red", R: "blue" };

function FileRow({ file }: { file: DiffFile }) {
  return (
    <Group gap={8} wrap="nowrap" style={{ paddingLeft: 8 }}>
      <Badge size="xs" color={STATUS_COLOR[file.status] ?? "gray"} variant="filled" style={{ fontFamily: "monospace", minWidth: 18, textAlign: "center", flexShrink: 0 }}>
        {file.status}
      </Badge>
      <Text size="xs" ff="monospace" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {file.label}
      </Text>
      <Text size="xs" ff="monospace" c="green" fw={600} style={{ flexShrink: 0 }}>
        +{file.additions}
      </Text>
      <Text size="xs" ff="monospace" c="dimmed" style={{ flexShrink: 0 }}>/</Text>
      <Text size="xs" ff="monospace" c="red" fw={600} style={{ flexShrink: 0 }}>
        -{file.deletions}
      </Text>
    </Group>
  );
}

function DirNode({ node, depth }: { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState(true);
  const indent = depth * 12;

  if (node.file) {
    return (
      <Box style={{ paddingLeft: indent }}>
        <FileRow file={{ ...node.file, label: node.label }} />
      </Box>
    );
  }

  const children = [...node.children.values()].sort((a, b) => {
    // Directories before files, then alphabetically
    const aIsDir = !a.file;
    const bIsDir = !b.file;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return a.label.localeCompare(b.label);
  });

  return (
    <Box style={{ paddingLeft: indent }}>
      <Group
        gap={6}
        style={{ cursor: "pointer", paddingBottom: 2, paddingTop: 2 }}
        onClick={() => setOpen((v) => !v)}
        wrap="nowrap"
      >
        <Text size="xs" c="dimmed" style={{ width: 10, flexShrink: 0 }}>{open ? "∨" : "›"}</Text>
        <Text size="xs" ff="monospace" c="dimmed" fw={500}>{node.label}</Text>
      </Group>
      {open && (
        <Box style={{ borderLeft: "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))", marginLeft: 4, paddingLeft: 4 }}>
          {children.map((child) => (
            <DirNode key={child.label} node={child} depth={0} />
          ))}
        </Box>
      )}
    </Box>
  );
}

export function CommitFileTree({ rawDiff }: { rawDiff: string }) {
  const parsed = parseDiff(rawDiff);

  const files: DiffFile[] = parsed.map((f) => ({
    path: f.to && f.to !== "/dev/null" ? f.to : (f.from ?? ""),
    status: f.new ? "A" : f.deleted ? "D" : (f.from !== f.to && f.from && f.to ? "R" : "M"),
    additions: f.additions,
    deletions: f.deletions,
  })).filter((f) => f.path);

  if (files.length === 0) return null;

  const tree = buildTree(files);
  const topNodes = [...tree.children.values()].sort((a, b) => {
    const aIsDir = !a.file;
    const bIsDir = !b.file;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return a.label.localeCompare(b.label);
  });

  return (
    <Box>
      <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={8} style={{ letterSpacing: 0.5 }}>
        Files {files.length}
      </Text>
      <Box style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {topNodes.map((node) => (
          <DirNode key={node.label} node={node} depth={0} />
        ))}
      </Box>
    </Box>
  );
}
