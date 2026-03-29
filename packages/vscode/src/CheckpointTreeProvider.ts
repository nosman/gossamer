import * as vscode from "vscode";
import { get as httpGet } from "http";

interface Checkpoint {
  checkpointId: string;
  createdAt: string | null;
  filesTouched: string[];
}

export type CheckpointTreeItem =
  | { kind: "checkpoint"; cp: Checkpoint; port: number }
  | { kind: "dir";        label: string;  fullPath: string; children: CheckpointTreeItem[] }
  | { kind: "file";       name: string;   fullPath: string; checkpointId: string; port: number };

function fetchCheckpoints(sessionId: string, port: number): Promise<Checkpoint[]> {
  return new Promise((resolve) => {
    const req = httpGet(
      `http://localhost:${port}/api/v2/sessions/${encodeURIComponent(sessionId)}/checkpoints`,
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch { resolve([]); }
        });
      },
    );
    req.on("error", () => resolve([]));
    req.setTimeout(5000, () => { req.destroy(); resolve([]); });
  });
}

function buildItems(
  paths: string[],
  checkpointId: string,
  port: number,
): CheckpointTreeItem[] {
  interface Node { children: Map<string, Node>; isFile: boolean; }
  const root = new Map<string, Node>();

  for (const p of paths) {
    const parts = p.split("/");
    let nodes = root;
    for (let i = 0; i < parts.length; i++) {
      if (!nodes.has(parts[i])) {
        nodes.set(parts[i], { children: new Map(), isFile: i === parts.length - 1 });
      }
      nodes = nodes.get(parts[i])!.children;
    }
  }

  function toItems(nodes: Map<string, Node>, prefix: string): CheckpointTreeItem[] {
    return Array.from(nodes.entries()).map(([name, node]) => {
      const fullPath = prefix ? `${prefix}/${name}` : name;
      if (node.isFile) {
        return { kind: "file", name, fullPath, checkpointId, port } as CheckpointTreeItem;
      }
      return { kind: "dir", label: name, fullPath, children: toItems(node.children, fullPath) } as CheckpointTreeItem;
    });
  }

  return toItems(root, "");
}

export class CheckpointTreeProvider
  implements vscode.TreeDataProvider<CheckpointTreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private checkpoints: Checkpoint[] = [];
  private currentPort: number | null = null;

  async setSession(sessionId: string, port: number): Promise<void> {
    this.currentPort = port;
    this.checkpoints = await fetchCheckpoints(sessionId, port);
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: CheckpointTreeItem): vscode.TreeItem {
    if (element.kind === "checkpoint") {
      const shortId = element.cp.checkpointId.slice(0, 8);
      const item = new vscode.TreeItem(shortId, vscode.TreeItemCollapsibleState.Expanded);
      item.description = element.cp.createdAt
        ? new Date(element.cp.createdAt).toLocaleTimeString()
        : undefined;
      item.iconPath = new vscode.ThemeIcon("git-commit");
      item.contextValue = "checkpoint";
      return item;
    }
    if (element.kind === "dir") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon("folder");
      item.resourceUri = vscode.Uri.file(element.fullPath);
      return item;
    }
    // file
    const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
    item.iconPath = vscode.ThemeIcon.File;
    item.resourceUri = vscode.Uri.file(element.fullPath);
    item.tooltip = element.fullPath;
    item.command = {
      command: "gossamer.showCheckpointDiff",
      title: "Show Diff",
      arguments: [element.checkpointId, element.fullPath, element.port],
    };
    return item;
  }

  getChildren(element?: CheckpointTreeItem): vscode.ProviderResult<CheckpointTreeItem[]> {
    if (!element) {
      if (!this.currentPort) return [];
      return this.checkpoints.map((cp) => ({ kind: "checkpoint", cp, port: this.currentPort! }));
    }
    if (element.kind === "checkpoint") {
      return buildItems(element.cp.filesTouched, element.cp.checkpointId, element.port);
    }
    if (element.kind === "dir") {
      return element.children;
    }
    return [];
  }
}
