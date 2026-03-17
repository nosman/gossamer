import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "path";
import { spawn } from "child_process";
import * as pty from "node-pty";
import os from "os";

let mainWindow: BrowserWindow | null = null;
const ptyProcesses = new Map<string, pty.IPty>();

function setupPtyIpc(): void {
  ipcMain.handle("pty:spawn", (_e, id: string, options?: { cwd?: string }) => {
    if (ptyProcesses.has(id)) {
      ptyProcesses.get(id)!.kill();
      ptyProcesses.delete(id);
    }
    const shell = process.env.SHELL || (process.platform === "win32" ? "cmd.exe" : "bash");
    const p = pty.spawn(shell, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: options?.cwd || os.homedir(),
      env: process.env as Record<string, string>,
    });
    ptyProcesses.set(id, p);
    p.onData((data) => mainWindow?.webContents.send("pty:data", id, data));
    p.onExit(() => {
      mainWindow?.webContents.send("pty:exit", id);
      ptyProcesses.delete(id);
    });
  });

  ipcMain.on("pty:write", (_e, id: string, data: string) => {
    ptyProcesses.get(id)?.write(data);
  });

  ipcMain.on("pty:resize", (_e, id: string, cols: number, rows: number) => {
    try { ptyProcesses.get(id)?.resize(cols, rows); } catch {}
  });

  ipcMain.on("pty:kill", (_e, id: string) => {
    ptyProcesses.get(id)?.kill();
    ptyProcesses.delete(id);
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  setupPtyIpc();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
