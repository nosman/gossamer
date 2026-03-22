import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

export type Tab =
  | { id: "home"; type: "home"; title: string }
  | { id: string; type: "session"; sessionId: string; title: string; initialSearch?: string; initialState?: unknown }
  | { id: string; type: "branchLog"; localPath: string; branch: string; repoName: string | null; title: string }
  | { id: string; type: "spawn"; cwd: string; command: string; title: string; spawnedAt: number };

// ── Tab persistence ────────────────────────────────────────────────────────────

const STORAGE_KEY = "gossamer-tabs-v1";

type PersistedTab =
  | { id: string; type: "session"; sessionId: string; title: string }
  | { id: string; type: "branchLog"; localPath: string; branch: string; repoName: string | null; title: string };

function loadPersistedState(): { tabs: Tab[]; activeTabId: string } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const { tabs, activeTabId } = JSON.parse(raw) as { tabs: PersistedTab[]; activeTabId: string };
    if (!Array.isArray(tabs) || typeof activeTabId !== "string") return null;
    const valid = tabs.filter((t) => t.type === "session" || t.type === "branchLog");
    const restoredActiveId = valid.find((t) => t.id === activeTabId) ? activeTabId : "home";
    return { tabs: [HOME_TAB, ...valid] as Tab[], activeTabId: restoredActiveId };
  } catch {
    return null;
  }
}

type NavigateFn = (to: string | number) => void;

interface TabsContextValue {
  tabs: Tab[];
  activeTabId: string;
  homePathname: string;
  openSessionTab: (sessionId: string, title: string, initialSearch?: string, initialState?: unknown) => void;
  openBranchLogTab: (localPath: string, branch: string, repoName: string | null) => void;
  openSpawnTab: (cwd: string, command: string, title: string) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  updateTabTitle: (id: string, title: string) => void;
  /** Navigate the home tab (and activate it). Accepts a path string or -1 for back. */
  navigateHome: (to: string | number) => void;
  /** Called by HomeTabRoutes to register its navigate function. */
  registerHomeNavigate: (fn: NavigateFn | null) => void;
  /** Called by HomeTabRoutes when location changes, to keep homePathname in sync. */
  updateHomePathname: (pathname: string) => void;
  openSessionWindow: (sessionId: string) => void;
  openBranchLogWindow: (localPath: string, branch: string, repoName: string | null) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

const HOME_TAB: Tab = { id: "home", type: "home", title: "Sessions" };

export function parseInitialTab(tabParam: string | null): Tab | null {
  if (!tabParam) return null;
  if (tabParam.startsWith("session:")) {
    const sessionId = tabParam.slice("session:".length);
    return { id: tabParam, type: "session", sessionId, title: sessionId.slice(0, 8) + "…" };
  }
  if (tabParam.startsWith("branchLog:")) {
    const qs = tabParam.slice("branchLog:".length);
    const p = new URLSearchParams(qs);
    const localPath = p.get("localPath") ?? "";
    const branch = p.get("branch") ?? "";
    const repoName = p.get("repoName") ?? null;
    const title = repoName ? `${repoName}/${branch}` : branch;
    return { id: tabParam, type: "branchLog", localPath, branch, repoName, title };
  }
  return null;
}

export function TabsProvider({
  children,
  initialTab,
}: {
  children: React.ReactNode;
  initialTab?: Tab | null;
}) {
  const persisted = initialTab ? null : loadPersistedState();
  const startTabs: Tab[] = initialTab ? [HOME_TAB, initialTab] : (persisted?.tabs ?? [HOME_TAB]);
  const startActiveId = initialTab ? initialTab.id : (persisted?.activeTabId ?? "home");

  const [tabs, setTabs] = useState<Tab[]>(startTabs);
  const [activeTabId, setActiveTabId] = useState<string>(startActiveId);

  // Persist session/branchLog tabs on every change
  useEffect(() => {
    const toSave = tabs.filter((t) => t.type === "session" || t.type === "branchLog");
    const activeIsHome = !toSave.find((t) => t.id === activeTabId);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        tabs: toSave,
        activeTabId: activeIsHome ? "home" : activeTabId,
      }));
    } catch { /* quota exceeded, ignore */ }
  }, [tabs, activeTabId]);
  const [homePathname, setHomePathname] = useState("/");
  const homeNavigateRef = useRef<NavigateFn | null>(null);

  const openSessionTab = useCallback((sessionId: string, title: string, initialSearch?: string, initialState?: unknown) => {
    const id = `session:${sessionId}`;
    setTabs((prev) => {
      if (prev.find((t) => t.id === id)) return prev;
      return [...prev, { id, type: "session", sessionId, title, initialSearch, initialState }];
    });
    setActiveTabId(id);
  }, []);

  const openBranchLogTab = useCallback(
    (localPath: string, branch: string, repoName: string | null) => {
      const id = `branchLog:${localPath}:${branch}`;
      setTabs((prev) => {
        if (prev.find((t) => t.id === id)) return prev;
        const title = repoName ? `${repoName}/${branch}` : branch;
        return [...prev, { id, type: "branchLog", localPath, branch, repoName, title }];
      });
      setActiveTabId(id);
    },
    [],
  );

  const openSpawnTab = useCallback((cwd: string, command: string, title: string) => {
    const spawnedAt = Date.now();
    const id = `spawn:${spawnedAt}`;
    setTabs((prev) => [...prev, { id, type: "spawn", cwd, command, title, spawnedAt }]);
    setActiveTabId(id);
  }, []);

  const updateTabTitle = useCallback((id: string, title: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)));
  }, []);

  const closeTab = useCallback((id: string) => {
    if (id === "home") return;
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      setActiveTabId((current) => {
        if (current !== id) return current;
        if (next.length === 0) return "home";
        return next[Math.max(0, idx - 1)].id;
      });
      return next;
    });
  }, []);

  const navigateHome = useCallback((to: string | number) => {
    setActiveTabId("home");
    homeNavigateRef.current?.(to);
    if (typeof to === "string") setHomePathname(to.split("?")[0]);
  }, []);

  const registerHomeNavigate = useCallback((fn: NavigateFn | null) => {
    homeNavigateRef.current = fn;
  }, []);

  const updateHomePathname = useCallback((pathname: string) => {
    setHomePathname(pathname);
  }, []);

  const openSessionWindow = useCallback((sessionId: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).electronAPI?.openWindow(`session:${sessionId}`);
  }, []);

  const openBranchLogWindow = useCallback(
    (localPath: string, branch: string, repoName: string | null) => {
      const params = new URLSearchParams({ localPath, branch, ...(repoName ? { repoName } : {}) });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).electronAPI?.openWindow(`branchLog:${params.toString()}`);
    },
    [],
  );

  return (
    <TabsContext.Provider
      value={{
        tabs,
        activeTabId,
        homePathname,
        openSessionTab,
        openBranchLogTab,
        openSpawnTab,
        closeTab,
        setActiveTab: setActiveTabId,
        updateTabTitle,
        navigateHome,
        registerHomeNavigate,
        updateHomePathname,
        openSessionWindow,
        openBranchLogWindow,
      }}
    >
      {children}
    </TabsContext.Provider>
  );
}

export function useTabs(): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error("useTabs must be used within TabsProvider");
  return ctx;
}
