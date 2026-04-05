import * as vscode from "vscode";
import { existsSync } from "fs";
import { join } from "path";
import { GossamerPanel } from "./GossamerPanel.js";
import { OnboardingPanel } from "./OnboardingPanel.js";
import { CheckpointTreeProvider, type CheckpointTreeItem } from "./CheckpointTreeProvider.js";
import { openCheckpointDiff, diffProvider } from "./diffUtils.js";

export function activate(context: vscode.ExtensionContext) {
  const checkpointProvider = new CheckpointTreeProvider();

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("gossamer-diff", diffProvider),
  );

  context.subscriptions.push(
    vscode.window.createTreeView("gossamer.checkpoints", {
      treeDataProvider: checkpointProvider,
      showCollapseAll: true,
    }),
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
  } else if (vscode.workspace.workspaceFolders?.length) {
    OnboardingPanel.createOrShow(context, (ws) => {
      GossamerPanel.createOrShow(context, ws, checkpointProvider).catch(console.error);
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

  // Focus the checkpoints sidebar
  context.subscriptions.push(
    vscode.commands.registerCommand("gossamer.focusSidebar", () => {
      vscode.commands.executeCommand("gossamer.checkpoints.focus");
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

function findEntireWorkspace(): string | undefined {
  return vscode.workspace.workspaceFolders
    ?.map((f) => f.uri.fsPath)
    .find((p) => existsSync(join(p, ".entire", "settings.json")));
}
