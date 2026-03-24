import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "path";
import { spawn } from "child_process";
import type { ChildProcess } from "child_process";

let serverProc: ChildProcess | null = null;

function startServer(): void {
  const launcherPath = join(process.resourcesPath, "server", "server-launcher.cjs");

  // Run the Electron binary as a plain Node.js process (ELECTRON_RUN_AS_NODE=1).
  // This gives the server full Node.js access with the same ABI as the main
  // process, so native modules rebuilt for Electron work without a separate node binary.
  serverProc = spawn(process.execPath, [launcherPath], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  serverProc.stdout?.on("data", (d: Buffer) => process.stdout.write(`[server] ${d}`));
  serverProc.stderr?.on("data", (d: Buffer) => process.stderr.write(`[server] ${d}`));
  serverProc.on("exit", (code, signal) =>
    console.error(`[server] exited code=${code} signal=${signal}`)
  );
}

function createWindow(tabParam?: string): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const tabQuery = tabParam ? `?tab=${encodeURIComponent(tabParam)}` : "";

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(`${process.env.ELECTRON_RENDERER_URL}${tabQuery}`);
    win.webContents.openDevTools();
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"), {
      query: tabParam ? { tab: tabParam } : undefined,
    });
  }
}

app.whenReady().then(() => {
  // In dev mode the server is started separately via `npm run serve`.
  if (!process.env.ELECTRON_RENDERER_URL) {
    startServer();
  }

  ipcMain.handle("open-window", (_event, tabParam: string) => {
    createWindow(tabParam);
  });

  createWindow();
});

app.on("window-all-closed", () => {
  serverProc?.kill("SIGTERM");
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  serverProc?.kill("SIGTERM");
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
