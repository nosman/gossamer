import React, { useEffect, useState } from "react";
import { MemoryRouter, Routes, Route, useNavigate, useLocation, Outlet } from "react-router-dom";
import {
  AppShell, Box, Text, NavLink, ActionIcon, Tooltip, Group, Anchor, TextInput, Select,
  useMantineColorScheme, useComputedColorScheme,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useBreadcrumb } from "./BreadcrumbContext";
import { useTabs, type Tab } from "./TabsContext";
import { TabBar } from "./components/TabBar";
import { fetchBranches } from "./api";

// Home-tab screens
import { ActiveSessions } from "./screens/ActiveSessions";
import { SessionTree } from "./screens/SessionTree";
import { Checkpoints } from "./screens/Checkpoints";
import { CheckpointTimeline } from "./screens/CheckpointTimeline";
import { CheckpointDetail } from "./screens/CheckpointDetail";
import { Search } from "./screens/Search";
import { Repos } from "./screens/Repos";

// Tab-content screens
import { SessionDetail } from "./screens/SessionDetail";
import { BranchLog } from "./screens/BranchLog";
import { SpawnSessionScreen } from "./screens/SpawnSessionScreen";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NAV_ITEMS = [
  { label: "Sessions",     path: "/",                     sym: "≡"  },
  { label: "Session Tree", path: "/session-tree",         sym: "⬡"  },
  { label: "Checkpoints",  path: "/checkpoints",          sym: "⬛" },
  { label: "Timeline",     path: "/checkpoints/timeline", sym: "◎"  },
  { label: "Repos",        path: "/repos",                sym: "⊡"  },
] as const;

const TOP_LEVEL = new Set(["/", "/session-tree", "/checkpoints", "/checkpoints/timeline", "/repos"]);

function getActiveNav(pathname: string): string {
  if (pathname === "/" || pathname.startsWith("/sessions/")) return "/";
  if (pathname === "/session-tree") return "/session-tree";
  if (pathname === "/checkpoints/timeline") return "/checkpoints/timeline";
  if (pathname.startsWith("/checkpoints")) return "/checkpoints";
  if (pathname === "/repos") return "/repos";
  return "";
}

// ---------------------------------------------------------------------------
// Branch selector (for branchLog tabs shown in the header)
// ---------------------------------------------------------------------------

function BranchSelector({
  localPath,
  branch,
  repoName,
  onBranchChange,
}: {
  localPath: string;
  branch: string;
  repoName: string | null;
  onBranchChange: (branch: string) => void;
}) {
  const [branches, setBranches] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchBranches(localPath)
      .then(setBranches)
      .catch(() => setBranches(branch ? [branch] : []))
      .finally(() => setLoading(false));
  }, [localPath]);

  return (
    <Select
      size="xs"
      value={branch}
      data={branches}
      disabled={loading}
      placeholder={loading ? "loading…" : undefined}
      onChange={(b) => { if (b) onBranchChange(b); }}
      styles={{ input: { fontFamily: "monospace", fontSize: 12 } }}
      comboboxProps={{ withinPortal: true }}
      allowDeselect={false}
      w={200}
    />
  );
}

// ---------------------------------------------------------------------------
// Home tab — its own MemoryRouter, registers navigate with TabsContext
// ---------------------------------------------------------------------------

/** Registers/unregisters the home router's navigate with TabsContext and syncs pathname. */
function HomeTabBridge() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { registerHomeNavigate, updateHomePathname } = useTabs();

  useEffect(() => {
    registerHomeNavigate(navigate as (to: string | number) => void);
    return () => registerHomeNavigate(null);
  }, [navigate, registerHomeNavigate]);

  useEffect(() => {
    updateHomePathname(pathname);
  }, [pathname, updateHomePathname]);

  return <Outlet />;
}

function HomeTab() {
  return (
    <MemoryRouter>
      <Routes>
        <Route path="/" element={<HomeTabBridge />}>
          <Route index element={<ActiveSessions />} />
          <Route path="session-tree" element={<SessionTree />} />
          <Route path="checkpoints" element={<Checkpoints />} />
          <Route path="checkpoints/timeline" element={<CheckpointTimeline />} />
          <Route path="checkpoints/:checkpointId" element={<CheckpointDetail />} />
          <Route path="search" element={<Search />} />
          <Route path="repos" element={<Repos />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

// ---------------------------------------------------------------------------
// Session tab — its own MemoryRouter
// ---------------------------------------------------------------------------

function SessionTab({ sessionId, initialSearch, initialState }: { sessionId: string; initialSearch?: string; initialState?: unknown }) {
  return (
    <MemoryRouter initialEntries={[{ pathname: `/sessions/${sessionId}`, search: initialSearch ?? "", state: initialState }]}>
      <Routes>
        <Route path="/sessions/:sessionId" element={<SessionDetail />} />
        <Route path="/checkpoints/:checkpointId" element={<CheckpointDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

// ---------------------------------------------------------------------------
// BranchLog tab — its own MemoryRouter
// ---------------------------------------------------------------------------

function BranchLogTab({
  localPath,
  branch,
  repoName,
}: {
  localPath: string;
  branch: string;
  repoName: string | null;
}) {
  const search = `?localPath=${encodeURIComponent(localPath)}&branch=${encodeURIComponent(branch)}${repoName ? `&repoName=${encodeURIComponent(repoName)}` : ""}`;
  return (
    <MemoryRouter initialEntries={[{ pathname: "/branch-log", search }]}>
      <Routes>
        <Route path="/branch-log" element={<BranchLog />} />
        <Route path="/checkpoints/:checkpointId" element={<CheckpointDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

// ---------------------------------------------------------------------------
// Tab content dispatcher
// ---------------------------------------------------------------------------

function TabContent({ tab }: { tab: Tab }) {
  if (tab.type === "session") return <SessionTab sessionId={tab.sessionId} initialSearch={tab.initialSearch} initialState={tab.initialState} />;
  if (tab.type === "branchLog") {
    return <BranchLogTab localPath={tab.localPath} branch={tab.branch} repoName={tab.repoName} />;
  }
  if (tab.type === "spawn") {
    return <SpawnSessionScreen tabId={tab.id} cwd={tab.cwd} command={tab.command} spawnedAt={tab.spawnedAt} />;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shell — the root layout, no router context required
// ---------------------------------------------------------------------------

export function Shell() {
  const { toggleColorScheme } = useMantineColorScheme();
  const colorScheme = useComputedColorScheme("dark");
  const [sidebarOpen, { toggle: toggleSidebar }] = useDisclosure(true);
  const { crumbs } = useBreadcrumb();
  const [searchValue, setSearchValue] = useState("");

  const { tabs, activeTabId, homePathname, setActiveTab, navigateHome, openBranchLogTab } = useTabs();
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const isHomeTabActive = activeTabId === "home";

  const activeNav = getActiveNav(homePathname);
  const canGoBack = isHomeTabActive && !TOP_LEVEL.has(homePathname);

  return (
    <AppShell
      header={{ height: 40 }}
      navbar={{ width: 220, breakpoint: "sm", collapsed: { desktop: !sidebarOpen, mobile: !sidebarOpen } }}
      padding={0}
      style={{ height: "100vh" }}
    >
      {/* ------------------------------------------------------------------ */}
      {/* Header                                                              */}
      {/* ------------------------------------------------------------------ */}
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
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={() => navigateHome(-1)}
              size="sm"
              title="Back"
            >
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
                      onClick={() => navigateHome(crumb.path!)}
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
          {/* Branch selector shown when a branchLog tab is active */}
          {activeTab?.type === "branchLog" && (
            <BranchSelector
              localPath={activeTab.localPath}
              branch={activeTab.branch}
              repoName={activeTab.repoName}
              onBranchChange={(b) =>
                openBranchLogTab(activeTab.localPath, b, activeTab.repoName)
              }
            />
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
                navigateHome(`/search?q=${encodeURIComponent(searchValue.trim())}`);
              }
            }}
            style={{ width: 220 }}
          />
        </Group>
      </AppShell.Header>

      {/* ------------------------------------------------------------------ */}
      {/* Sidebar                                                             */}
      {/* ------------------------------------------------------------------ */}
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
              active={isHomeTabActive && activeNav === path}
              onClick={() => navigateHome(path)}
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

      {/* ------------------------------------------------------------------ */}
      {/* Main content — tab bar + tab panels                                 */}
      {/* ------------------------------------------------------------------ */}
      <AppShell.Main
        style={{
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          height: "100vh",
          padding: 0,
          paddingTop: 40,
        }}
      >
        <TabBar />

        {/* Home tab — always mounted so state/subscriptions persist */}
        <Box
          style={{
            flex: 1,
            overflow: "hidden",
            display: isHomeTabActive ? "flex" : "none",
            flexDirection: "column",
          }}
        >
          <HomeTab />
        </Box>

        {/* Session / BranchLog tabs */}
        {tabs
          .filter((t) => t.type !== "home")
          .map((tab) => (
            <Box
              key={tab.id}
              style={{
                flex: 1,
                overflow: "hidden",
                display: tab.id === activeTabId ? "flex" : "none",
                flexDirection: "column",
              }}
            >
              <TabContent tab={tab} />
            </Box>
          ))}
      </AppShell.Main>
    </AppShell>
  );
}
