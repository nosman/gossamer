import React, { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Center, Loader, Text, ScrollArea, Box, Button, Badge, Group, UnstyledButton } from "@mantine/core";
import { fetchBranchLog, fetchLogEvents, type BranchLogEntry, type LogEventItem, type SessionCheckpoint } from "../api";
import type { UserInfo } from "../components/EventItem";
import { useBreadcrumb } from "../BreadcrumbContext";
import { EventItem } from "../components/EventItem";
import { TimeAgo } from "../components/TimeAgo";
import {
  logEventsToEvents,
  groupEvents,
  groupClaudeTurns,
  ClaudeTurnCard,
  CheckpointRow,
  type RenderItem,
} from "./SessionDetail";

function entryKey(entry: BranchLogEntry): string {
  return `${entry.sessionId}:${entry.checkpointId}`;
}

/** Returns only the log events that belong to the selected checkpoint's time window. */
function filterEventsForEntry(
  entry: BranchLogEntry,
  sessionEntries: BranchLogEntry[],
  logEvents: LogEventItem[],
): LogEventItem[] {
  const sorted = [...sessionEntries].sort((a, b) =>
    (a.createdAt ?? "") < (b.createdAt ?? "") ? -1 : 1,
  );
  return logEvents.filter((ev) => {
    const evTime = ev.timestamp ?? "";
    for (const cp of sorted) {
      if (evTime <= (cp.createdAt ?? "")) {
        return cp.checkpointId === entry.checkpointId;
      }
    }
    return false;
  });
}

function entryToCheckpoint(entry: BranchLogEntry): SessionCheckpoint {
  return {
    checkpointId:  entry.checkpointId,
    branch:        entry.branch,
    cliVersion:    null,
    filesTouched:  entry.filesTouched,
    tokenUsage:    entry.tokenUsage,
    createdAt:     entry.createdAt,
    summary:       entry.summary,
    commitMessage: entry.commitMessage,
    commitHash:    entry.commitHash,
  };
}

export function BranchLog() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const localPath = searchParams.get("localPath") ?? "";
  const branch    = searchParams.get("branch")    ?? "";
  const repoName  = searchParams.get("repoName")  ?? null;

  const [items, setItems]               = useState<BranchLogEntry[]>([]);
  const [page, setPage]                 = useState(0);
  const [hasMore, setHasMore]           = useState(false);
  const [loading, setLoading]           = useState(true);
  const [loadingMore, setLoadingMore]   = useState(false);
  const [error, setError]               = useState<string | null>(null);

  const [selectedId, setSelectedId]     = useState<string | null>(null);
  const [rightItems, setRightItems]     = useState<RenderItem[]>([]);
  const [rightLoading, setRightLoading] = useState(false);

  // Cache raw log events per sessionId to avoid redundant fetches
  const sessionEventsCache = useRef<Map<string, LogEventItem[]>>(new Map());

  const { setCrumbs } = useBreadcrumb();

  function applyEntry(entry: BranchLogEntry, allItems: BranchLogEntry[], cachedEvents: LogEventItem[]) {
    const sessionEntries = allItems.filter((e) => e.sessionId === entry.sessionId);
    const filtered = filterEventsForEntry(entry, sessionEntries, cachedEvents);
    setRightItems(groupClaudeTurns(groupEvents(logEventsToEvents(filtered))));
  }

  function loadRightPanel(entry: BranchLogEntry, allItems: BranchLogEntry[]) {
    const cached = sessionEventsCache.current.get(entry.sessionId);
    if (cached) {
      applyEntry(entry, allItems, cached);
      return;
    }
    setRightLoading(true);
    fetchLogEvents(entry.sessionId)
      .then((logEvents) => {
        sessionEventsCache.current.set(entry.sessionId, logEvents);
        applyEntry(entry, allItems, logEvents);
      })
      .catch(() => setRightItems([]))
      .finally(() => setRightLoading(false));
  }

  useEffect(() => {
    setCrumbs([
      ...(repoName ? [{ label: repoName }] : []),
      { label: branch },
    ]);
    setLoading(true);
    setItems([]);
    setPage(0);
    setSelectedId(null);
    setRightItems([]);
    sessionEventsCache.current.clear();
    fetchBranchLog(localPath, branch, 0)
      .then(({ entries, hasMore: more }) => {
        setItems(entries);
        setHasMore(more);
        if (entries.length > 0) {
          setSelectedId(entryKey(entries[0]));
          loadRightPanel(entries[0], entries);
        }
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [localPath, branch]);

  function handleSelectEntry(entry: BranchLogEntry, allItems: BranchLogEntry[]) {
    const key = entryKey(entry);
    if (selectedId === key) return;
    setSelectedId(key);
    loadRightPanel(entry, allItems);
  }

  const loadMore = () => {
    const nextPage = page + 1;
    setLoadingMore(true);
    fetchBranchLog(localPath, branch, nextPage)
      .then(({ entries, hasMore: more }) => {
        setItems((prev) => [...prev, ...entries]);
        setPage(nextPage);
        setHasMore(more);
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoadingMore(false));
  };

  if (loading) return <Center style={{ flex: 1 }}><Loader size="md" color="teal" /></Center>;
  if (error)   return <Center style={{ flex: 1 }}><Text c="red">{error}</Text></Center>;

  if (items.length === 0) {
    return (
      <Center style={{ flex: 1 }}>
        <Text c="dimmed" size="sm">No checkpoints found on branch <Text span ff="monospace">{branch}</Text>.</Text>
      </Center>
    );
  }

  const selectedEntry = items.find((e) => entryKey(e) === selectedId) ?? null;
  const userInfo: UserInfo | undefined = selectedEntry
    ? (() => {
        const name = selectedEntry.gitUserName ?? selectedEntry.gitUserEmail ?? null;
        return name
          ? { name, avatarUrl: selectedEntry.gitUserName ? `https://github.com/${selectedEntry.gitUserName}.png?size=40` : undefined }
          : undefined;
      })()
    : undefined;

  return (
    <Box style={{ flex: 1, display: "flex", overflow: "hidden" }}>

      {/* ── Left: checkpoint list (1/3) ──────────────────────────────── */}
      <Box style={{
        width: "33%",
        minWidth: 220,
        maxWidth: 340,
        borderRight: "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
        overflowY: "auto",
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
      }}>
        {items.map((entry) => {
          const label = entry.summary?.intent ?? entry.commitMessage ?? null;
          const isSelected = selectedId === entryKey(entry);
          return (
            <UnstyledButton
              key={`${entry.checkpointId}-${entry.sessionId}`}
              onClick={() => handleSelectEntry(entry, items)}
              style={{
                width: "100%",
                padding: "10px 14px",
                borderBottom: "1px solid light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-5))",
                backgroundColor: isSelected
                  ? "light-dark(var(--mantine-color-teal-0), var(--mantine-color-dark-5))"
                  : undefined,
              }}
            >
              {label && (
                <Text size="xs" c="dimmed" lineClamp={2} mb={4}>{label}</Text>
              )}
              <Group gap={6} wrap="nowrap">
                <Text size="xs" ff="monospace" c="teal" style={{ flexShrink: 0 }}>{entry.checkpointId}</Text>
                {entry.commitHash && (
                  <Text size="xs" ff="monospace" c="dimmed" style={{ flexShrink: 0 }}>{entry.commitHash.slice(0, 7)}</Text>
                )}
                {entry.branch && <Badge variant="light" color="teal" size="xs" style={{ flexShrink: 0 }}>{entry.branch}</Badge>}
              </Group>
              {entry.createdAt && (
                <Text size="xs" c="dimmed" mt={2}><TimeAgo iso={entry.createdAt} /></Text>
              )}
            </UnstyledButton>
          );
        })}
        {hasMore && (
          <Box p="md">
            <Button variant="subtle" color="teal" loading={loadingMore} onClick={loadMore} size="xs" fullWidth>
              Load more
            </Button>
          </Box>
        )}
      </Box>

      {/* ── Right: events panel (2/3) ─────────────────────────────────── */}
      <ScrollArea style={{ flex: 1 }}>
        <Box style={{ maxWidth: 860, margin: "0 auto", paddingBottom: 40 }}>
          {rightLoading ? (
            <Center p="xl"><Loader size="sm" color="teal" /></Center>
          ) : rightItems.length === 0 ? (
            <Center p="xl"><Text c="dimmed" size="sm">No events for this checkpoint.</Text></Center>
          ) : (
            rightItems.map((item, idx) => {
              const key = item.kind === "claudeTurn" ? `turn-${idx}`
                : item.kind === "checkpoint" ? `cp-${item.checkpoint.checkpointId}`
                : `evt-${item.event.id}`;
              return (
                <div key={key}>
                  {item.kind === "claudeTurn" ? (
                    <ClaudeTurnCard toolGroups={item.toolGroups} stop={item.stop} />
                  ) : item.kind === "checkpoint" ? (
                    <CheckpointRow
                      checkpoint={item.checkpoint}
                      localPath={localPath}
                      onPress={() => navigate(`/checkpoints/${item.checkpoint.checkpointId}`, {
                        state: { title: item.checkpoint.branch ?? item.checkpoint.checkpointId, localPath },
                      })}
                    />
                  ) : (
                    <EventItem event={item.event} user={userInfo} />
                  )}
                </div>
              );
            })
          )}
        </Box>
      </ScrollArea>
    </Box>
  );
}
