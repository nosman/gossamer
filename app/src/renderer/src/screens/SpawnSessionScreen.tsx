import React, { useEffect, useState } from "react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { Box, Center, Loader, Text } from "@mantine/core";
import { fetchSessions, subscribeToUpdates } from "../api";
import { EmbeddedTerminal } from "../components/EmbeddedTerminal";
import { SessionDetail } from "./SessionDetail";
import { CheckpointDetail } from "./CheckpointDetail";
import { useTabs } from "../TabsContext";

interface Props {
  tabId: string;
  cwd: string;
  command: string;
  spawnedAt: number;
}

export function SpawnSessionScreen({ tabId, cwd, command, spawnedAt }: Props) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const { updateTabTitle } = useTabs();

  useEffect(() => {
    if (sessionId) return;

    async function check() {
      try {
        const sessions = await fetchSessions();
        const found = sessions.find((s) => new Date(s.startedAt).getTime() >= spawnedAt - 5000);
        if (found) {
          setSessionId(found.sessionId);
          const title = found.intent ?? found.summary ?? found.prompt?.slice(0, 40) ?? found.sessionId.slice(0, 8) + "…";
          updateTabTitle(tabId, title);
        }
      } catch { /* ignore */ }
    }

    // Check after 1s, then every 2s
    const init = setTimeout(check, 1000);
    const interval = setInterval(check, 2000);
    const unsub = subscribeToUpdates(() => { check().catch(() => undefined); });

    return () => {
      clearTimeout(init);
      clearInterval(interval);
      unsub();
    };
  }, [sessionId, spawnedAt, tabId, updateTabTitle]);

  return (
    <Box style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      {/* Session detail area — fills available space above the terminal */}
      <Box style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
        {sessionId ? (
          <MemoryRouter
            initialEntries={[{
              pathname: `/sessions/${sessionId}`,
              state: { hideTerminal: true },
            }]}
          >
            <Routes>
              <Route path="/sessions/:sessionId" element={<SessionDetail />} />
              <Route path="/checkpoints/:checkpointId" element={<CheckpointDetail />} />
            </Routes>
          </MemoryRouter>
        ) : (
          <Center style={{ flex: 1 }}>
            <Box ta="center">
              <Loader size="sm" color="indigo" mb={8} />
              <Text size="sm" c="dimmed">Starting session…</Text>
            </Box>
          </Center>
        )}
      </Box>

      {/* Terminal — always mounted so the claude process keeps running */}
      <EmbeddedTerminal cwd={cwd} command={command} />
    </Box>
  );
}
