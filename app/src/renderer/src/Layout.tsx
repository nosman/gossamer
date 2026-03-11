import React, { useState } from "react";
import { Outlet, useNavigate, useLocation } from "react-router-dom";
import {
  AppShell, Box, Text, NavLink, ActionIcon, Tooltip, Group, Anchor, TextInput,
  useMantineColorScheme, useComputedColorScheme,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useBreadcrumb } from "./BreadcrumbContext";

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
  const [sidebarOpen, { toggle: toggleSidebar }] = useDisclosure(true);
  const { crumbs } = useBreadcrumb();
  const [searchValue, setSearchValue] = useState("");

  const activeNav = getActiveNav(pathname);
  const canGoBack = !TOP_LEVEL.has(pathname);

  return (
    <AppShell
      header={{ height: 40 }}
      navbar={{ width: 220, breakpoint: "sm", collapsed: { desktop: !sidebarOpen, mobile: !sidebarOpen } }}
      padding={0}
      style={{ height: "100vh" }}
    >
      {/* Header spans full width — hamburger is always visible */}
      <AppShell.Header
        style={{
          borderBottom: "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
          backgroundColor: "light-dark(var(--mantine-color-white), var(--mantine-color-dark-7))",
        }}
      >
        <Group h="100%" px={12} gap={6} style={{ flex: 1 }}>
          <ActionIcon variant="subtle" color="gray" onClick={toggleSidebar} size="sm" title="Toggle sidebar">
            ☰
          </ActionIcon>
          {canGoBack && (
            <ActionIcon variant="subtle" color="gray" onClick={() => navigate(-1)} size="sm" title="Back">
              ←
            </ActionIcon>
          )}
          {crumbs.length > 0 && (
            <Group gap={4} align="center" ml={4}>
              {crumbs.map((crumb, i) => (
                <React.Fragment key={i}>
                  {i > 0 && (
                    <Text size="sm" c="dimmed" style={{ userSelect: "none" }}>/</Text>
                  )}
                  {crumb.path ? (
                    <Anchor
                      size="sm"
                      fw={500}
                      onClick={() => navigate(crumb.path!)}
                      style={{ cursor: "pointer" }}
                      underline="never"
                    >
                      {crumb.label}
                    </Anchor>
                  ) : (
                    <Text size="sm" fw={500} c="dimmed">{crumb.label}</Text>
                  )}
                </React.Fragment>
              ))}
            </Group>
          )}
          <Box style={{ flex: 1 }} />
          <TextInput
            placeholder="Search logs…"
            size="xs"
            radius="md"
            value={searchValue}
            onChange={(e) => setSearchValue(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && searchValue.trim()) {
                navigate(`/search?q=${encodeURIComponent(searchValue.trim())}`);
              }
            }}
            style={{ width: 220 }}
          />
        </Group>
      </AppShell.Header>

      <AppShell.Navbar
        style={{
          backgroundColor: "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-8))",
          borderRight: "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
          display: "flex",
          flexDirection: "column",
          padding: "12px 8px",
        }}
      >
        <Text fw={700} size="sm" px={8} py={6} mb={8} style={{ letterSpacing: 0.2 }}>
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
              styles={{ root: { borderRadius: 6, marginBottom: 2, fontSize: 13 } }}
            />
          ))}
        </Box>

        <Group
          justify="space-between"
          px={8}
          pt={10}
          style={{ borderTop: "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))" }}
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
          paddingTop: 40, // offset for the header
        }}
      >
        <Box style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <Outlet />
        </Box>
      </AppShell.Main>
    </AppShell>
  );
}
