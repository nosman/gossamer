import React, { createContext, useCallback, useContext, useRef, useState } from "react";

export type Tab =
  | { id: "home"; type: "home"; title: string }
  | { id: string; type: "session"; sessionId: string; title: string; initialSearch?: string; initialState?: unknown }
  | { id: string; type: "branchLog"; localPath: string; branch: string; repoName: string | null; title: string };

type NavigateFn = (to: string | number) => void;

interface TabsContextValue {
  tabs: Tab[];
  activeTabId: string;
  homePathname: string;
  openSessionTab: (sessionId: string, title: string, initialSearch?: string, initialState?: unknown) => void;
  openBranchLogTab: (localPath: string, branch: string, repoName: string | null) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
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
  const startTabs: Tab[] = initialTab ? [HOME_TAB, initialTab] : [HOME_TAB];
  const startActiveId = initialTab ? initialTab.id : "home";

  const [tabs, setTabs] = useState<Tab[]>(startTabs);
  const [activeTabId, setActiveTabId] = useState<string>(startActiveId);
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
        closeTab,
        setActiveTab: setActiveTabId,
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
