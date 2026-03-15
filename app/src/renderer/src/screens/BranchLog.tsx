import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Center, Loader, Text, ScrollArea, Box, Button } from "@mantine/core";
import { fetchBranchLog, fetchLogEvents, type BranchLogEntry, type SessionCheckpoint } from "../api";
import type { UserInfo } from "../components/EventItem";
import { useBreadcrumb } from "../BreadcrumbContext";
import { EventItem } from "../components/EventItem";
import {
  logEventsToEvents,
  groupEvents,
  groupClaudeTurns,
  ClaudeTurnCard,
  CheckpointRow,
  type RenderItem,
} from "./SessionDetail";

function entryToCheckpoint(entry: BranchLogEntry): SessionCheckpoint {
  return {
    checkpointId: entry.checkpointId,
    branch:       entry.branch,
    cliVersion:   null,
    filesTouched: entry.filesTouched,
    tokenUsage:   entry.tokenUsage,
    createdAt:    entry.createdAt,
    summary:      entry.summary,
  };
}

function EntryDetail({
  entry,
  localPath,
  userInfo,
}: {
  entry: BranchLogEntry;
  localPath: string;
  userInfo: UserInfo | undefined;
}) {
  const navigate = useNavigate();
  const [renderItems, setRenderItems] = useState<RenderItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const checkpoint = entryToCheckpoint(entry);

  const handlePress = () => {
    if (!expanded) {
      setExpanded(true);
      if (renderItems === null && !loading) {
        setLoading(true);
        fetchLogEvents(entry.sessionId)
          .then((logEvents) => {
            setRenderItems(groupClaudeTurns(groupEvents(logEventsToEvents(logEvents))));
          })
          .catch(() => setRenderItems([]))
          .finally(() => setLoading(false));
      }
    } else {
      setExpanded(false);
    }
  };

  return (
    <React.Fragment>
      <CheckpointRow
        checkpoint={checkpoint}
        localPath={localPath}
        onPress={handlePress}
      />
      {expanded && (
        loading ? (
          <Center py="sm"><Loader size="xs" color="teal" /></Center>
        ) : renderItems !== null && renderItems.map((item, idx) => {
          const itemKey = item.kind === "claudeTurn"
            ? `${entry.checkpointId}-turn-${idx}`
            : item.kind === "checkpoint"
            ? `${entry.checkpointId}-cp-${(item as { checkpoint: SessionCheckpoint }).checkpoint.checkpointId}`
            : `${entry.checkpointId}-evt-${(item as { event: { id: number } }).event.id}`;
          return (
            <div key={itemKey}>
              {item.kind === "claudeTurn" ? (
                <ClaudeTurnCard toolGroups={item.toolGroups} stop={item.stop} />
              ) : item.kind === "checkpoint" ? (
                <CheckpointRow
                  checkpoint={(item as { checkpoint: SessionCheckpoint }).checkpoint}
                  localPath={localPath}
                  onPress={() => navigate(`/checkpoints/${(item as { checkpoint: SessionCheckpoint }).checkpoint.checkpointId}`, {
                    state: { title: (item as { checkpoint: SessionCheckpoint }).checkpoint.branch ?? (item as { checkpoint: SessionCheckpoint }).checkpoint.checkpointId, localPath },
                  })}
                />
              ) : (
                <EventItem event={(item as { event: Parameters<typeof EventItem>[0]["event"] }).event} user={userInfo} />
              )}
            </div>
          );
        })
      )}
    </React.Fragment>
  );
}

export function BranchLog() {
  const [searchParams] = useSearchParams();
  const localPath = searchParams.get("localPath") ?? "";
  const branch    = searchParams.get("branch")    ?? "";
  const repoName  = searchParams.get("repoName")  ?? null;

  const [items, setItems]             = useState<BranchLogEntry[]>([]);
  const [page, setPage]               = useState(0);
  const [hasMore, setHasMore]         = useState(false);
  const [loading, setLoading]         = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError]             = useState<string | null>(null);
  const { setCrumbs } = useBreadcrumb();

  useEffect(() => {
    setCrumbs([
      ...(repoName ? [{ label: repoName }] : []),
      { label: branch },
    ]);
    setLoading(true);
    setItems([]);
    setPage(0);
    fetchBranchLog(localPath, branch, 0)
      .then(({ entries, hasMore: more }) => {
        setItems(entries);
        setHasMore(more);
      })
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [localPath, branch]);

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

  return (
    <ScrollArea style={{ flex: 1 }}>
      <Box style={{ maxWidth: 860, margin: "0 auto", paddingBottom: 40 }}>
        {items.map((entry) => {
          const name = entry.gitUserName ?? entry.gitUserEmail ?? null;
          const userInfo: UserInfo | undefined = name
            ? { name, avatarUrl: entry.gitUserName ? `https://github.com/${entry.gitUserName}.png?size=40` : undefined }
            : undefined;
          return (
            <EntryDetail
              key={`${entry.checkpointId}-${entry.sessionId}`}
              entry={entry}
              localPath={localPath}
              userInfo={userInfo}
            />
          );
        })}
        {hasMore && (
          <Center py="xl">
            <Button variant="subtle" color="teal" loading={loadingMore} onClick={loadMore}>
              Load more
            </Button>
          </Center>
        )}
      </Box>
    </ScrollArea>
  );
}
