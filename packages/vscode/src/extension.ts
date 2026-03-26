import * as vscode from "vscode";
import { existsSync } from "fs";
import { join } from "path";
import { GossamerPanel } from "./GossamerPanel.js";

export function activate(context: vscode.ExtensionContext) {
  // Auto-open panel if a workspace folder has Entire enabled
  const entireWorkspace = findEntireWorkspace();
  if (entireWorkspace) {
    GossamerPanel.createOrShow(context, entireWorkspace).catch(console.error);
  }

  // Command to manually open the panel
  context.subscriptions.push(
    vscode.commands.registerCommand("gossamer.openPanel", () => {
      const ws = findEntireWorkspace();
      if (!ws) {
        vscode.window.showErrorMessage(
          "Gossamer: no workspace folder with .entire/settings.json found."
        );
        return;
      }
      GossamerPanel.createOrShow(context, ws).catch(console.error);
    })
  );

  // Watch for new workspace folders being added
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      const ws = findEntireWorkspace();
      if (ws) GossamerPanel.createOrShow(context, ws).catch(console.error);
    })
  );
}

export function deactivate() {
  GossamerPanel.dispose();
}

function findEntireWorkspace(): string | undefined {
  return vscode.workspace.workspaceFolders
    ?.map((f) => f.uri.fsPath)
    .find((p) => existsSync(join(p, ".entire", "settings.json")));
}
