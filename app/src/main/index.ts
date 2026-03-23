import { app, BrowserWindow, ipcMain, utilityProcess } from "electron";
import type { UtilityProcess } from "electron";
import { join } from "path";

let serverProc: UtilityProcess | null = null;

function startServer(): void {
  const launcherPath = join(process.resourcesPath, "server", "server-launcher.cjs");
  serverProc = utilityProcess.fork(launcherPath, [], { stdio: "pipe" });
  serverProc.stdout?.on("data", (data: Buffer) => process.stdout.write(`[server] ${data}`));
  serverProc.stderr?.on("data", (data: Buffer) => process.stderr.write(`[server] ${data}`));
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
  serverProc?.kill();
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  serverProc?.kill();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
