import React, { useEffect, useRef, useState } from "react";
import {
  Center, Loader, Text, ScrollArea, Box, Badge, Group, Collapse, ActionIcon,
} from "@mantine/core";
import {
  fetchSession, fetchLogEvents, subscribeToUpdates,
  type Session, type LogEventItem,
} from "../api";
import { postToExtension } from "../vscodeApi";
import { EventItem } from "../components/EventItem";
import { ToolGroupItem, type ToolUseData } from "../components/ToolGroupItem";
import { MarkdownView } from "../components/MarkdownView";
import { TimeAgo } from "../components/TimeAgo";

// ── Types (mirrors Electron app's api.ts) ─────────────────────────────────────

export interface Event {
  id: number;
  timestamp: string;
  event: string;
  sessionId: string;
  blocked: boolean;
  data: unknown;
  summary: string | null;
  keywords: string[];
  _sourceLogEventId?: number;
  _extraSourceLogEventIds?: number[];
  _sourceUuid?: string;
}

export type DisplayItem =
  | { kind: "event"; event: Event }
  | { kind: "toolGroup"; tools: ToolUseData[] };

export type RenderItem =
  | { kind: "event"; event: Event }
  | { kind: "claudeTurn"; toolGroups: ToolUseData[][]; stop: Event | null };

// ── logEventsToEvents ─────────────────────────────────────────────────────────

function str(v: unknown): string { return typeof v === "string" ? v : ""; }

export function logEventsToEvents(logEvents: LogEventItem[]): Event[] {
  const result: Event[] = [];
  let id = -1;
  let lastAssistantText: string | null = null;
  let lastAssistantThinking: string | null = null;
  let lastAssistantLogEventId: number | null = null;
  let lastThinkingLogEventId: number | null = null;
  let lastThinkingUuid: string | null = null;
  let lastToolsLogEventId: number | null = null;
  let lastToolsUuid: string | null = null;
  let hasRedactedThinking = false;
  const currentTurnLogEventIds: number[] = [];

  const filtered = logEvents.filter(
    (e) => !e.isSidechain && e.type !== "file-history-snapshot" && e.type !== "progress",
  );

  const first = filtered[0];
  if (first) {
    result.push({ id: id--, timestamp: first.timestamp ?? "", event: "SessionStart", sessionId: first.sessionId ?? "", blocked: false, data: { cwd: first.cwd ?? "" }, summary: null, keywords: [], _sourceLogEventId: first.id });
  }

  for (const le of filtered) {
    const ts  = le.timestamp ?? "";
    const sid = le.sessionId ?? "";

    if (le.type === "user") {
      const toolResults = le.contents.filter((c) => c.contentType === "tool_result");
      const textBlocks  = le.contents.filter((c) => c.contentType === "text");
      const imageBlocks = le.contents.filter((c) => c.contentType === "image");

      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          const failed = tr.isError === true;
          result.push({ id: id--, timestamp: ts, event: failed ? "PostToolUseFailure" : "PostToolUse", sessionId: sid, blocked: false, data: { tool_use_id: tr.toolUseId, tool_response: !failed ? (tr.toolResultContent ?? "") : undefined, error: failed ? (tr.toolResultContent ?? "") : undefined }, summary: null, keywords: [], _sourceLogEventId: le.id, _sourceUuid: le.uuid ?? undefined });
        }
      } else if (textBlocks.length > 0 || imageBlocks.length > 0) {
        const prompt  = textBlocks.map((b) => b.text ?? "").join("\n\n");
        const images  = imageBlocks.map((b) => ({ data: b.imageData, mediaType: b.imageMediaType })).filter((b) => b.data);
        result.push({ id: id--, timestamp: ts, event: "UserPromptSubmit", sessionId: sid, blocked: false, data: { prompt, images }, summary: null, keywords: [], _sourceLogEventId: le.id, _sourceUuid: le.uuid ?? undefined });
      }

    } else if (le.type === "assistant") {
      const toolUses            = le.contents.filter((c) => c.contentType === "tool_use");
      const textBlocks          = le.contents.filter((c) => c.contentType === "text");
      const thinkingBlocks      = le.contents.filter((c) => c.contentType === "thinking");
      const redactedThinkingBlocks = le.contents.filter((c) => c.contentType === "redacted_thinking");

      if (!currentTurnLogEventIds.includes(le.id)) currentTurnLogEventIds.push(le.id);

      if (textBlocks.length > 0) {
        const newText = textBlocks.map((b) => b.text ?? "").filter(Boolean).join("\n\n");
        if (lastAssistantText !== null && lastToolsLogEventId !== null) {
          lastAssistantThinking = lastAssistantThinking ? lastAssistantThinking + "\n\n" + lastAssistantText : lastAssistantText;
        }
        lastAssistantText = newText;
        lastAssistantLogEventId = le.id;
      }
      if (thinkingBlocks.length > 0) {
        const thinking = thinkingBlocks.map((b) => b.thinking ?? "").filter(Boolean).join("\n\n");
        lastAssistantThinking = lastAssistantThinking ? lastAssistantThinking + "\n\n" + thinking : thinking;
        lastThinkingLogEventId = le.id;
        lastThinkingUuid = le.uuid ?? null;
        if (lastAssistantLogEventId === null) lastAssistantLogEventId = le.id;
      }
      if (redactedThinkingBlocks.length > 0) {
        hasRedactedThinking = true;
        if (lastAssistantLogEventId === null) lastAssistantLogEventId = le.id;
      }
      for (const tu of toolUses) {
        lastToolsLogEventId = le.id;
        lastToolsUuid = le.uuid ?? null;
        result.push({ id: id--, timestamp: ts, event: "PreToolUse", sessionId: sid, blocked: false, data: { tool_name: tu.toolName ?? "?", tool_use_id: tu.toolUseId, tool_input: tu.toolInput }, summary: null, keywords: [], _sourceLogEventId: le.id, _sourceUuid: le.uuid ?? undefined });
      }

    } else if (le.type === "system" && le.systemData?.subtype === "stop_hook_summary") {
      const primaryId = lastAssistantLogEventId ?? le.id;
      const extraIds  = currentTurnLogEventIds.filter((x) => x !== primaryId);
      result.push({ id: id--, timestamp: ts, event: "Stop", sessionId: sid, blocked: le.systemData.preventedContinuation ?? false, data: { last_assistant_message: lastAssistantText ?? "", thinking: lastAssistantThinking ?? "", reason: le.systemData.stopReason ?? "", thinkingLogEventId: lastThinkingLogEventId ?? undefined, thinkingUuid: lastThinkingUuid ?? undefined, toolsLogEventId: lastToolsLogEventId ?? undefined, toolsUuid: lastToolsUuid ?? undefined, hasRedactedThinking }, summary: null, keywords: [], _sourceLogEventId: primaryId, _extraSourceLogEventIds: extraIds.length > 0 ? extraIds : undefined });
      lastAssistantText = null; lastAssistantThinking = null; lastAssistantLogEventId = null;
      lastThinkingLogEventId = null; lastThinkingUuid = null; lastToolsLogEventId = null; lastToolsUuid = null;
      hasRedactedThinking = false; currentTurnLogEventIds.length = 0;
    }
  }

  if (lastAssistantText !== null && filtered.length > 0) {
    const last = filtered[filtered.length - 1];
    const primaryId = lastAssistantLogEventId ?? last.id;
    const extraIds  = currentTurnLogEventIds.filter((x) => x !== primaryId);
    result.push({ id: id--, timestamp: last.timestamp ?? "", event: "Stop", sessionId: last.sessionId ?? "", blocked: false, data: { last_assistant_message: lastAssistantText, thinking: lastAssistantThinking ?? "", reason: "" }, summary: null, keywords: [], _sourceLogEventId: primaryId, _extraSourceLogEventIds: extraIds.length > 0 ? extraIds : undefined });
  }

  return result;
}

// ── groupEvents ───────────────────────────────────────────────────────────────

export function groupEvents(events: Event[]): DisplayItem[] {
  const postMap = new Map<string, Event>();
  for (const event of events) {
    if (event.event === "PostToolUse" || event.event === "PostToolUseFailure") {
      const d = event.data as Record<string, unknown>;
      const id = typeof d.tool_use_id === "string" ? d.tool_use_id : null;
      if (id) postMap.set(id, event);
    }
  }

  type RawItem = { kind: "event"; event: Event } | { kind: "toolUse"; pre: Event; post?: Event; failed: boolean };
  const raw: RawItem[] = [];
  const consumed = new Set<number>();

  for (const event of events) {
    if ((event.event === "PostToolUse" || event.event === "PostToolUseFailure") && consumed.has(event.id)) continue;
    if (event.event === "PreToolUse") {
      const d = event.data as Record<string, unknown>;
      const toolUseId = typeof d.tool_use_id === "string" ? d.tool_use_id : null;
      const post = toolUseId ? postMap.get(toolUseId) : undefined;
      if (post) consumed.add(post.id);
      raw.push({ kind: "toolUse", pre: event, post, failed: post?.event === "PostToolUseFailure" });
      continue;
    }
    raw.push({ kind: "event", event });
  }

  const isGroupable = (item: RawItem) =>
    item.kind === "toolUse" || (item.kind === "event" && item.event.event === "Notification");

  const result: DisplayItem[] = [];
  let i = 0;
  while (i < raw.length) {
    if (isGroupable(raw[i])) {
      const group: ToolUseData[] = [];
      while (i < raw.length && isGroupable(raw[i])) {
        const item = raw[i];
        if (item.kind === "toolUse") group.push({ pre: item.pre, post: item.post, failed: item.failed });
        i++;
      }
      if (group.length > 0) result.push({ kind: "toolGroup", tools: group });
    } else {
      result.push({ kind: "event", event: (raw[i] as { kind: "event"; event: Event }).event });
      i++;
    }
  }
  return result;
}

// ── groupClaudeTurns ──────────────────────────────────────────────────────────

export function groupClaudeTurns(items: DisplayItem[]): RenderItem[] {
  const result: RenderItem[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    if (item.kind === "toolGroup") {
      const toolGroups: ToolUseData[][] = [];
      while (i < items.length && items[i].kind === "toolGroup") {
        toolGroups.push((items[i] as { kind: "toolGroup"; tools: ToolUseData[] }).tools);
        i++;
      }
      let stop: Event | null = null;
      if (i < items.length && items[i].kind === "event" && (items[i] as { kind: "event"; event: Event }).event.event === "Stop") {
        stop = (items[i] as { kind: "event"; event: Event }).event;
        i++;
      }
      result.push({ kind: "claudeTurn", toolGroups, stop });
    } else if (item.kind === "event" && item.event.event === "Stop") {
      result.push({ kind: "claudeTurn", toolGroups: [], stop: item.event });
      i++;
    } else {
      result.push({ kind: "event", event: (item as { kind: "event"; event: Event }).event });
      i++;
    }
  }
  return result;
}

// ── ClaudeTurnCard ────────────────────────────────────────────────────────────

function highlightText(text: string, terms: string[]): React.ReactNode {
  if (!terms.length) return text;
  const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const parts = text.split(new RegExp(`(${pattern})`, "gi"));
  return <>{parts.map((p, i) => i % 2 === 1 ? <mark key={i} style={{ background: "rgba(255,200,0,0.45)", borderRadius: 2, padding: "0 1px" }}>{p}</mark> : p)}</>;
}

function ClaudeTurnCard({ toolGroups, stop, matchTerms }: { toolGroups: ToolUseData[][]; stop: Event | null; matchTerms?: string[] }) {
  const d      = stop ? (stop.data ?? {}) as Record<string, unknown> : {};
  const msg    = str(d.last_assistant_message);
  const thinking = str(d.thinking);
  const reason = str(d.reason);
  const hasRedactedThinking = d.hasRedactedThinking === true;
  const totalTools = toolGroups.reduce((n, g) => n + g.length, 0);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);

  return (
    <Box style={{
      display: "flex",
      gap: 10,
      padding: "5px 12px",
      paddingLeft: 10,
      borderLeft: "2px solid var(--mantine-color-orange-5)",
      borderBottom: "1px solid var(--vscode-panel-border)",
      alignItems: "flex-start",
    }}>
      <Text
        size="xs"
        fw={600}
        style={{ width: 52, flexShrink: 0, paddingTop: 2, color: "var(--mantine-color-orange-5)", whiteSpace: "nowrap" }}
      >
        Claude
      </Text>
      <Box style={{ flex: 1, minWidth: 0 }}>
        {reason && <Badge color="orange" size="xs" variant="light" mb={4}>{reason}</Badge>}
        {!thinking && hasRedactedThinking && (
          <Text size="xs" c="dimmed" fs="italic" mb={4}>thinking (redacted)</Text>
        )}
        {thinking && (
          <Box mb={4}>
            <Group gap={6} style={{ cursor: "pointer" }} onClick={() => setThinkingExpanded((v) => !v)}>
              <Text size="xs" c="dimmed" fs="italic">thinking {thinkingExpanded ? "▲" : "▼"}</Text>
            </Group>
            <Collapse in={thinkingExpanded}>
              <Box mt={4} style={{ backgroundColor: "var(--vscode-textCodeBlock-background)", border: "1px solid var(--vscode-panel-border)", borderRadius: 4, padding: "8px 12px", fontFamily: "var(--vscode-editor-font-family, monospace)", fontSize: 12, lineHeight: 1.6, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--vscode-descriptionForeground)" }}>
                {highlightText(thinking, matchTerms ?? [])}
              </Box>
            </Collapse>
          </Box>
        )}
        {stop && msg && <Box mb={toolGroups.length > 0 ? 6 : 0}>{matchTerms?.length ? (
          <Text size="sm" style={{ whiteSpace: "pre-wrap", lineHeight: "18px" }}>
            {highlightText(msg, matchTerms)}
          </Text>
        ) : <MarkdownView text={msg} />}</Box>}
        {toolGroups.length > 0 && (
          <Box>
            <Group gap={6} style={{ cursor: "pointer" }} onClick={() => setToolsExpanded((v) => !v)}>
              <Text size="xs" c="dimmed">{totalTools} tool {totalTools === 1 ? "use" : "uses"}</Text>
              <Text size="xs" c="dimmed">{toolsExpanded ? "▲" : "▼"}</Text>
            </Group>
            <Collapse in={toolsExpanded}>
              <Box mt={4} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {toolGroups.map((tools, i) => <ToolGroupItem key={i} tools={tools} matchTerms={matchTerms} />)}
              </Box>
            </Collapse>
          </Box>
        )}
      </Box>
      <Box style={{ flexShrink: 0, paddingTop: 2 }}>
        {stop && <TimeAgo iso={stop.timestamp} />}
      </Box>
    </Box>
  );
}

// ── SessionDetail screen ──────────────────────────────────────────────────────

interface Props {
  sessionId: string;
  title: string;
  onBack?: () => void;
}

const highlightQuery = (window as unknown as Record<string, unknown>).__GOSSAMER_HIGHLIGHT__;
const HIGHLIGHT_TERMS: string[] = typeof highlightQuery === "string" && highlightQuery.trim()
  ? highlightQuery.trim().split(/\s+/).filter(Boolean)
  : [];

export function SessionDetail({ sessionId, title, onBack }: Props) {
  const [session, setSession]         = useState<Session | null>(null);
  const [renderItems, setRenderItems] = useState<RenderItem[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const initialLoadDone = useRef(false);
  const matchTerms = HIGHLIGHT_TERMS;

  async function load() {
    try {
      const [sess, logEvents] = await Promise.all([
        fetchSession(sessionId),
        fetchLogEvents(sessionId),
      ]);
      setSession(sess);
      const events  = logEventsToEvents(logEvents);
      const display = groupEvents(events);
      setRenderItems(groupClaudeTurns(display));
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }

  const didInitialScroll = useRef(false);

  useEffect(() => {
    initialLoadDone.current = false;
    didInitialScroll.current = false;
    load().finally(() => {
      setLoading(false);
      initialLoadDone.current = true;
    });
  }, [sessionId]);

  // Scroll after the initial render completes (loading → false flushes the content to DOM)
  useEffect(() => {
    if (loading || didInitialScroll.current) return;
    didInitialScroll.current = true;
    if (matchTerms.length > 0) {
      const mark = viewport.current?.querySelector("mark");
      mark?.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      const el = viewport.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [loading]);

  useEffect(() => {
    return subscribeToUpdates(() => { load().catch(() => undefined); });
  }, [sessionId]);

  // Auto-scroll only when new content arrives on a live session and user is already near bottom
  useEffect(() => {
    if (!initialLoadDone.current) return;
    if (!session?.isLive) return;
    const el = viewport.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }
  }, [renderItems]);

  if (loading) return <Center style={{ flex: 1 }}><Loader size="md" color="indigo" /></Center>;

  if (error) {
    return (
      <Center style={{ flex: 1, padding: 24 }}>
        <Text size="sm" c="red">{error}</Text>
      </Center>
    );
  }

  return (
    <Box style={{ flex: 1, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <Box style={{ borderBottom: "1px solid var(--vscode-panel-border)", flexShrink: 0 }}>
        <Group px={12} py={6} gap={8}>
          {onBack && (
            <ActionIcon variant="subtle" size="sm" onClick={onBack} title="Back to sessions">←</ActionIcon>
          )}
          <Text size="sm" fw={600} style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {session?.intent ?? session?.summary ?? title}
          </Text>
          {session?.branch && <Text size="xs" ff="monospace" c="teal">{session.branch}</Text>}
          {session?.isLive && <Badge size="xs" color="orange" variant="light">live</Badge>}
          <ActionIcon
            size="sm"
            variant="subtle"
            title="Resume session in terminal"
            onClick={() => postToExtension({ type: "resume_session", sessionId, cwd: session?.cwd ?? "" })}
          >▶</ActionIcon>
        </Group>
        {session && (
          <Group px={12} pb={5} gap={16}>
            {session.cwd && (
              <Text size="xs" c="dimmed" ff="monospace" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 320 }}>
                {session.cwd}
              </Text>
            )}
            {session.gitUserName && <Text size="xs" c="dimmed">{session.gitUserName}</Text>}
            <Text size="xs" c="dimmed">started <TimeAgo iso={session.startedAt} /></Text>
            <Text size="xs" c="dimmed">updated <TimeAgo iso={session.updatedAt} /></Text>
          </Group>
        )}
      </Box>

      {/* Body: events */}
      <ScrollArea style={{ flex: 1 }} viewportRef={viewport}>
        <Box pb={32}>
          {renderItems.map((item, i) => {
            if (item.kind === "claudeTurn") {
              return <ClaudeTurnCard key={i} toolGroups={item.toolGroups} stop={item.stop} matchTerms={matchTerms} />;
            }
            return <EventItem key={i} event={item.event} matchTerms={matchTerms} />;
          })}
        </Box>
      </ScrollArea>
    </Box>
  );
}

