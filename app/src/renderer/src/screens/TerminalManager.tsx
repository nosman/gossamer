import React from "react";
import { Box, Group, Text, UnstyledButton, ActionIcon } from "@mantine/core";
import { Terminal } from "./Terminal";
import type { TerminalTab } from "../TerminalContext";

interface TerminalManagerProps {
  tabs: TerminalTab[];
  activeTabId: string | null;
  visible: boolean;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
}

export function TerminalManager({
  tabs,
  activeTabId,
  visible,
  onSelectTab,
  onCloseTab,
  onNewTab,
}: TerminalManagerProps) {
  return (
    <Box
      style={{
        display: visible ? "flex" : "none",
        flexDirection: "column",
        flex: 1,
        overflow: "hidden",
        height: "100%",
      }}
    >
      {/* Tab bar */}
      <Group
        gap={0}
        style={{
          borderBottom: "1px solid var(--mantine-color-dark-4)",
          backgroundColor: "var(--mantine-color-dark-8)",
          flexShrink: 0,
          overflowX: "auto",
        }}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <Group
              key={tab.id}
              gap={4}
              style={{
                borderRight: "1px solid var(--mantine-color-dark-4)",
                backgroundColor: isActive
                  ? "var(--mantine-color-dark-7)"
                  : "transparent",
                borderBottom: isActive
                  ? "2px solid var(--mantine-color-blue-5)"
                  : "2px solid transparent",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              <UnstyledButton
                onClick={() => onSelectTab(tab.id)}
                px={12}
                py={6}
              >
                <Text size="xs" c={isActive ? "white" : "dimmed"} style={{ fontFamily: "monospace" }}>
                  {tab.label}
                </Text>
              </UnstyledButton>
              <ActionIcon
                size="xs"
                variant="subtle"
                color="gray"
                mr={4}
                onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
                title="Close terminal"
                style={{ opacity: 0.6 }}
              >
                ×
              </ActionIcon>
            </Group>
          );
        })}
        <ActionIcon
          size="sm"
          variant="subtle"
          color="gray"
          mx={6}
          onClick={onNewTab}
          title="New terminal"
        >
          +
        </ActionIcon>
      </Group>

      {/* Terminal panels — all mounted, only active one visible */}
      <Box style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {tabs.map((tab) => (
          <Box
            key={tab.id}
            style={{
              position: "absolute",
              inset: 0,
              display: tab.id === activeTabId ? "block" : "none",
            }}
          >
            <Terminal
              id={tab.id}
              active={visible && tab.id === activeTabId}
              cwd={tab.cwd}
            />
          </Box>
        ))}
      </Box>
    </Box>
  );
}
