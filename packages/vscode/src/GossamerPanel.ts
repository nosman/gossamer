import * as vscode from "vscode";
import { spawn, ChildProcess } from "child_process";
import { watch, FSWatcher, existsSync } from "fs";
import { join, resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { createServer } from "net";
import { get as httpGet, request as httpRequest } from "http";
import { execFileSync, execFile } from "child_process";
import { promisify } from "util";
import { SessionDetailPanel } from "./SessionDetailPanel.js";
import { openCheckpointDiff } from "./diffUtils.js";
import { CheckpointTreeProvider } from "./CheckpointTreeProvider.js";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));

// Path to the gossamer server entry point (dist/serve.js at the repo root)
const SERVE_SCRIPT = resolve(__dirname, "../../../dist/serve.js");

// Use the system node, not VS Code's bundled Electron node
function getSystemNode(): string {
  try {
    return execFileSync("which", ["node"], { encoding: "utf8" }).trim();
  } catch {
    return "node"; // fall back to PATH lookup
  }
}

/** Probe the server once; resolves true if it responds, false otherwise. */
function probeServer(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = httpGet(`http://localhost:${port}/api/sessions`, (res) => {
      res.destroy();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(500, () => { req.destroy(); resolve(false); });
  });
}

/** Poll until the server responds or we time out (default 30s). */
async function waitForServer(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeServer(port)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Gossamer server did not start within 30s");
}

function getFreePort(): Promise<number> {
  return new Promise((res) => {
    const srv = createServer();
    srv.listen(0, () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => res(port));
    });
  });
}

function httpGetJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = httpGet(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

function httpPostJson<T>(url: string, body: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = new URL(url);
    const req = httpRequest({
      hostname: opts.hostname,
      port: opts.port,
      path: opts.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as T); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

export class GossamerPanel {
  private static instance: GossamerPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly repoPath: string;
  private readonly port: number;
  private readonly checkpointProvider: CheckpointTreeProvider;
  private server: ChildProcess | undefined;
  private watcher: FSWatcher | undefined;
  private disposables: vscode.Disposable[] = [];
  private serverReady = false;

  static async createOrShow(context: vscode.ExtensionContext, repoPath: string, checkpointProvider: CheckpointTreeProvider) {
    if (GossamerPanel.instance) {
      GossamerPanel.instance.panel.reveal();
      return;
    }
    const port = await getFreePort();
    GossamerPanel.instance = new GossamerPanel(context, repoPath, port, checkpointProvider);
  }

  static dispose() {
    GossamerPanel.instance?.cleanup();
    GossamerPanel.instance = undefined;
  }

  private constructor(context: vscode.ExtensionContext, repoPath: string, port: number, checkpointProvider: CheckpointTreeProvider) {
    this.context            = context;
    this.repoPath           = repoPath;
    this.port               = port;
    this.checkpointProvider = checkpointProvider;

    this.panel = vscode.window.createWebviewPanel(
      "gossamer",
      "Gossamer",
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "dist", "webview"),
        ],
      },
    );

    this.spawnServer();
    this.panel.webview.html = this.getWebviewHtml(context);
    this.panel.onDidDispose(() => this.cleanup(), undefined, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      (msg: { type: string; sessionId?: string; title?: string; checkpointId?: string; filePath?: string }) => {
        if (msg.type === "open_session" && msg.sessionId) {
          SessionDetailPanel.createOrShow(this.context, msg.sessionId, msg.title ?? msg.sessionId.slice(0, 8), this.port, this.checkpointProvider);
        }
        if (msg.type === "show_checkpoint_diff" && msg.checkpointId && msg.filePath) {
          openCheckpointDiff(this.port, msg.checkpointId, msg.filePath).catch(console.error);
        }
        if (msg.type === "new_session") {
          this.promptAndSpawnSession().catch(console.error);
        }
      },
      undefined,
      this.disposables,
    );
    this.watchGitBranch();

    // Signal the webview once the server is accepting requests.
    // Also re-signal on visibility changes (e.g. tab moved to a new window causes a reload).
    this.panel.onDidChangeViewState(
      (e) => { if (e.webviewPanel.visible && this.serverReady) this.panel.webview.postMessage({ type: "server_ready" }); },
      undefined,
      this.disposables,
    );
    waitForServer(this.port)
      .then(() => this.ensureRepoRegistered())
      .then(() => { this.serverReady = true; return this.panel.webview.postMessage({ type: "server_ready" }); })
      .catch((err) => this.panel.webview.postMessage({ type: "server_error", error: String(err) }));
  }

  private spawnServer() {
    if (!existsSync(SERVE_SCRIPT)) {
      const msg = `Gossamer server script not found at ${SERVE_SCRIPT}. Run \`npm run build\` in the gossamer repo root first.`;
      console.error("[Gossamer]", msg);
      vscode.window.showErrorMessage(msg);
      return;
    }

    const nodeExec = getSystemNode();
    console.log(`[Gossamer] spawning: ${nodeExec} ${SERVE_SCRIPT} --repo-dir ${this.repoPath} --port ${this.port}`);

    this.server = spawn(nodeExec, [SERVE_SCRIPT, "--repo-dir", this.repoPath, "--port", String(this.port)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    this.server.stdout?.on("data", (d: Buffer) => {
      console.log("[Gossamer server stdout]", d.toString().trim());
    });
    this.server.stderr?.on("data", (d: Buffer) => {
      console.error("[Gossamer server stderr]", d.toString().trim());
    });
    this.server.on("error", (err) => {
      console.error("[Gossamer] failed to spawn server:", err.message);
      vscode.window.showErrorMessage(`Gossamer: failed to start server — ${err.message}`);
    });
    this.server.on("exit", (code, signal) => {
      console.log(`[Gossamer server] exited code=${code} signal=${signal}`);
    });
  }

  private async promptAndSpawnSession(): Promise<void> {
    const prompt = await vscode.window.showInputBox({
      title: "New Claude Session",
      prompt: "What do you want Claude to do?",
      placeHolder: "Describe the task…",
      ignoreFocusOut: true,
    });
    if (!prompt) return;

    const name = await vscode.window.showInputBox({
      title: "Session Name (optional)",
      prompt: "Give this session a name, or press Enter to skip",
      placeHolder: "e.g. refactor auth module",
      ignoreFocusOut: true,
    });

    const escaped = prompt.replace(/"/g, '\\"');
    const terminal = vscode.window.createTerminal({
      name: name || "Claude",
      cwd: this.repoPath,
    });
    terminal.show();
    terminal.sendText(`claude "${escaped}"`, true);
    if (name) {
      // Send /rename after a brief pause to let claude start up
      setTimeout(() => terminal.sendText(`/rename ${name}`, true), 2000);
    }
  }

  private async ensureRepoRegistered(): Promise<void> {
    const current = await httpGetJson<unknown>(`http://localhost:${this.port}/api/repos/current`);
    if (current !== null) return; // already registered

    const name = basename(this.repoPath);
    let remote = "";
    try {
      const { stdout } = await execFileAsync("git", ["-C", this.repoPath, "remote", "get-url", "origin"]);
      remote = stdout.trim();
    } catch { /* no remote configured */ }

    console.log(`[Gossamer] registering repo: ${name} at ${this.repoPath}`);
    await httpPostJson(`http://localhost:${this.port}/api/repos`, {
      name,
      localPath: this.repoPath,
      remote,
    });
  }

  private watchGitBranch() {
    const gitDir = join(this.repoPath, ".git");
    try {
      this.watcher = watch(gitDir, { recursive: false }, (_event, filename) => {
        // The server polls shadows every 5s already; this is just a hint for future use
        if (filename === "packed-refs" || (filename ?? "").startsWith("refs/")) {
          // Server handles re-indexing internally
        }
      });
    } catch { /* git dir unavailable */ }
  }

  private getWebviewHtml(context: vscode.ExtensionContext): string {
    const webview   = this.panel.webview;
    const distUri   = vscode.Uri.joinPath(context.extensionUri, "dist", "webview");
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "assets", "index.js"));
    const styleUri  = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "assets", "index.css"));
    const nonce     = getNonce();
    const port      = this.port;

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src http://localhost:${port} ws://localhost:${port};" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Gossamer</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.__GOSSAMER_PORT__ = ${port};</script>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private cleanup() {
    this.server?.kill();
    this.watcher?.close();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    GossamerPanel.instance = undefined;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () =>
    chars[Math.floor(Math.random() * chars.length)],
  ).join("");
}
