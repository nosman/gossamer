// Thin wrapper around acquireVsCodeApi so it is only called once.
// acquireVsCodeApi is injected by VS Code and is not available in plain browsers.

declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };

let _api: ReturnType<typeof acquireVsCodeApi> | null = null;

function getApi() {
  if (!_api && typeof acquireVsCodeApi !== "undefined") {
    _api = acquireVsCodeApi();
  }
  return _api;
}

export function postToExtension(msg: unknown): void {
  getApi()?.postMessage(msg);
}
