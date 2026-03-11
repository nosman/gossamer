import React from "react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { Layout } from "./Layout";
import { BreadcrumbProvider } from "./BreadcrumbContext";
import { ActiveSessions } from "./screens/ActiveSessions";
import { SessionTree } from "./screens/SessionTree";
import { SessionDetail } from "./screens/SessionDetail";
import { Checkpoints } from "./screens/Checkpoints";
import { CheckpointTimeline } from "./screens/CheckpointTimeline";
import { CheckpointDetail } from "./screens/CheckpointDetail";
import { Search } from "./screens/Search";

export default function App() {
  return (
    <BreadcrumbProvider>
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<ActiveSessions />} />
          <Route path="session-tree" element={<SessionTree />} />
          <Route path="sessions/:sessionId" element={<SessionDetail />} />
          <Route path="checkpoints" element={<Checkpoints />} />
          <Route path="checkpoints/timeline" element={<CheckpointTimeline />} />
          <Route path="checkpoints/:checkpointId" element={<CheckpointDetail />} />
          <Route path="search" element={<Search />} />
        </Route>
      </Routes>
    </MemoryRouter>
    </BreadcrumbProvider>
  );
}
