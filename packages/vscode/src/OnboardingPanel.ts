import * as vscode from "vscode";
import { existsSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

type Step = "install-entire" | "configure-entire" | "done";

function checkEntireInstalled(): boolean {
  const r = spawnSync("which", ["entire"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim().length > 0;
}

function checkEntireConfigured(workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined): string | undefined {
  return workspaceFolders
    ?.map((f) => f.uri.fsPath)
    .find((p) => existsSync(join(p, ".entire", "settings.json")));
}

export class OnboardingPanel {
  private static instance: OnboardingPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly onEntireDetected: (repoPath: string) => void;
  private readonly context: vscode.ExtensionContext;
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
    this.context = context;

    this.panel = vscode.window.createWebviewPanel(
      "gossamer.onboarding",
      "Gossamer — Setup",
      vscode.ViewColumn.One,
      { enableScripts: true, enableFindWidget: true },
    );

    this.panel.webview.html = this.getHtml(this.currentStep());
    this.panel.webview.onDidReceiveMessage((msg: { type: string }) => {
      if (msg.type === "check") this.refresh();
      if (msg.type === "install_entire") this.runInTerminal("brew install entireio/tap/entire");
      if (msg.type === "configure_entire") this.runConfigureInWorkspace();
    });
    this.panel.onDidDispose(() => {
      this.watcher?.dispose();
      OnboardingPanel.instance = undefined;
    });

    this.watcher = vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh());
  }

  private currentStep(): Step {
    if (!checkEntireInstalled()) return "install-entire";
    const configured = checkEntireConfigured(vscode.workspace.workspaceFolders);
    if (!configured) return "configure-entire";
    return "done";
  }

  private refresh(): void {
    const step = this.currentStep();
    if (step === "done") {
      const ws = checkEntireConfigured(vscode.workspace.workspaceFolders)!;
      this.panel.dispose();
      this.onEntireDetected(ws);
      return;
    }
    this.panel.webview.html = this.getHtml(step);
  }

  private runInTerminal(cmd: string): void {
    const terminal = vscode.window.createTerminal("Gossamer Setup");
    terminal.show();
    terminal.sendText(cmd, false); // don't auto-run; let user review and press Enter
  }

  private runConfigureInWorkspace(): void {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const terminal = vscode.window.createTerminal({
      name: "Gossamer Setup",
      cwd: ws,
    });
    terminal.show();
    terminal.sendText("entire configure", false);
  }

  private getHtml(step: Step): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    const stepContent = step === "install-entire"
      ? this.stepInstallEntire()
      : this.stepConfigureEntire();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Gossamer Setup</title>
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
      min-height: 100vh;
    }
    .card {
      max-width: 520px;
      width: 100%;
      padding: 40px 32px;
    }
    .steps {
      display: flex;
      gap: 6px;
      margin-bottom: 28px;
      align-items: center;
    }
    .step-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--vscode-panel-border);
    }
    .step-dot.active {
      background: var(--vscode-button-background);
      width: 24px;
      border-radius: 4px;
    }
    .step-dot.done {
      background: var(--vscode-testing-iconPassed, #4caf50);
    }
    h1 {
      font-size: 18px;
      font-weight: 600;
      margin: 0 0 10px;
    }
    .subtitle {
      color: var(--vscode-descriptionForeground);
      line-height: 1.6;
      margin: 0 0 22px;
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
      margin: 0 0 22px;
    }
    .actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
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
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .note {
      margin-top: 18px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
    }
  </style>
</head>
<body>
  <div class="card">
    ${stepContent}
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('btn-check')?.addEventListener('click', () => vscode.postMessage({ type: 'check' }));
    document.getElementById('btn-install')?.addEventListener('click', () => vscode.postMessage({ type: 'install_entire' }));
    document.getElementById('btn-configure')?.addEventListener('click', () => vscode.postMessage({ type: 'configure_entire' }));
  </script>
</body>
</html>`;
  }

  private stepIndicator(active: 1 | 2): string {
    const s1 = active === 1 ? "active" : "done";
    const s2 = active === 2 ? "active" : "";
    return `<div class="steps">
      <div class="step-dot ${s1}"></div>
      <div class="step-dot ${s2}"></div>
    </div>`;
  }

  private stepInstallEntire(): string {
    return `
      ${this.stepIndicator(1)}
      <h1>Step 1 — Install Entire CLI</h1>
      <p class="subtitle">
        Gossamer requires the <strong>Entire CLI</strong> to capture and index your coding sessions.
        Install it with Homebrew:
      </p>
      <code>brew install entireio/tap/entire</code>
      <div class="actions">
        <button id="btn-install">Open terminal with install command</button>
        <button id="btn-check" class="secondary">Check again</button>
      </div>
      <p class="note">
        After installing, click <strong>Check again</strong> or run
        <code style="display:inline;padding:1px 4px;border-radius:3px">entire configure</code>
        in your project to continue.
      </p>`;
  }

  private stepConfigureEntire(): string {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "your project folder";
    return `
      ${this.stepIndicator(2)}
      <h1>Step 2 — Enable Entire in this workspace</h1>
      <p class="subtitle">
        Entire CLI is installed. Now run <strong>entire configure</strong> in your project
        to create <code style="display:inline;padding:1px 4px;border-radius:3px">.entire/settings.json</code>
        and set up session capture:
      </p>
      <code>cd ${ws}
entire configure</code>
      <div class="actions">
        <button id="btn-configure">Open terminal with configure command</button>
        <button id="btn-check" class="secondary">Check again</button>
      </div>
      <p class="note">
        Gossamer will open automatically once Entire is configured.
      </p>`;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () =>
    chars[Math.floor(Math.random() * chars.length)],
  ).join("");
}
