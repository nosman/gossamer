import * as vscode from "vscode";
import { spawn, ChildProcess } from "child_process";
import { watch, FSWatcher, existsSync, readFileSync } from "fs";
import { join, resolve, dirname, basename } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { get as httpGet, request as httpRequest } from "http";
import { execFileSync, execFile } from "child_process";
import { promisify } from "util";
import { SessionDetailPanel } from "./SessionDetailPanel.js";
import { openCheckpointDiff } from "./diffUtils.js";
import { CheckpointTreeProvider } from "./CheckpointTreeProvider.js";

const execFileAsync = promisify(execFile);

const __dirname = dirname(fileURLToPath(import.meta.url));

// Path to the gossamer server entry point.
// Packaged VSIX: bundled-server/serve.js lives inside the extension directory.
// Dev mode (gossamer-testing): fall back to the repo's compiled dist/serve.js.
const BUNDLED_SERVE = resolve(__dirname, "../bundled-server/serve.js");
const DEV_SERVE     = resolve(__dirname, "../../../dist/serve.js");
const SERVE_SCRIPT  = existsSync(BUNDLED_SERVE) ? BUNDLED_SERVE : DEV_SERVE;

// Maps the agent name (from CheckpointSessionMetadata.agent) to its CLI command.
export const AGENT_CLI: Record<string, { bin: string; resumeFlag: string; renameCmd?: string }> = {
  "Claude Code": { bin: "claude",  resumeFlag: "--resume", renameCmd: "/rename" },
  "Gemini CLI":  { bin: "gemini",  resumeFlag: "--resume" },
  "Codex":       { bin: "codex",   resumeFlag: "--session" },
};
const DEFAULT_AGENT_CLI = AGENT_CLI["Claude Code"];

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

const DEFAULT_PORT = 3456;

function getConfiguredPort(): number {
  try {
    const raw = readFileSync(join(homedir(), ".gossamer", "config.json"), "utf8");
    const cfg = JSON.parse(raw) as { port?: number };
    return typeof cfg.port === "number" ? cfg.port : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
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

  // Server is static so it survives panel disposal (minimize/restore)
  private static server: ChildProcess | undefined;
  private static serverPort: number | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly context: vscode.ExtensionContext;
  private readonly repoPath: string;
  private readonly port: number;
  private readonly checkpointProvider: CheckpointTreeProvider;
  private watcher: FSWatcher | undefined;
  private disposables: vscode.Disposable[] = [];
  private serverReady = false;

  static async createOrShow(context: vscode.ExtensionContext, repoPath: string, checkpointProvider: CheckpointTreeProvider) {
    if (GossamerPanel.instance) {
      GossamerPanel.instance.panel.reveal();
      return;
    }
    const port = getConfiguredPort();
    GossamerPanel.instance = new GossamerPanel(context, repoPath, port, checkpointProvider);
  }

  /** Hide the panel without killing the server (minimizes to nothing; re-open via command). */
  static minimize() {
    if (!GossamerPanel.instance) return;
    // Dispose the webview only — server stays alive
    GossamerPanel.instance.disposeWebviewOnly();
  }

  /** Toggle: minimize if visible, restore if hidden. */
  static toggle(context: vscode.ExtensionContext, repoPath: string, checkpointProvider: CheckpointTreeProvider) {
    if (GossamerPanel.instance) {
      GossamerPanel.minimize();
    } else {
      GossamerPanel.createOrShow(context, repoPath, checkpointProvider).catch(console.error);
    }
  }

  /** Kill and restart the server process, then re-signal the panel when ready. */
  static restart(repoPath: string) {
    const port = getConfiguredPort();
    GossamerPanel.server?.kill();
    GossamerPanel.server = undefined;
    GossamerPanel.serverPort = undefined;
    const instance = GossamerPanel.instance;
    if (instance) {
      instance.serverReady = false;
      instance.spawnServer();
      waitForServer(port)
        .then(() => instance.ensureRepoRegistered())
        .then(() => {
          instance.serverReady = true;
          instance.panel.webview.postMessage({ type: "server_ready" });
        })
        .catch((err) => instance.panel.webview.postMessage({ type: "server_error", error: String(err) }));
    } else {
      const nodeExec = getSystemNode();
      if (existsSync(SERVE_SCRIPT)) {
        const proc = spawn(nodeExec, [SERVE_SCRIPT, "--repo-dir", repoPath, "--port", String(port)], {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, FORCE_COLOR: "0" },
        });
        proc.on("exit", () => { if (GossamerPanel.server === proc) { GossamerPanel.server = undefined; GossamerPanel.serverPort = undefined; } });
        GossamerPanel.server = proc;
        GossamerPanel.serverPort = port;
      }
    }
  }

  /** Full shutdown — kills server too (called on extension deactivate). */
  static dispose() {
    GossamerPanel.instance?.cleanup(true);
    GossamerPanel.instance = undefined;
  }

  static searchSessions() {
    GossamerPanel.instance?.openSearchQuickPick().catch(console.error);
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
        enableFindWidget: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(context.extensionUri, "dist", "webview"),
        ],
      },
    );

    this.spawnServer();
    this.panel.webview.html = this.getWebviewHtml(context);
    this.panel.onDidDispose(() => this.cleanup(false), undefined, this.disposables);
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
        if (msg.type === "search_sessions") {
          this.openSearchQuickPick().catch(console.error);
        }
        if (msg.type === "minimize") {
          GossamerPanel.minimize();
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
    // Reuse existing static server if already running on the same port
    if (GossamerPanel.server && GossamerPanel.serverPort === this.port) {
      console.log("[Gossamer] reusing existing server on port", this.port);
      return;
    }

    if (!existsSync(SERVE_SCRIPT)) {
      const msg = `Gossamer server script not found at ${SERVE_SCRIPT}. Run \`npm run build\` in the gossamer repo root first.`;
      console.error("[Gossamer]", msg);
      vscode.window.showErrorMessage(msg);
      return;
    }

    const nodeExec = getSystemNode();
    console.log(`[Gossamer] spawning: ${nodeExec} ${SERVE_SCRIPT} --repo-dir ${this.repoPath} --port ${this.port}`);

    const proc = spawn(nodeExec, [SERVE_SCRIPT, "--repo-dir", this.repoPath, "--port", String(this.port)], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    proc.stdout?.on("data", (d: Buffer) => {
      console.log("[Gossamer server stdout]", d.toString().trim());
    });
    proc.stderr?.on("data", (d: Buffer) => {
      console.error("[Gossamer server stderr]", d.toString().trim());
    });
    proc.on("error", (err) => {
      console.error("[Gossamer] failed to spawn server:", err.message);
      vscode.window.showErrorMessage(`Gossamer: failed to start server — ${err.message}`);
    });
    proc.on("exit", (code, signal) => {
      console.log(`[Gossamer server] exited code=${code} signal=${signal}`);
      if (GossamerPanel.server === proc) {
        GossamerPanel.server = undefined;
        GossamerPanel.serverPort = undefined;
      }
    });

    GossamerPanel.server = proc;
    GossamerPanel.serverPort = this.port;
  }

  private async openSearchQuickPick(): Promise<void> {
    interface SessionData {
      sessionId: string;
      intent: string | null;
      prompt: string | null;
      repoName: string | null;
      cwd: string;
      slug?: string | null;
      customTitle?: string | null;
    }
    interface ContentResult {
      sessionId: string;
      snippet: string;
      contentType: string;
    }
    type QP = vscode.QuickPickItem & { sessionId: string; sessionTitle: string };

    const allSessions = await httpGetJson<SessionData[]>(`http://localhost:${this.port}/api/sessions`);

    const sessionLabel = (s: SessionData) =>
      s.intent ?? s.prompt?.slice(0, 80) ?? s.customTitle ?? s.slug ?? s.sessionId.slice(0, 8) ?? "";

    const toSessionItem = (s: SessionData): QP => ({
      sessionId:    s.sessionId,
      sessionTitle: sessionLabel(s),
      label:        sessionLabel(s),
      description:  s.repoName ?? s.cwd.split("/").pop() ?? "",
      detail:       s.cwd,
    });

    const buildItems = (query: string, contentResults: ContentResult[]): QP[] => {
      const q = query.toLowerCase();
      const sessionMatches = query
        ? allSessions.filter((s) =>
            sessionLabel(s).toLowerCase().includes(q) ||
            (s.repoName ?? "").toLowerCase().includes(q) ||
            s.cwd.toLowerCase().includes(q),
          )
        : allSessions;

      const items: QP[] = [];

      if (sessionMatches.length > 0) {
        if (contentResults.length > 0) {
          items.push({ kind: vscode.QuickPickItemKind.Separator, label: "Sessions", sessionId: "", sessionTitle: "" });
        }
        items.push(...sessionMatches.map(toSessionItem));
      }

      if (contentResults.length > 0) {
        const seenInSessions = new Set(sessionMatches.map((s) => s.sessionId));
        items.push({ kind: vscode.QuickPickItemKind.Separator, label: "Chat History", sessionId: "", sessionTitle: "" });
        for (const r of contentResults) {
          const session = allSessions.find((s) => s.sessionId === r.sessionId);
          const sLabel  = sessionLabel(session ?? { sessionId: r.sessionId, intent: null, prompt: null, repoName: null, cwd: "", slug: null });
          const snippet = r.snippet.replace(/«/g, "").replace(/»/g, "").trim();
          items.push({
            sessionId:    r.sessionId,
            sessionTitle: sLabel,
            label:        snippet || sLabel,
            description:  sLabel,
            detail:       session?.cwd ?? "",
            alwaysShow:   true,
          });
        }
      }

      return items;
    };

    const qp = vscode.window.createQuickPick<QP>();
    qp.placeholder = "Search sessions and chat history…";
    qp.matchOnDescription = false;
    qp.matchOnDetail = false;
    qp.items = allSessions.map(toSessionItem);

    let debounce: ReturnType<typeof setTimeout> | undefined;

    qp.onDidChangeValue((query) => {
      if (debounce) clearTimeout(debounce);
      if (!query.trim()) {
        qp.busy = false;
        qp.items = allSessions.map(toSessionItem);
        return;
      }
      qp.busy = true;
      debounce = setTimeout(async () => {
        let contentResults: ContentResult[] = [];
        try {
          contentResults = await httpGetJson<ContentResult[]>(
            `http://localhost:${this.port}/api/search?q=${encodeURIComponent(query)}&limit=20`,
          );
        } catch { /* FTS syntax error — show session matches only */ }
        qp.items = buildItems(query, contentResults);
        qp.busy = false;
      }, 300);
    });

    qp.onDidAccept(() => {
      const selected = qp.selectedItems[0];
      const query = qp.value.trim();
      qp.dispose();
      if (selected?.sessionId) {
        SessionDetailPanel.createOrShow(
          this.context,
          selected.sessionId,
          selected.sessionTitle,
          this.port,
          this.checkpointProvider,
          query || undefined,
        );
      }
    });

    qp.onDidHide(() => {
      if (debounce) clearTimeout(debounce);
      qp.dispose();
    });
    qp.show();
  }

  private async promptAndSpawnSession(): Promise<void> {
    // Pick agent — offer choices based on which agents have been used in this repo
    interface SessionStub { agent: string | null }
    let agentCli = DEFAULT_AGENT_CLI;
    try {
      const sessions = await httpGetJson<SessionStub[]>(`http://localhost:${this.port}/api/sessions`);
      const usedAgents = [...new Set(sessions.map((s) => s.agent).filter(Boolean) as string[])];
      const knownAgents = usedAgents.filter((a) => AGENT_CLI[a]);
      if (knownAgents.length > 1) {
        const picked = await vscode.window.showQuickPick(
          knownAgents.map((a) => ({ label: a, description: AGENT_CLI[a].bin })),
          { title: "Choose agent", ignoreFocusOut: true },
        );
        if (!picked) return;
        agentCli = AGENT_CLI[picked.label];
      } else if (knownAgents.length === 1) {
        agentCli = AGENT_CLI[knownAgents[0]];
      }
    } catch { /* use default */ }

    const prompt = await vscode.window.showInputBox({
      title: `New ${agentCli.bin} Session`,
      prompt: `What do you want ${agentCli.bin} to do?`,
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
      name: name || agentCli.bin,
      cwd: this.repoPath,
    });
    terminal.show();
    terminal.sendText(`${agentCli.bin} "${escaped}"`, true);
    if (name && agentCli.renameCmd) {
      setTimeout(() => terminal.sendText(`${agentCli.renameCmd} ${name}`, true), 2000);
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
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src http://localhost:${port} ws://localhost:${port}; img-src data: https: http:;" />
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

  /** Dispose only the webview — server stays alive for quick restore. */
  private disposeWebviewOnly() {
    this.watcher?.close();
    this.disposables.forEach((d) => d.dispose());
    this.disposables = [];
    GossamerPanel.instance = undefined;
    this.panel.dispose();
  }

  private cleanup(killServer: boolean) {
    if (killServer) {
      GossamerPanel.server?.kill();
      GossamerPanel.server = undefined;
      GossamerPanel.serverPort = undefined;
    }
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
