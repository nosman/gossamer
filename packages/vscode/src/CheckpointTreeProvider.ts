import * as vscode from "vscode";
import { get as httpGet } from "http";
import { join } from "path";

interface Checkpoint {
  checkpointId: string;
  createdAt: string | null;
  filesTouched: string[];
  summary: { intent: string } | null;
  commitMessage: string | null;
  commitHash: string | null;
}

interface BranchLogEntry extends Checkpoint {
  sessionId: string;
  branch: string | null;
}

export type CheckpointTreeItem =
  | { kind: "group";      label: string; checkpoints: Checkpoint[]; port: number; startIndex: number; repoPath: string }
  | { kind: "checkpoint"; cp: Checkpoint; port: number; index: number; repoPath: string }
  | { kind: "dir";        label: string; fullPath: string; absPath: string; children: CheckpointTreeItem[] }
  | { kind: "file";       name: string;  fullPath: string; absPath: string; checkpointId: string; port: number };

function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function buildItems(
  paths: string[],
  checkpointId: string,
  port: number,
  repoPath: string,
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
      const absPath  = join(repoPath, fullPath);
      if (node.isFile) {
        return { kind: "file", name, fullPath, absPath, checkpointId, port } as CheckpointTreeItem;
      }
      return { kind: "dir", label: name, fullPath, absPath, children: toItems(node.children, fullPath) } as CheckpointTreeItem;
    });
  }

  return toItems(root, "");
}

export class CheckpointTreeProvider
  implements vscode.TreeDataProvider<CheckpointTreeItem>
{
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private sessionCheckpoints: Checkpoint[] = [];
  private branchCheckpoints: Checkpoint[] = [];
  private currentBranch: string | null = null;
  private currentPort: number | null = null;
  private currentRepoPath: string = "";

  async setSession(sessionId: string, port: number): Promise<void> {
    this.currentPort = port;

    const sessionCheckpoints = await fetchJson<Checkpoint[]>(
      `http://localhost:${port}/api/v2/sessions/${encodeURIComponent(sessionId)}/checkpoints`,
    ).catch(() => [] as Checkpoint[]);

    const sessionIds = new Set(sessionCheckpoints.map((cp) => cp.checkpointId));

    let branchCheckpoints: Checkpoint[] = [];
    try {
      const sessionInfo = await fetchJson<{ cwd: string; branch: string | null }>(
        `http://localhost:${port}/api/sessions/${encodeURIComponent(sessionId)}`,
      );
      if (sessionInfo.cwd) this.currentRepoPath = sessionInfo.cwd;
      if (sessionInfo.cwd && sessionInfo.branch) {
        this.currentBranch = sessionInfo.branch;
        const log = await fetchJson<{ entries: BranchLogEntry[] }>(
          `http://localhost:${port}/api/branch-log?localPath=${encodeURIComponent(sessionInfo.cwd)}&branch=${encodeURIComponent(sessionInfo.branch)}`,
        );
        const seen = new Set<string>(sessionIds);
        for (const entry of log.entries) {
          if (!seen.has(entry.checkpointId)) {
            seen.add(entry.checkpointId);
            branchCheckpoints.push({
              checkpointId: entry.checkpointId,
              createdAt:    entry.createdAt,
              filesTouched: entry.filesTouched,
              summary:      entry.summary,
              commitMessage: entry.commitMessage,
              commitHash:   entry.commitHash,
            });
          }
        }
      }
    } catch { /* branch-log unavailable or repo not registered */ }

    this.sessionCheckpoints = sessionCheckpoints;
    this.branchCheckpoints  = branchCheckpoints;
    if (branchCheckpoints.length === 0) this.currentBranch = null;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: CheckpointTreeItem): vscode.TreeItem {
    if (element.kind === "group") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon("history");
      return item;
    }
    if (element.kind === "checkpoint") {
      const cp      = element.cp;
      const shortId = cp.checkpointId.slice(0, 8);
      const msg     = cp.commitMessage;
      const label   = msg
        ? (msg.length > 60 ? msg.slice(0, 59) + "…" : msg)
        : shortId;

      const collapsible = element.index === 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed;
      const item = new vscode.TreeItem(label, collapsible);

      const commitShort = cp.commitHash ? cp.commitHash.slice(0, 8) : null;
      item.description  = commitShort ? `${shortId} · ${commitShort}` : shortId;

      const tooltip = new vscode.MarkdownString("", true);
      tooltip.appendMarkdown(`**Checkpoint:** \`${cp.checkpointId}\`\n\n`);
      if (cp.commitHash) tooltip.appendMarkdown(`**Commit:** \`${cp.commitHash}\`\n\n`);
      if (msg) tooltip.appendMarkdown(msg);
      item.tooltip  = tooltip;
      item.iconPath = new vscode.ThemeIcon("git-commit");
      item.contextValue = "checkpoint";
      return item;
    }
    if (element.kind === "dir") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.resourceUri = vscode.Uri.file(element.absPath);
      return item;
    }
    // file
    const item = new vscode.TreeItem(element.name, vscode.TreeItemCollapsibleState.None);
    item.resourceUri = vscode.Uri.file(element.absPath);
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
      const port = this.currentPort;
      const repoPath = this.currentRepoPath;
      const groups: CheckpointTreeItem[] = [
        { kind: "group", label: "Session", checkpoints: this.sessionCheckpoints, port, startIndex: 0, repoPath },
      ];
      if (this.branchCheckpoints.length > 0) {
        const branchLabel = this.currentBranch
          ? `Branch History (${this.currentBranch})`
          : "Branch History";
        groups.push({
          kind: "group",
          label: branchLabel,
          checkpoints: this.branchCheckpoints,
          port,
          startIndex: this.sessionCheckpoints.length,
          repoPath,
        });
      }
      return groups;
    }
    if (element.kind === "group") {
      return element.checkpoints.map((cp, i) => ({
        kind: "checkpoint" as const,
        cp,
        port: element.port,
        index: element.startIndex + i,
        repoPath: element.repoPath,
      }));
    }
    if (element.kind === "checkpoint") {
      return buildItems(element.cp.filesTouched, element.cp.checkpointId, element.port, element.repoPath);
    }
    if (element.kind === "dir") {
      return element.children;
    }
    return [];
  }
}
