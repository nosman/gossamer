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
    <ActiveSessions
      onSessionPress={(id, title) => postToExtension({ type: "open_session", sessionId: id, title })}
    />
  );
}
