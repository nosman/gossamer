import * as vscode from "vscode";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, basename } from "path";
import { spawnSync } from "child_process";

type Step = "install-entire" | "configure-entire" | "configure-checkpoint-remote" | "done";

function checkEntireInstalled(): boolean {
  const r = spawnSync("which", ["entire"], { encoding: "utf8" });
  return r.status === 0 && r.stdout.trim().length > 0;
}

function checkEntireConfigured(workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined): string | undefined {
  return workspaceFolders
    ?.map((f) => f.uri.fsPath)
    .find((p) => existsSync(join(p, ".entire", "settings.json")));
}

function checkCheckpointRemoteConfigured(repoPath: string): boolean {
  try {
    const settings = join(repoPath, ".entire", "settings.json");
    const json = JSON.parse(readFileSync(settings, "utf8"));
    return !!json?.strategy_options?.checkpoint_remote;
  } catch {
    return false;
  }
}

export class OnboardingPanel {
  private static instance: OnboardingPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly onEntireDetected: (repoPath: string) => void;
  private readonly context: vscode.ExtensionContext;
  private watcher: vscode.Disposable | undefined;
  private checkpointRemoteSkipped = false;

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
    this.panel.webview.onDidReceiveMessage((msg: { type: string; repoRef?: string }) => {
      if (msg.type === "check") this.refresh();
      if (msg.type === "install_entire") this.runInTerminal("brew install entire/tap/entire");
      if (msg.type === "configure_entire") this.runConfigureInWorkspace();
      if (msg.type === "configure_checkpoint_remote") this.runConfigureCheckpointRemote(msg.repoRef ?? "");
      if (msg.type === "create_local_checkpoint_repo") this.runCreateLocalCheckpointRepo();
      if (msg.type === "skip_checkpoint_remote") {
        this.checkpointRemoteSkipped = true;
        this.refresh();
      }
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
    if (!this.checkpointRemoteSkipped && !checkCheckpointRemoteConfigured(configured)) {
      return "configure-checkpoint-remote";
    }
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
    terminal.sendText(cmd, false);
  }

  private runConfigureInWorkspace(): void {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const terminal = vscode.window.createTerminal({ name: "Gossamer Setup", cwd: ws });
    terminal.show();
    terminal.sendText("entire configure", false);
  }

  private runConfigureCheckpointRemote(repoRef: string): void {
    if (!repoRef.trim()) return;
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const terminal = vscode.window.createTerminal({ name: "Gossamer Setup", cwd: ws });
    terminal.show();
    terminal.sendText(`entire enable --checkpoint-remote ${repoRef.trim()}`, false);
  }

  private runCreateLocalCheckpointRepo(): void {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const repoName = ws ? basename(ws) : "checkpoints";
    const localRepoPath = join(homedir(), ".gossamer", "checkpoints", `${repoName}.git`);
    const terminal = vscode.window.createTerminal({ name: "Gossamer Setup", cwd: ws });
    terminal.show();
    terminal.sendText(
      `git init --bare ${JSON.stringify(localRepoPath)} && entire enable --checkpoint-remote ${JSON.stringify(localRepoPath)}`,
      false,
    );
  }

  private getHtml(step: Step): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';`;

    const stepContent = step === "install-entire"
      ? this.stepInstallEntire()
      : step === "configure-entire"
      ? this.stepConfigureEntire()
      : this.stepConfigureCheckpointRemote();

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
      max-width: 560px;
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
    .options {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 22px;
    }
    .option {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 14px 16px;
      cursor: pointer;
      transition: border-color 0.1s;
    }
    .option:hover { border-color: var(--vscode-button-background); }
    .option.selected { border-color: var(--vscode-button-background); background: var(--vscode-list-activeSelectionBackground, rgba(255,255,255,0.05)); }
    .option-title { font-weight: 600; margin-bottom: 3px; }
    .option-desc { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .input-row {
      display: none;
      margin-top: 10px;
    }
    .input-row.visible { display: flex; gap: 8px; }
    input[type="text"] {
      flex: 1;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 2px;
      padding: 5px 8px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
    }
    input[type="text"]:focus { outline: 1px solid var(--vscode-focusBorder); }
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
    document.getElementById('btn-skip-remote')?.addEventListener('click', () => vscode.postMessage({ type: 'skip_checkpoint_remote' }));

    // Checkpoint remote option selection
    const optGithub = document.getElementById('opt-github');
    const optLocal  = document.getElementById('opt-local');
    const inputRow  = document.getElementById('github-input-row');
    const btnRemote = document.getElementById('btn-configure-remote');

    if (optGithub && optLocal) {
      optGithub.addEventListener('click', () => {
        optGithub.classList.add('selected');
        optLocal.classList.remove('selected');
        inputRow.classList.add('visible');
        btnRemote.textContent = 'Open terminal with command';
        btnRemote.dataset.action = 'github';
      });
      optLocal.addEventListener('click', () => {
        optLocal.classList.add('selected');
        optGithub.classList.remove('selected');
        inputRow.classList.remove('visible');
        btnRemote.textContent = 'Open terminal with command';
        btnRemote.dataset.action = 'local';
      });
      btnRemote?.addEventListener('click', () => {
        const action = btnRemote.dataset.action;
        if (action === 'github') {
          const ref = document.getElementById('github-ref-input').value.trim();
          if (!ref) { document.getElementById('github-ref-input').focus(); return; }
          vscode.postMessage({ type: 'configure_checkpoint_remote', repoRef: ref });
        } else if (action === 'local') {
          vscode.postMessage({ type: 'create_local_checkpoint_repo' });
        }
      });
    }
  </script>
</body>
</html>`;
  }

  private stepIndicator(active: 1 | 2 | 3): string {
    const cls = (n: number) =>
      n < active ? "done" : n === active ? "active" : "";
    return `<div class="steps">
      <div class="step-dot ${cls(1)}"></div>
      <div class="step-dot ${cls(2)}"></div>
      <div class="step-dot ${cls(3)}"></div>
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
      <code>brew install entire/tap/entire</code>
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

  private stepConfigureCheckpointRemote(): string {
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    const repoName = ws ? basename(ws) : "my-project";
    const localPath = `~/.gossamer/checkpoints/${repoName}.git`;
    return `
      ${this.stepIndicator(3)}
      <h1>Step 3 — Checkpoint backup (optional)</h1>
      <p class="subtitle">
        Entire can push your checkpoint branch to a <strong>separate repo</strong>, keeping
        your AI session history private or backed up independently of your main codebase.
      </p>
      <div class="options">
        <div class="option" id="opt-github">
          <div class="option-title">Use a GitHub repo</div>
          <div class="option-desc">Push checkpoints to a private GitHub repo you control.</div>
          <div class="input-row" id="github-input-row">
            <input type="text" id="github-ref-input" placeholder="github:owner/repo" spellcheck="false" />
          </div>
        </div>
        <div class="option" id="opt-local">
          <div class="option-title">Create a local backup repo</div>
          <div class="option-desc">Store checkpoints in a bare git repo at <code style="display:inline;padding:1px 4px;border-radius:3px">${localPath}</code> — no remote required.</div>
        </div>
      </div>
      <div class="actions">
        <button id="btn-configure-remote" data-action="">Open terminal with command</button>
        <button id="btn-skip-remote" class="secondary">Skip for now</button>
      </div>
      <p class="note">
        You can configure this later with <code style="display:inline;padding:1px 4px;border-radius:3px">entire enable --checkpoint-remote &lt;ref&gt;</code>.
      </p>`;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () =>
    chars[Math.floor(Math.random() * chars.length)],
  ).join("");
}
