import React from "react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { Layout } from "./Layout";
import { ActiveSessions } from "./screens/ActiveSessions";
import { SessionTree } from "./screens/SessionTree";
import { SessionDetail } from "./screens/SessionDetail";
import { Checkpoints } from "./screens/Checkpoints";
import { CheckpointTimeline } from "./screens/CheckpointTimeline";
import { CheckpointDetail } from "./screens/CheckpointDetail";

export default function App() {
  return (
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<ActiveSessions />} />
          <Route path="session-tree" element={<SessionTree />} />
          <Route path="sessions/:sessionId" element={<SessionDetail />} />
          <Route path="checkpoints" element={<Checkpoints />} />
          <Route path="checkpoints/timeline" element={<CheckpointTimeline />} />
          <Route path="checkpoints/:checkpointId" element={<CheckpointDetail />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}
