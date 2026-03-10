import React, { useEffect, useRef } from "react";
import { Portal, Box, UnstyledButton, Text } from "@mantine/core";

interface Props {
  x: number;
  y: number;
  pinned: boolean;
  onPin: () => void;
  onClose: () => void;
}

export function PinContextMenu({ x, y, pinned, onPin, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Close on any outside click, right-click, or Escape
    const onClick = () => onClose();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    // Defer so the triggering right-click doesn't immediately close the menu
    const t = setTimeout(() => {
      window.addEventListener("click", onClick);
      window.addEventListener("contextmenu", onClick);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener("click", onClick);
      window.removeEventListener("contextmenu", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Clamp to viewport so it doesn't render off-screen
  const menuW = 160;
  const menuH = 40;
  const left = Math.min(x, window.innerWidth - menuW - 8);
  const top  = Math.min(y, window.innerHeight - menuH - 8);

  return (
    <Portal>
      <Box
        ref={ref}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
        style={{
          position: "fixed",
          top,
          left,
          zIndex: 9999,
          minWidth: menuW,
          backgroundColor: "light-dark(var(--mantine-color-white), var(--mantine-color-dark-6))",
          border: "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
          borderRadius: 6,
          padding: "4px 0",
          boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
        }}
      >
        <UnstyledButton
          onClick={onPin}
          style={{ display: "block", width: "100%", padding: "6px 14px" }}
          styles={{ root: { "&:hover": { backgroundColor: "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-5))" } } }}
        >
          <Text size="sm">{pinned ? "★ Unpin" : "☆ Pin"}</Text>
        </UnstyledButton>
      </Box>
    </Portal>
  );
}
