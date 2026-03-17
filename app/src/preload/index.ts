import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("pty", {
  spawn: (id: string, options?: { cwd?: string }) =>
    ipcRenderer.invoke("pty:spawn", id, options),
  write: (id: string, data: string) =>
    ipcRenderer.send("pty:write", id, data),
  resize: (id: string, cols: number, rows: number) =>
    ipcRenderer.send("pty:resize", id, cols, rows),
  kill: (id: string) =>
    ipcRenderer.send("pty:kill", id),
  onData: (id: string, cb: (data: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, rid: string, data: string) => {
      if (rid === id) cb(data);
    };
    ipcRenderer.on("pty:data", listener);
    return () => ipcRenderer.removeListener("pty:data", listener);
  },
  onExit: (id: string, cb: () => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, rid: string) => {
      if (rid === id) cb();
    };
    ipcRenderer.on("pty:exit", listener);
    return () => ipcRenderer.removeListener("pty:exit", listener);
  },
});
