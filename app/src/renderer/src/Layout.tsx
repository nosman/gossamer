import React from "react";
import { Outlet, useNavigate, useLocation } from "react-router-dom";
import {
  AppShell, Box, Text, NavLink, ActionIcon, Tooltip, Group,
  useMantineColorScheme, useComputedColorScheme,
} from "@mantine/core";

const NAV_ITEMS = [
  { label: "Sessions",     path: "/",                     sym: "≡"  },
  { label: "Session Tree", path: "/session-tree",         sym: "⬡"  },
  { label: "Checkpoints",  path: "/checkpoints",          sym: "⬛" },
  { label: "Timeline",     path: "/checkpoints/timeline", sym: "◎"  },
] as const;

const TOP_LEVEL = new Set(["/", "/session-tree", "/checkpoints", "/checkpoints/timeline"]);

function getActiveNav(pathname: string): string {
  if (pathname === "/" || pathname.startsWith("/sessions/")) return "/";
  if (pathname === "/session-tree") return "/session-tree";
  if (pathname === "/checkpoints/timeline") return "/checkpoints/timeline";
  if (pathname.startsWith("/checkpoints")) return "/checkpoints";
  return "";
}

export function Layout() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { toggleColorScheme } = useMantineColorScheme();
  const colorScheme = useComputedColorScheme("dark");

  const activeNav = getActiveNav(pathname);
  const canGoBack = !TOP_LEVEL.has(pathname);

  return (
    <AppShell navbar={{ width: 220, breakpoint: "sm" }} padding={0} style={{ height: "100vh" }}>
      <AppShell.Navbar
        style={{
          backgroundColor: "var(--mantine-color-dark-7)",
          borderRight: "1px solid var(--mantine-color-dark-4)",
          display: "flex",
          flexDirection: "column",
          padding: "12px 8px",
        }}
      >
        <Text fw={700} size="sm" c="bright" px={8} py={6} mb={8} style={{ letterSpacing: 0.2 }}>
          Gossamer
        </Text>

        <Box style={{ flex: 1 }}>
          {NAV_ITEMS.map(({ label, path, sym }) => (
            <NavLink
              key={path}
              label={label}
              leftSection={
                <Text size="xs" c="dimmed" style={{ width: 16, textAlign: "center", fontFamily: "monospace" }}>
                  {sym}
                </Text>
              }
              active={activeNav === path}
              onClick={() => navigate(path)}
              styles={{
                root: { borderRadius: 6, marginBottom: 2, fontSize: 13 },
              }}
            />
          ))}
        </Box>

        <Group
          justify="space-between"
          px={8}
          pt={10}
          style={{ borderTop: "1px solid var(--mantine-color-dark-4)" }}
        >
          <Text size="xs" c="dimmed">v0.1</Text>
          <Tooltip label={colorScheme === "dark" ? "Light mode" : "Dark mode"} position="right" withArrow>
            <ActionIcon variant="subtle" color="gray" onClick={toggleColorScheme} size="sm">
              {colorScheme === "dark" ? "☀" : "◐"}
            </ActionIcon>
          </Tooltip>
        </Group>
      </AppShell.Navbar>

      <AppShell.Main
        style={{
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          height: "100vh",
          padding: 0,
        }}
      >
        {canGoBack && (
          <Box
            style={{
              display: "flex",
              alignItems: "center",
              height: 40,
              padding: "0 16px",
              borderBottom: "1px solid var(--mantine-color-dark-4)",
              flexShrink: 0,
            }}
          >
            <ActionIcon variant="subtle" color="gray" onClick={() => navigate(-1)} size="sm" title="Back">
              ←
            </ActionIcon>
          </Box>
        )}
        <Box style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <Outlet />
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}
