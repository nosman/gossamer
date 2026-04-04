import * as vscode from "vscode";
import { existsSync } from "fs";
import { join } from "path";

export class OnboardingPanel {
  private static instance: OnboardingPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly onEntireDetected: (repoPath: string) => void;
  private watcher: vscode.Disposable | undefined;

  static createOrShow(
    context: vscode.ExtensionContext,
    onEntireDetected: (repoPath: string) => void,
  ): void {
    if (OnboardingPanel.instance) {
      OnboardingPanel.instance.panel.reveal();
      return;
    }
    OnboardingPanel.instance = new OnboardingPanel(context, onEntireDetected);
  }

  static dispose(): void {
    OnboardingPanel.instance?.panel.dispose();
  }

  private constructor(
    context: vscode.ExtensionContext,
    onEntireDetected: (repoPath: string) => void,
  ) {
    this.onEntireDetected = onEntireDetected;

    this.panel = vscode.window.createWebviewPanel(
      "gossamer.onboarding",
      "Gossamer",
      vscode.ViewColumn.One,
      { enableScripts: true },
    );

    this.panel.webview.html = this.getHtml();
    this.panel.webview.onDidReceiveMessage((msg: { type: string }) => {
      if (msg.type === "check") this.check();
    });
    this.panel.onDidDispose(() => {
      this.watcher?.dispose();
      OnboardingPanel.instance = undefined;
    });

    // Watch workspace folders for .entire/settings.json appearing
    this.watcher = vscode.workspace.onDidChangeWorkspaceFolders(() => this.check());
  }

  private check(): void {
    const ws = vscode.workspace.workspaceFolders
      ?.map((f) => f.uri.fsPath)
      .find((p) => existsSync(join(p, ".entire", "settings.json")));

    if (ws) {
      this.panel.dispose();
      this.onEntireDetected(ws);
    }
  }

  private getHtml(): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Gossamer</title>
  <style>
    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family), system-ui, sans-serif;
      font-size: var(--vscode-font-size, 13px);
      margin: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
    }
    .card {
      max-width: 480px;
      width: 100%;
      padding: 32px;
    }
    h1 {
      font-size: 18px;
      font-weight: 600;
      margin: 0 0 8px;
    }
    p {
      color: var(--vscode-descriptionForeground);
      line-height: 1.6;
      margin: 0 0 20px;
    }
    code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      background: var(--vscode-textCodeBlock-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 12px 16px;
      display: block;
      white-space: pre;
      margin: 0 0 20px;
    }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 2px;
      padding: 6px 14px;
      font-size: 13px;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <div class="card">
    <h1>Entire.io not detected</h1>
    <p>
      Gossamer requires <a href="https://entire.io">Entire.io</a> to be enabled in your workspace.
      Create <strong>.entire/settings.json</strong> at your project root to get started:
    </p>
    <code>{
  "enabled": true
}</code>
    <p>
      Once enabled, Entire.io will automatically capture Claude Code sessions
      in your repository.
    </p>
    <button id="btn">Check again</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('btn').addEventListener('click', () => {
      vscode.postMessage({ type: 'check' });
    });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () =>
    chars[Math.floor(Math.random() * chars.length)],
  ).join("");
}
