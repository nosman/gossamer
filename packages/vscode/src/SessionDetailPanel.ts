import * as vscode from "vscode";
import { existsSync } from "fs";
import { dirname } from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";
import { openCheckpointDiff } from "./diffUtils.js";
import { CheckpointTreeProvider } from "./CheckpointTreeProvider.js";
import { AGENT_CLI } from "./GossamerPanel.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export class SessionDetailPanel {
  private static panels = new Map<string, SessionDetailPanel>();

  static createOrShow(
    context: vscode.ExtensionContext,
    sessionId: string,
    title: string,
    port: number,
    checkpointProvider: CheckpointTreeProvider,
    highlight?: string,
  ): void {
    const existing = SessionDetailPanel.panels.get(sessionId);
    if (existing) {
      existing.panel.reveal();
      checkpointProvider.setSession(sessionId, port).catch(console.error);
      return;
    }
    const shortTitle = title.length > 40 ? title.slice(0, 39) + "…" : title;
    new SessionDetailPanel(context, sessionId, shortTitle, port, checkpointProvider, highlight);
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(
    context: vscode.ExtensionContext,
    sessionId: string,
    title: string,
    port: number,
    checkpointProvider: CheckpointTreeProvider,
    highlight?: string,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      `gossamer.session.${sessionId}`,
      title,
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        enableFindWidget: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "dist", "webview"),
        ],
      },
    );

    this.panel.webview.html = this.getHtml(context, sessionId, title, port, highlight);
    checkpointProvider.setSession(sessionId, port).catch(console.error);

    // Update sidebar whenever this tab is brought into focus
    this.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        checkpointProvider.setSession(sessionId, port).catch(console.error);
      }
    });

    this.panel.webview.onDidReceiveMessage(
      (msg: { type: string; checkpointId?: string; filePath?: string; sessionId?: string; cwd?: string; agent?: string; branch?: string; title?: string }) => {
        if (msg.type === "update_tab_title" && typeof msg.title === "string" && msg.title.trim()) {
          const next = msg.title.length > 40 ? msg.title.slice(0, 39) + "…" : msg.title;
          if (next !== this.panel.title) this.panel.title = next;
        }
        if (msg.type === "show_checkpoint_diff" && msg.checkpointId && msg.filePath) {
          openCheckpointDiff(port, msg.checkpointId, msg.filePath).catch(console.error);
        }
        if (msg.type === "resume_session" && msg.sessionId) {
          const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const cwdExists = msg.cwd ? existsSync(msg.cwd) : false;

          if (!cwdExists && msg.branch) {
            // Session is from a machine/path that doesn't exist locally.
            // Use `entire resume <branch>` — but only if that branch is checked out.
            let currentBranch: string | undefined;
            try {
              const root = workspaceRoot ?? msg.cwd ?? ".";
              currentBranch = execFileSync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
            } catch { /* not a git repo or git unavailable */ }

            if (currentBranch === msg.branch) {
              const terminal = vscode.window.createTerminal({ name: title, cwd: workspaceRoot });
              terminal.show();
              terminal.sendText(`entire resume ${msg.branch}`, true);
            } else {
              const branchLabel = msg.branch;
              const currentLabel = currentBranch ?? "unknown";
              vscode.window.showWarningMessage(
                `Cannot resume: session is from branch "${branchLabel}" but "${currentLabel}" is checked out. Switch to "${branchLabel}" first.`,
              );
            }
          } else {
            const agentEntry = msg.agent ? AGENT_CLI[msg.agent] : undefined;
            const bin        = agentEntry?.bin        ?? "claude";
            const resumeFlag = agentEntry?.resumeFlag ?? "--resume";
            const terminal = vscode.window.createTerminal({ name: title, cwd: workspaceRoot ?? (msg.cwd || undefined) });
            terminal.show();
            terminal.sendText(`${bin} ${resumeFlag} ${msg.sessionId}`, true);
          }
        }
      },
    );
    this.panel.onDidDispose(() => SessionDetailPanel.panels.delete(sessionId));
    SessionDetailPanel.panels.set(sessionId, this);
  }

  private getHtml(
    context: vscode.ExtensionContext,
    sessionId: string,
    title: string,
    port: number,
    highlight?: string,
  ): string {
    const webview   = this.panel.webview;
    const distUri   = vscode.Uri.joinPath(context.extensionUri, "dist", "webview");
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "assets", "index.js"));
    const styleUri  = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "assets", "index.css"));
    const nonce     = getNonce();
    const safeTitle = title.replace(/</g, "&lt;").replace(/>/g, "&gt;");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src http://localhost:${port} ws://localhost:${port}; img-src data: https: http:;" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>${safeTitle}</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
    window.__GOSSAMER_PORT__         = ${port};
    window.__GOSSAMER_SESSION_ID__    = ${JSON.stringify(sessionId)};
    window.__GOSSAMER_SESSION_TITLE__ = ${JSON.stringify(title)};
    window.__GOSSAMER_HIGHLIGHT__     = ${JSON.stringify(highlight ?? "")};
  </script>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
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
