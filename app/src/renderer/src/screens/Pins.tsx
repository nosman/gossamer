import React, { useEffect, useState } from "react";
import {
  ScrollArea, Box, Text, Badge, Center, Loader, Group, Collapse, UnstyledButton,
} from "@mantine/core";
import {
  fetchPins,
  type PinsResponse,
  type PinFolder,
  type PinnedEntity,
  type PinnedEntityEvent,
  type PinnedEntityToolCall,
  type PinnedEntityCheckpoint,
} from "../api";
import { useBreadcrumb } from "../BreadcrumbContext";

// ─── Entity-type renderers ────────────────────────────────────────────────────

const EVENT_BADGE_COLOR: Record<string, string> = {
  UserPromptSubmit:    "blue",
  Stop:                "red",
  SessionStart:        "green",
  SessionEnd:          "gray",
  PreToolUse:          "violet",
  PostToolUse:         "teal",
  PostToolUseFailure:  "orange",
  Notification:        "yellow",
};

function EventPinBody({ entity }: { entity: PinnedEntityEvent }) {
  const color = EVENT_BADGE_COLOR[entity.event] ?? "gray";
  return (
    <Group gap={8} wrap="nowrap">
      <Badge color={color} size="xs" variant="light" style={{ flexShrink: 0 }}>
        {entity.event}
      </Badge>
      <Text size="xs" ff="monospace" c="dimmed" style={{ flexShrink: 0 }}>
        {entity.sessionId.slice(0, 8)}
      </Text>
      {entity.summary && (
        <Text size="xs" c="dimmed" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {entity.summary}
        </Text>
      )}
    </Group>
  );
}

function extractToolName(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  // message.content[] — look for a tool_use block
  const content = (d.message as Record<string, unknown> | undefined)?.content;
  if (Array.isArray(content)) {
    for (const block of content as unknown[]) {
      if (block && typeof block === "object") {
        const b = block as Record<string, unknown>;
        if (b.type === "tool_use" && typeof b.name === "string") return b.name;
      }
    }
  }
  // direct name field
  if (typeof d.name === "string") return d.name;
  return null;
}

function ToolCallPinBody({ entity }: { entity: PinnedEntityToolCall }) {
  const toolName = extractToolName(entity.data);
  return (
    <Group gap={8} wrap="nowrap">
      <Badge color="violet" size="xs" variant="light" style={{ flexShrink: 0 }}>
        Tool Call
      </Badge>
      {toolName && (
        <Text size="xs" ff="monospace" style={{ flexShrink: 0 }}>{toolName}</Text>
      )}
      <Text size="xs" ff="monospace" c="dimmed" style={{ flexShrink: 0 }}>
        {entity.sessionId.slice(0, 8)}
      </Text>
    </Group>
  );
}

function CheckpointPinBody({ entity }: { entity: PinnedEntityCheckpoint }) {
  return (
    <Group gap={8} wrap="nowrap">
      <Badge color="teal" size="xs" variant="light" style={{ flexShrink: 0 }}>
        Checkpoint
      </Badge>
      <Text size="xs" ff="monospace" c="dimmed" style={{ flexShrink: 0 }}>
        {entity.checkpointId.slice(0, 10)}
      </Text>
      {entity.branch && (
        <Badge color="gray" size="xs" variant="outline" style={{ flexShrink: 0 }}>
          {entity.branch}
        </Badge>
      )}
      {entity.summary?.intent && (
        <Text size="xs" c="dimmed" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {entity.summary.intent}
        </Text>
      )}
    </Group>
  );
}

function PinRow({ pin }: { pin: PinnedEntity }) {
  const { entity, entityType } = pin;

  let body: React.ReactNode;
  if (!entity) {
    body = (
      <Group gap={8}>
        <Badge color="gray" size="xs" variant="outline">{entityType}</Badge>
        <Text size="xs" c="dimmed" ff="monospace">{pin.entityId.slice(0, 16)}</Text>
        <Text size="xs" c="red">not found</Text>
      </Group>
    );
  } else if (entityType === "event") {
    body = <EventPinBody entity={entity as PinnedEntityEvent} />;
  } else if (entityType === "tool_call") {
    body = <ToolCallPinBody entity={entity as PinnedEntityToolCall} />;
  } else {
    body = <CheckpointPinBody entity={entity as PinnedEntityCheckpoint} />;
  }

  return (
    <Box
      style={{
        padding: "6px 10px",
        borderBottom: "1px solid light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-5))",
      }}
    >
      {body}
    </Box>
  );
}

// ─── Folder section ───────────────────────────────────────────────────────────

function FolderSection({ folder }: { folder: PinFolder }) {
  const [open, setOpen] = useState(true);
  return (
    <Box mb={4}>
      <UnstyledButton
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          padding: "6px 10px",
          backgroundColor: "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))",
          borderBottom: "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
        }}
      >
        <Group gap={6}>
          <Text size="xs" c="dimmed" style={{ width: 10 }}>{open ? "▼" : "▶"}</Text>
          <Text size="sm" fw={600}>{folder.name}</Text>
          <Text size="xs" c="dimmed">({folder.pins.length})</Text>
        </Group>
      </UnstyledButton>
      <Collapse in={open}>
        {folder.pins.length === 0 ? (
          <Text size="xs" c="dimmed" px={10} py={6}>No pins in this folder.</Text>
        ) : (
          folder.pins.map((pin) => <PinRow key={pin.id} pin={pin} />)
        )}
      </Collapse>
    </Box>
  );
}

function UnfolderedSection({ pins }: { pins: PinnedEntity[] }) {
  const [open, setOpen] = useState(true);
  if (pins.length === 0) return null;
  return (
    <Box mb={4}>
      <UnstyledButton
        onClick={() => setOpen((v) => !v)}
        style={{
          width: "100%",
          padding: "6px 10px",
          backgroundColor: "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))",
          borderBottom: "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
        }}
      >
        <Group gap={6}>
          <Text size="xs" c="dimmed" style={{ width: 10 }}>{open ? "▼" : "▶"}</Text>
          <Text size="sm" fw={600} c="dimmed">Unfoldered</Text>
          <Text size="xs" c="dimmed">({pins.length})</Text>
        </Group>
      </UnstyledButton>
      <Collapse in={open}>
        {pins.map((pin) => <PinRow key={pin.id} pin={pin} />)}
      </Collapse>
    </Box>
  );
}

// ─── Main screen ──────────────────────────────────────────────────────────────

export function Pins() {
  const { setCrumbs } = useBreadcrumb();
  const [data, setData] = useState<PinsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setCrumbs([{ label: "Pins" }]);
  }, [setCrumbs]);

  useEffect(() => {
    fetchPins()
      .then(setData)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  if (error) {
    return (
      <Center style={{ flex: 1 }}>
        <Text c="red" size="sm">{error}</Text>
      </Center>
    );
  }

  if (!data) {
    return (
      <Center style={{ flex: 1 }}>
        <Loader size="sm" />
      </Center>
    );
  }

  const totalPins = data.folders.reduce((n, f) => n + f.pins.length, 0) + data.unfoldered.length;

  return (
    <ScrollArea style={{ flex: 1, height: "100%" }}>
      <Box>
        {totalPins === 0 ? (
          <Center py={60}>
            <Text c="dimmed" size="sm">No pins yet. Pin events, tool calls, or checkpoints to see them here.</Text>
          </Center>
        ) : (
          <>
            {data.folders.map((folder) => (
              <FolderSection key={folder.id} folder={folder} />
            ))}
            <UnfolderedSection pins={data.unfoldered} />
          </>
        )}
      </Box>
    </ScrollArea>
  );
}
