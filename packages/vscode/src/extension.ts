import * as vscode from "vscode";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { GossamerPanel, AGENT_CLI, getConfiguredPort, waitForServer } from "./GossamerPanel.js";
import { watch } from "fs";
import { OnboardingPanel } from "./OnboardingPanel.js";
import { CheckpointTreeProvider, type CheckpointTreeItem } from "./CheckpointTreeProvider.js";
import { openCheckpointDiff, diffProvider, openCheckpointSummary, summaryProvider } from "./diffUtils.js";

/** Returns true if any agent process is running with cwd === repoPath. */
function isAgentRunning(repoPath: string): boolean {
  const sessionsDir = join(homedir(), ".claude", "sessions");
  try {
    for (const file of readdirSync(sessionsDir).filter((f) => f.endsWith(".json"))) {
      try {
        const s = JSON.parse(readFileSync(join(sessionsDir, file), "utf-8")) as { pid?: number; cwd?: string };
        if (s.cwd === repoPath && typeof s.pid === "number") {
          try {
            process.kill(s.pid, 0); // throws ESRCH if process is gone
            return true;
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ESRCH") return true; // EPERM = running but unpermitted
          }
        }
      } catch { /* skip malformed file */ }
    }
  } catch { /* sessions dir absent */ }
  return false;
}

export function activate(context: vscode.ExtensionContext) {
  const checkpointProvider = new CheckpointTreeProvider();

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("gossamer-diff", diffProvider),
    vscode.workspace.registerTextDocumentContentProvider("gossamer-summary", summaryProvider),
  );

  context.subscriptions.push(
    vscode.window.createTreeView("gossamer.checkpoints", {
      treeDataProvider: checkpointProvider,
      showCollapseAll: true,
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "gossamer.showCheckpointSummary",
      (checkpointId: string, text: string) => {
        openCheckpointSummary(checkpointId, text).catch(console.error);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      "gossamer.showCheckpointDiff",
      (checkpointId: string, filePath: string, port: number) => {
        openCheckpointDiff(port, checkpointId, filePath).catch(console.error);
      },
    ),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gossamer.searchSessions", () => {
      GossamerPanel.searchSessions();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gossamer.copyCheckpointId", (item: CheckpointTreeItem) => {
      if (item.kind === "checkpoint") {
        vscode.env.clipboard.writeText(item.cp.checkpointId);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("gossamer.copyCommitHash", (item: CheckpointTreeItem) => {
      if (item.kind === "checkpoint" && item.cp.commitHash) {
        vscode.env.clipboard.writeText(item.cp.commitHash);
      }
    }),
  );

  // Auto-open panel if a workspace folder has Entire enabled, otherwise onboard
  const entireWorkspace = findEntireWorkspace();
  if (entireWorkspace) {
    GossamerPanel.createOrShow(context, entireWorkspace, checkpointProvider).catch(console.error);
    checkEntireHooks(entireWorkspace);
    // Drive the checkpoints tree directly — independent of the panel's promise
    // chain, so the sidebar populates even if the panel construction fails or
    // is delayed for any reason.
    primeCheckpointsTree(context, checkpointProvider, entireWorkspace);
  } else if (vscode.workspace.workspaceFolders?.length) {
    OnboardingPanel.createOrShow(context, (ws) => {
      GossamerPanel.createOrShow(context, ws, checkpointProvider).catch(console.error);
      checkEntireHooks(ws);
      primeCheckpointsTree(context, checkpointProvider, ws);
    });
  }

  // Command to manually open the panel
  context.subscriptions.push(
    vscode.commands.registerCommand("gossamer.openPanel", () => {
      const ws = findEntireWorkspace();
      if (!ws) {
        vscode.window.showErrorMessage(
          "Gossamer: no workspace folder with .entire/settings.json found.",
        );
        return;
      }
      GossamerPanel.createOrShow(context, ws, checkpointProvider).catch(console.error);
    }),
  );

  // Toggle (minimize/restore) the main Gossamer panel
  context.subscriptions.push(
    vscode.commands.registerCommand("gossamer.togglePanel", () => {
      const ws = findEntireWorkspace();
      if (!ws) return;
      GossamerPanel.toggle(context, ws, checkpointProvider);
    }),
  );

  // Restart the gossamer server
  context.subscriptions.push(
    vscode.commands.registerCommand("gossamer.restartServer", () => {
      const ws = findEntireWorkspace();
      if (!ws) return;
      GossamerPanel.restart(ws);
      vscode.window.showInformationMessage("Gossamer: server restarting…");
    }),
  );

  // Rewind to a checkpoint via the checkpoints context menu
  context.subscriptions.push(
    vscode.commands.registerCommand("gossamer.rewindToCheckpoint", (item: CheckpointTreeItem) => {
      if (item.kind !== "checkpoint") return;
      const { checkpointId, repoPath } = { checkpointId: item.cp.checkpointId, repoPath: item.repoPath };
      const agentRunning = isAgentRunning(repoPath);
      const cmd = `${agentRunning ? "!" : ""}entire rewind ${checkpointId}`;
      if (agentRunning) {
        // Prefer an existing terminal; fall back to creating one
        const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal({ cwd: repoPath });
        terminal.show();
        terminal.sendText(cmd, true);
      } else {
        const terminal = vscode.window.createTerminal({ cwd: repoPath });
        terminal.show();
        terminal.sendText(cmd, true);
      }
    }),
  );

  // Focus the checkpoints sidebar
  context.subscriptions.push(
    vscode.commands.registerCommand("gossamer.focusSidebar", () => {
      vscode.commands.executeCommand("gossamer.checkpoints.focus");
    }),
  );

  // Manual refresh of the checkpoints tree (useful after a rebase or branch reset)
  context.subscriptions.push(
    vscode.commands.registerCommand("gossamer.refreshCheckpoints", () => {
      const ws = findEntireWorkspace();
      if (!ws) return;
      checkpointProvider.setBranchFromWorkspace(ws, getConfiguredPort()).catch(console.error);
    }),
  );

  // Watch for new workspace folders being added
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const ws = findEntireWorkspace();
      if (ws) GossamerPanel.createOrShow(context, ws, checkpointProvider).catch(console.error);
    }),
  );
}

export function deactivate() {
  GossamerPanel.dispose();
  OnboardingPanel.dispose();
}

/**
 * Wait for the Gossamer server to be reachable, then load the checkpoints tree
 * for the workspace's current branch and watch git refs for changes. Decoupled
 * from GossamerPanel so the sidebar works whether or not the panel is open.
 */
function primeCheckpointsTree(
  context: vscode.ExtensionContext,
  provider: CheckpointTreeProvider,
  workspacePath: string,
): void {
  const port = getConfiguredPort();
  const reload = () =>
    provider.setBranchFromWorkspace(workspacePath, port).catch(() => undefined);

  waitForServer(port).then(reload).catch((err) => {
    console.error("[Gossamer] checkpoints tree: server never came up:", err);
  });

  // Reload when HEAD changes (branch switch) or refs/heads is rewritten (new commits)
  try {
    const headWatcher = watch(join(workspacePath, ".git", "HEAD"), { persistent: false }, reload);
    context.subscriptions.push({ dispose: () => headWatcher.close() });
  } catch { /* HEAD missing — non-fatal */ }
  try {
    const refsWatcher = watch(join(workspacePath, ".git", "refs", "heads"), { persistent: false, recursive: true }, reload);
    context.subscriptions.push({ dispose: () => refsWatcher.close() });
  } catch { /* refs/heads missing — non-fatal */ }
}

function findEntireWorkspace(): string | undefined {
  return vscode.workspace.workspaceFolders
    ?.map((f) => f.uri.fsPath)
    .find((p) => existsSync(join(p, ".entire", "settings.json")));
}

/**
 * Check that the workspace has Entire properly configured:
 * 1. `.entire/` directory exists with settings.json
 * 2. `.claude/settings.json` contains Entire hooks
 *
 * Shows a warning popup if either is missing.
 */
function checkEntireHooks(repoPath: string): void {
  const entireSettingsPath = join(repoPath, ".entire", "settings.json");
  if (!existsSync(entireSettingsPath)) {
    vscode.window.showWarningMessage(
      "Gossamer: `.entire/settings.json` not found. Run `entire enable` in this workspace to start capturing sessions.",
      "Open Terminal",
    ).then((action) => {
      if (action === "Open Terminal") {
        const t = vscode.window.createTerminal({ cwd: repoPath, name: "Entire Setup" });
        t.show();
        t.sendText("entire enable", false);
      }
    });
    return;
  }

  // Check if .claude/settings.json has Entire hooks
  const claudeSettingsPath = join(repoPath, ".claude", "settings.json");
  if (!existsSync(claudeSettingsPath)) return; // No .claude/settings.json at all — nothing to warn about yet

  try {
    const raw = readFileSync(claudeSettingsPath, "utf8");
    const settings = JSON.parse(raw) as { hooks?: Record<string, unknown> };
    const hooks = settings?.hooks;
    if (!hooks) return; // No hooks section — user may not use hooks at all

    // Check if any hook command references "entire"
    const hooksStr = JSON.stringify(hooks);
    if (hooksStr.includes("entire")) return; // Entire hooks are present

    // hooks section exists but no Entire hooks — warn
    vscode.window.showWarningMessage(
      "Gossamer: Claude Code hooks exist but no Entire hooks were found. Session capture may not be active. Run `entire enable` to configure.",
      "Open Terminal",
    ).then((action) => {
      if (action === "Open Terminal") {
        const t = vscode.window.createTerminal({ cwd: repoPath, name: "Entire Setup" });
        t.show();
        t.sendText("entire enable", false);
      }
    });
  } catch {
    // Malformed settings — don't warn
  }
}
