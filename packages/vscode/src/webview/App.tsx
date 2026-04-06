import React from "react";
import { ActiveSessions } from "./screens/ActiveSessions";
import { SessionDetail } from "./screens/SessionDetail";
import { postToExtension } from "./vscodeApi";

declare global {
  interface Window {
    __GOSSAMER_SESSION_ID__?: string;
    __GOSSAMER_SESSION_TITLE__?: string;
  }
}

export function App() {
  const sessionId = window.__GOSSAMER_SESSION_ID__;
  const sessionTitle = window.__GOSSAMER_SESSION_TITLE__;

  if (sessionId) {
    return <SessionDetail sessionId={sessionId} title={sessionTitle ?? sessionId.slice(0, 8)} />;
  }

  return (
    <>
      <button
        title="Minimize panel"
        onClick={() => postToExtension({ type: "minimize" })}
        style={{ position: "fixed", top: 6, right: 8, zIndex: 9999, background: "none", border: "none", cursor: "pointer", opacity: 0.5, fontSize: 16, lineHeight: 1, padding: "2px 6px", color: "var(--vscode-foreground)" }}
      >─</button>
      <ActiveSessions
        onSessionPress={(id, title) => postToExtension({ type: "open_session", sessionId: id, title })}
      />
    </>
  );
}
