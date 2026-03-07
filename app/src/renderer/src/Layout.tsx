import React from "react";
import { Outlet, useNavigate, useLocation } from "react-router-dom";
import { Box, Group, Text, ActionIcon } from "@mantine/core";

function useRouteTitle(): string {
  const { pathname, state } = useLocation();
  const s = state as { title?: string } | null;
  if (s?.title) return s.title;
  if (pathname === "/") return "Claude Sessions";
  if (pathname === "/session-tree") return "Session Tree";
  if (pathname === "/checkpoints") return "Checkpoints";
  if (pathname === "/checkpoints/timeline") return "Checkpoint Timeline";
  if (pathname.startsWith("/sessions/")) return "Session Detail";
  if (pathname.startsWith("/checkpoints/")) return "Checkpoint Detail";
  return "Gossamer";
}

function HeaderRight() {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  if (pathname === "/") {
    return (
      <Group gap={4}>
        <ActionIcon variant="subtle" color="gray" onClick={() => navigate("/checkpoints")} title="Checkpoints">
          ⬛
        </ActionIcon>
        <ActionIcon variant="subtle" color="gray" onClick={() => navigate("/session-tree")} title="Session Tree">
          ⬡
        </ActionIcon>
      </Group>
    );
  }

  if (pathname === "/checkpoints") {
    return (
      <ActionIcon variant="subtle" color="gray" onClick={() => navigate("/checkpoints/timeline")} title="Timeline">
        ◎
      </ActionIcon>
    );
  }

  return null;
}

export function Layout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const title = useRouteTitle();
  const canGoBack = pathname !== "/";

  return (
    <Box style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <Box
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 48,
          padding: "0 12px",
          backgroundColor: "var(--mantine-color-gray-0)",
          borderBottom: "1px solid var(--mantine-color-gray-3)",
          flexShrink: 0,
        }}
      >
        {canGoBack && (
          <ActionIcon variant="subtle" color="gray" onClick={() => navigate(-1)} title="Back" size="sm">
            ←
          </ActionIcon>
        )}
        <Text fw={600} size="sm" style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
        </Text>
        <HeaderRight />
      </Box>
      <Box component="main" style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <Outlet />
      </Box>
    </Box>
  );
}
