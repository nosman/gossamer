import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("electronAPI", {
  openWindow: (tabParam: string) => ipcRenderer.invoke("open-window", tabParam),
});
