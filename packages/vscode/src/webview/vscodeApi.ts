// Thin wrapper around acquireVsCodeApi so it is only called once.
// acquireVsCodeApi is injected by VS Code and is not available in plain browsers.

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

let _api: { postMessage(msg: unknown): void } | null = null;

function getApi() {
  if (!_api) {
    // Reuse the instance acquired by the host page script if available
    _api = (window as unknown as Record<string, unknown>).__vscodeApi as typeof _api
      ?? (typeof acquireVsCodeApi !== "undefined" ? acquireVsCodeApi() : null);
  }
  return _api;
}

export function postToExtension(msg: unknown): void {
  getApi()?.postMessage(msg);
}
