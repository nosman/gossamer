import React from "react";
import { Box, Text, ActionIcon, UnstyledButton, Tooltip } from "@mantine/core";
import { useTabs, type Tab } from "../TabsContext";

function tabIcon(tab: Tab): string {
  if (tab.type === "home") return "≡";
  if (tab.type === "session") return "◎";
  if (tab.type === "branchLog") return "⬡";
  return "·";
}

export function TabBar() {
  const { tabs, activeTabId, setActiveTab, closeTab, openSessionWindow, openBranchLogWindow } =
    useTabs();

  if (tabs.length <= 1) return null;

  return (
    <Box
      style={{
        display: "flex",
        flexDirection: "row",
        borderBottom:
          "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
        backgroundColor:
          "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-8))",
        overflowX: "auto",
        flexShrink: 0,
        minHeight: 32,
      }}
    >
      {tabs.map((tab) => (
        <TabItem
          key={tab.id}
          tab={tab}
          isActive={tab.id === activeTabId}
          onActivate={() => setActiveTab(tab.id)}
          onClose={tab.id !== "home" ? () => closeTab(tab.id) : undefined}
          onPopOut={
            tab.type === "session"
              ? () => {
                  openSessionWindow(tab.sessionId);
                  closeTab(tab.id);
                }
              : tab.type === "branchLog"
                ? () => {
                    openBranchLogWindow(tab.localPath, tab.branch, tab.repoName);
                    closeTab(tab.id);
                  }
                : undefined
          }
        />
      ))}
    </Box>
  );
}

function TabItem({
  tab,
  isActive,
  onActivate,
  onClose,
  onPopOut,
}: {
  tab: Tab;
  isActive: boolean;
  onActivate: () => void;
  onClose?: () => void;
  onPopOut?: () => void;
}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hasElectron = !!(window as any).electronAPI;

  return (
    <UnstyledButton
      onClick={onActivate}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        paddingLeft: 10,
        paddingRight: 4,
        paddingTop: 0,
        paddingBottom: 0,
        borderRight:
          "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
        backgroundColor: isActive
          ? "light-dark(var(--mantine-color-white), var(--mantine-color-dark-6))"
          : "transparent",
        borderBottom: isActive
          ? "2px solid var(--mantine-color-indigo-6)"
          : "2px solid transparent",
        cursor: "pointer",
        flexShrink: 0,
        maxWidth: 240,
        minHeight: 32,
      }}
    >
      <Text size="xs" c="dimmed" style={{ fontFamily: "monospace", flexShrink: 0 }}>
        {tabIcon(tab)}
      </Text>
      <Text
        size="xs"
        style={{
          maxWidth: 150,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
        }}
      >
        {tab.title}
      </Text>
      {onPopOut && hasElectron && (
        <Tooltip label="Pop out to window" withArrow position="top" openDelay={400}>
          <ActionIcon
            size="xs"
            variant="subtle"
            color="gray"
            onClick={(e) => {
              e.stopPropagation();
              onPopOut();
            }}
            style={{ flexShrink: 0 }}
          >
            ⊡
          </ActionIcon>
        </Tooltip>
      )}
      {onClose && (
        <ActionIcon
          size="xs"
          variant="subtle"
          color="gray"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          style={{ flexShrink: 0 }}
        >
          ×
        </ActionIcon>
      )}
    </UnstyledButton>
  );
}
