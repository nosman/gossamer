import { app, BrowserWindow, ipcMain } from "electron";
import { join } from "path";

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
  ipcMain.handle("open-window", (_event, tabParam: string) => {
    createWindow(tabParam);
  });

  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
