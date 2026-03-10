import React, { useState, useCallback } from "react";
import { pinEntity, unpinEntity } from "../api";
import { PinContextMenu } from "./PinContextMenu";

type EntityType = "event" | "tool_call" | "checkpoint";

export function usePinContextMenu(entityType: EntityType, entityId: string) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [pinned, setPinned] = useState(false);

  const onContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenuPos({ x: e.clientX, y: e.clientY });
  }, []);

  const close = useCallback(() => setMenuPos(null), []);

  const handlePin = useCallback(async () => {
    close();
    try {
      if (pinned) {
        await unpinEntity(entityType, entityId);
        setPinned(false);
      } else {
        await pinEntity(entityType, entityId);
        setPinned(true);
      }
    } catch { /* ignore */ }
  }, [pinned, entityType, entityId, close]);

  const menuElement = menuPos ? (
    <PinContextMenu
      x={menuPos.x}
      y={menuPos.y}
      pinned={pinned}
      onPin={handlePin}
      onClose={close}
    />
  ) : null;

  return { onContextMenu, menuElement, pinned };
}
