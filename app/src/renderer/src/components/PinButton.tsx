import React, { useState } from "react";
import { ActionIcon } from "@mantine/core";
import { pinEntity, unpinEntity } from "../api";

interface Props {
  entityType: "event" | "tool_call" | "checkpoint";
  entityId: string;
  style?: React.CSSProperties;
}

export function PinButton({ entityType, entityId, style }: Props) {
  const [pinned, setPinned] = useState(false);
  const [loading, setLoading] = useState(false);

  async function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (loading) return;
    setLoading(true);
    try {
      if (pinned) {
        await unpinEntity(entityType, entityId);
        setPinned(false);
      } else {
        await pinEntity(entityType, entityId);
        setPinned(true);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }

  return (
    <ActionIcon
      variant="subtle"
      color={pinned ? "yellow" : "gray"}
      size="sm"
      onClick={toggle}
      title={pinned ? "Unpin" : "Pin"}
      style={style}
    >
      {pinned ? "★" : "☆"}
    </ActionIcon>
  );
}
