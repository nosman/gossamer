import * as vscode from "vscode";
import { get as httpGet } from "http";
import { join } from "path";

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

    // Fetch session info and checkpoints in parallel.
    const [allSessionCheckpoints, sessionInfo] = await Promise.all([
      fetchJson<Checkpoint[]>(
        `http://localhost:${port}/api/v2/sessions/${encodeURIComponent(sessionId)}/checkpoints`,
      ).catch(() => [] as Checkpoint[]),
      fetchJson<{ cwd: string; repoRoot: string | null; branch: string | null; updatedAt: string; isLive: boolean }>(
        `http://localhost:${port}/api/sessions/${encodeURIComponent(sessionId)}`,
      ).catch(() => ({ cwd: "", repoRoot: null, branch: null, updatedAt: "", isLive: false })),
    ]);

    // Prefer repoRoot (the server's known local path for this repo) over the
    // session's stored cwd, which may be from a different machine or empty
    // (e.g. when the first event is a permission-mode event with no cwd).
    const repoPath = sessionInfo.repoRoot ?? sessionInfo.cwd;
    if (repoPath) this.currentRepoPath = repoPath;

    // For completed sessions, restrict "Session" to checkpoints that were created
    // during the agent's active run (at or before the last log event, plus a small
    // buffer for indexing lag). Post-session commits tagged to the same session ID
    // by Entire are excluded here and will appear in Branch History instead.
    // Skip the filter when updatedAt is missing or clearly invalid (e.g. epoch
    // fallback from sessions whose LogEvents haven't been indexed yet).
    let sessionCheckpoints = allSessionCheckpoints;
    const updatedMs = sessionInfo.updatedAt ? new Date(sessionInfo.updatedAt).getTime() : 0;
    if (!sessionInfo.isLive && updatedMs > 1_000_000_000_000) {
      const cutoff = new Date(updatedMs + 2 * 60 * 1000);
      sessionCheckpoints = allSessionCheckpoints.filter(
        (cp) => !cp.createdAt || new Date(cp.createdAt) <= cutoff,
      );
    }

    // Deduplicate branch history against session checkpoints so each commit
    // appears in exactly one section.
    const sessionIds = new Set(sessionCheckpoints.map((cp) => cp.checkpointId));

    let branchCheckpoints: Checkpoint[] = [];
    try {
      if (repoPath && sessionInfo.branch) {
        this.currentBranch = sessionInfo.branch;
        const log = await fetchJson<{ entries: BranchLogEntry[] }>(
          `http://localhost:${port}/api/branch-log?localPath=${encodeURIComponent(repoPath)}&branch=${encodeURIComponent(sessionInfo.branch)}`,
        );

        // Build a message map from ALL branch-log entries before dedup, so session
        // checkpoints missing a commit message can fall back to the branch-log value.
        const branchMessageMap = new Map<string, string>();
        const branchHashMap    = new Map<string, string>();
        for (const entry of log.entries) {
          if (entry.commitMessage) branchMessageMap.set(entry.checkpointId, entry.commitMessage);
          if (entry.commitHash)    branchHashMap.set(entry.checkpointId, entry.commitHash);
        }

        // Enrich session checkpoints that have a null commit message.
        sessionCheckpoints = sessionCheckpoints.map((cp) => ({
          ...cp,
          commitMessage: cp.commitMessage ?? branchMessageMap.get(cp.checkpointId) ?? null,
          commitHash:    cp.commitHash    ?? branchHashMap.get(cp.checkpointId)    ?? null,
        }));

        const seen = new Set<string>(sessionIds);
        for (const entry of log.entries) {
          if (!seen.has(entry.checkpointId)) {
            seen.add(entry.checkpointId);
            branchCheckpoints.push({
              checkpointId:  entry.checkpointId,
              createdAt:     entry.createdAt,
              filesTouched:  entry.filesTouched,
              summary:       entry.summary,
              commitMessage: entry.commitMessage,
              commitHash:    entry.commitHash,
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
      const cp = element.cp;
      const SEP = "─".repeat(68);
      const section = (title: string, body: string) => `${SEP}\n${title}\n${SEP}\n${body}`;

      const lines: string[] = [];
      lines.push(`Checkpoint: ${cp.checkpointId}`);
      if (cp.createdAt) lines.push(`Created:    ${new Date(cp.createdAt).toLocaleString()}`);
      if (cp.commitHash) lines.push(`Commit:     ${cp.commitHash}${cp.commitMessage ? `  ${cp.commitMessage}` : ""}`);

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

      if (cp.filesTouched.length > 0) {
        lines.push("", section("Files Touched", cp.filesTouched.map((f) => `  ${f}`).join("\n")));
      }

      const summaryText = lines.join("\n").trimEnd();
      const summaryItem: CheckpointTreeItem = { kind: "summary", checkpointId: cp.checkpointId, text: summaryText };
      return [summaryItem, ...buildItems(cp.filesTouched, cp.checkpointId, element.port, element.repoPath)];
    }
    if (element.kind === "dir") {
      return element.children;
    }
    return [];
  }
}
