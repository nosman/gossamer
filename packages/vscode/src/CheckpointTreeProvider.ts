import * as vscode from "vscode";
import { get as httpGet } from "http";
import { join } from "path";
import { execFileSync } from "child_process";

interface CheckpointSummary {
  intent: string;
  outcome: string;
  openItems: { text: string; status: string }[];
  friction: string[];
  repoLearnings: string[];
  codeLearnings: { path: string; finding: string }[];
  workflowLearnings: string[];
}

interface Checkpoint {
  checkpointId: string;
  createdAt: string | null;
  filesTouched: string[];
  summary: CheckpointSummary | null;
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
  | { kind: "summary";    checkpointId: string; text: string }
  | { kind: "dir";        label: string; fullPath: string; absPath: string; children: CheckpointTreeItem[] }
  | { kind: "file";       name: string;  fullPath: string; absPath: string; checkpointId: string; port: number }
  | { kind: "note";       label: string };

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

/**
 * Fire-and-forget warm-up of the server-side file-pair cache. By the time the
 * user clicks the file, both `git show` calls have already run and their
 * output is sitting in the server's LRU.
 */
function prefetchFilePair(port: number, checkpointId: string, filePath: string): void {
  const url = `http://localhost:${port}/api/v2/checkpoints/${encodeURIComponent(checkpointId)}/file-pair?path=${encodeURIComponent(filePath)}`;
  const req = httpGet(url, (res) => { res.resume(); });
  req.on("error", () => undefined);
  req.setTimeout(15_000, () => req.destroy());
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
  private branchLoadGen = 0;

  /**
   * Load checkpoints for an explicit (repoPath, branch) pair. The caller is
   * responsible for picking the right branch — typically the workspace's
   * current HEAD, but a fork tool or the like could pass a different one.
   */
  async setBranch(repoPath: string, branch: string, port: number): Promise<void> {
    // Drop stale results: when the user switches branches faster than the
    // fetch completes, only the latest call should commit its results.
    const gen = ++this.branchLoadGen;
    this.currentPort = port;
    this.currentRepoPath = repoPath;
    this.currentBranch = branch;

    try {
      const log = await fetchJson<{ entries: BranchLogEntry[] }>(
        `http://localhost:${port}/api/branch-log?localPath=${encodeURIComponent(repoPath)}&branch=${encodeURIComponent(branch)}`,
      );
      if (gen !== this.branchLoadGen) return; // a newer load supersedes us
      const seen = new Set<string>();
      const entries: Checkpoint[] = [];
      for (const entry of log.entries) {
        if (seen.has(entry.checkpointId)) continue;
        seen.add(entry.checkpointId);
        entries.push({
          checkpointId:  entry.checkpointId,
          createdAt:     entry.createdAt,
          filesTouched:  entry.filesTouched,
          summary:       entry.summary,
          commitMessage: entry.commitMessage,
          commitHash:    entry.commitHash,
        });
      }
      this.branchCheckpoints = entries;
    } catch {
      if (gen !== this.branchLoadGen) return;
      this.branchCheckpoints = [];
    }
    this._onDidChangeTreeData.fire();
  }

  /** Convenience: detect the workspace's current HEAD branch and load it. */
  async setBranchFromWorkspace(repoPath: string, port: number): Promise<void> {
    let branch: string;
    try {
      branch = execFileSync("git", ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      this.currentPort = port;
      this.currentRepoPath = repoPath;
      this.branchCheckpoints = [];
      this.currentBranch = null;
      this._onDidChangeTreeData.fire();
      return;
    }
    if (!branch) return;
    return this.setBranch(repoPath, branch, port);
  }

  /**
   * Populate the "Session" group with checkpoints from a specific session.
   * Does NOT touch the branch group — that's owned by setBranch / the
   * workspace's current branch and shouldn't change just because the user
   * focused a different session.
   */
  async setSession(sessionId: string, port: number): Promise<void> {
    this.currentPort = port;

    const [allSessionCheckpoints, sessionInfo] = await Promise.all([
      fetchJson<Checkpoint[]>(
        `http://localhost:${port}/api/v2/sessions/${encodeURIComponent(sessionId)}/checkpoints`,
      ).catch(() => [] as Checkpoint[]),
      fetchJson<{ cwd: string; repoRoot: string | null; branch: string | null; updatedAt: string; isLive: boolean }>(
        `http://localhost:${port}/api/sessions/${encodeURIComponent(sessionId)}`,
      ).catch(() => ({ cwd: "", repoRoot: null, branch: null, updatedAt: "", isLive: false })),
    ]);

    // Restrict to checkpoints created during the agent's active run (plus a
    // 2-minute buffer for indexing lag). Skip when updatedAt is the epoch
    // fallback for unindexed sessions.
    let sessionCheckpoints = allSessionCheckpoints;
    const updatedMs = sessionInfo.updatedAt ? new Date(sessionInfo.updatedAt).getTime() : 0;
    if (!sessionInfo.isLive && updatedMs > 1_000_000_000_000) {
      const cutoff = new Date(updatedMs + 2 * 60 * 1000);
      sessionCheckpoints = allSessionCheckpoints.filter(
        (cp) => !cp.createdAt || new Date(cp.createdAt) <= cutoff,
      );
    }

    this.sessionCheckpoints = sessionCheckpoints;
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
    if (element.kind === "summary") {
      const item = new vscode.TreeItem("summary.txt", vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("note");
      item.tooltip = element.text;
      item.command = {
        command: "gossamer.showCheckpointSummary",
        title: "Show Summary",
        arguments: [element.checkpointId, element.text],
      };
      return item;
    }
    if (element.kind === "dir") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.Expanded);
      item.resourceUri = vscode.Uri.file(element.absPath);
      return item;
    }
    if (element.kind === "note") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon("info");
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
      if (!this.currentPort) return [{ kind: "note", label: "Waiting for Gossamer server…" }];
      const port = this.currentPort;
      const repoPath = this.currentRepoPath;
      const groups: CheckpointTreeItem[] = [];
      if (this.sessionCheckpoints.length > 0) {
        groups.push({ kind: "group", label: "Session", checkpoints: this.sessionCheckpoints, port, startIndex: 0, repoPath });
      }
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
      } else if (this.currentBranch) {
        // Make it obvious the load ran and produced nothing, so the user can
        // distinguish "no data" from "code didn't run".
        groups.push({ kind: "note", label: `No checkpoints on ${this.currentBranch}` });
      } else {
        groups.push({ kind: "note", label: "No branch detected for the workspace" });
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
      const cp = element.cp;
      const SEP = "─".repeat(68);
      const section = (title: string, body: string) => `${SEP}\n${title}\n${SEP}\n${body}`;

      const lines: string[] = [];
      lines.push(`Checkpoint: ${cp.checkpointId}`);
      if (cp.createdAt) lines.push(`Created:    ${new Date(cp.createdAt).toLocaleString()}`);
      if (cp.commitHash) lines.push(`Commit:     ${cp.commitHash}${cp.commitMessage ? `  ${cp.commitMessage}` : ""}`);

      // Files first — most useful at-a-glance signal, right under the commit line.
      if (cp.filesTouched.length > 0) {
        lines.push("", section("Files Touched", cp.filesTouched.map((f) => `  ${f}`).join("\n")));
      }

      const s = cp.summary;
      if (s) {
        if (s.intent)  lines.push("", section("Intent", s.intent));
        if (s.outcome) lines.push("", section("Outcome", s.outcome));
        if (s.openItems.length > 0) {
          const body = s.openItems.map((o) => `[${o.status.padEnd(11)}] ${o.text}`).join("\n");
          lines.push("", section("Open Items", body));
        }
        if (s.friction.length > 0) {
          lines.push("", section("Friction", s.friction.map((f) => `• ${f}`).join("\n")));
        }
        if (s.repoLearnings.length > 0) {
          lines.push("", section("Repo Learnings", s.repoLearnings.map((r) => `• ${r}`).join("\n")));
        }
        if (s.codeLearnings.length > 0) {
          const body = s.codeLearnings.map((c) => `${c.path}\n  ${c.finding}`).join("\n\n");
          lines.push("", section("Code Learnings", body));
        }
        if (s.workflowLearnings.length > 0) {
          lines.push("", section("Workflow Learnings", s.workflowLearnings.map((w) => `• ${w}`).join("\n")));
        }
      }

      const summaryText = lines.join("\n").trimEnd();
      const summaryItem: CheckpointTreeItem = { kind: "summary", checkpointId: cp.checkpointId, text: summaryText };
      // Warm the server-side file-pair cache for every touched file so that
      // clicking any of them is instant. Files cap at ~50 to avoid overwhelming
      // git on huge checkpoints.
      const PREFETCH_LIMIT = 50;
      for (const f of cp.filesTouched.slice(0, PREFETCH_LIMIT)) {
        prefetchFilePair(element.port, cp.checkpointId, f);
      }
      return [summaryItem, ...buildItems(cp.filesTouched, cp.checkpointId, element.port, element.repoPath)];
    }
    if (element.kind === "dir") {
      return element.children;
    }
    return [];
  }
}
