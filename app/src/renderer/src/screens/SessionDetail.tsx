import React, { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams, useLocation } from "react-router-dom";
import { useBreadcrumb } from "../BreadcrumbContext";
import { Center, Loader, Text, ScrollArea, Box, Badge, Group, UnstyledButton, Collapse, Checkbox, ActionIcon, Tooltip, Menu } from "@mantine/core";
import {
  fetchSession,
  fetchLogEvents,
  fetchSessionCheckpoints,
  fetchCheckpointDiff,
  spawnSession,
  updateOpenItemStatus,
  subscribeToUpdates,
  type Session,
  type Event,
  type SessionCheckpoint,
  type OpenItem,
  type LogEventItem,
} from "../api";
import { EventItem, type UserInfo } from "../components/EventItem";
import { ToolGroupItem, type ToolUseData } from "../components/ToolGroupItem";
import { MarkdownView, InlineMarkdown } from "../components/MarkdownView";
import { html as diff2htmlHtml } from "diff2html";
import "diff2html/bundles/css/diff2html.min.css";
import "../diff2html-theme.css";
import { TimeAgo } from "../components/TimeAgo";
import claudeLogo from "../assets/claude-logo.png";

export type DisplayItem =
  | { kind: "event"; event: Event }
  | { kind: "toolGroup"; tools: ToolUseData[] }
  | { kind: "checkpoint"; checkpoint: SessionCheckpoint };

export type RenderItem =
  | { kind: "event"; event: Event }
  | { kind: "claudeTurn"; toolGroups: ToolUseData[][]; stop: Event | null }
  | { kind: "checkpoint"; checkpoint: SessionCheckpoint };

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
    } else if (item.kind === "checkpoint") {
      result.push({ kind: "checkpoint", checkpoint: item.checkpoint });
      i++;
    } else {
      result.push({ kind: "event", event: (item as { kind: "event"; event: Event }).event });
      i++;
    }
  }
  return result;
}

function str(v: unknown): string { return typeof v === "string" ? v : ""; }

function highlightText(text: string, terms: string[]): React.ReactNode {
  if (!terms.length) return text;
  const pattern = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const parts = text.split(new RegExp(`(${pattern})`, "gi"));
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1
          ? <mark key={i} style={{ background: "rgba(255,200,0,0.45)", borderRadius: 2, padding: "0 1px" }}>{p}</mark>
          : p
      )}
    </>
  );
}

export function ClaudeTurnCard({ toolGroups, stop, isTarget, matchTerms, expandTools, expandThinking, targetLogEventId }: {
  toolGroups: ToolUseData[][];
  stop: Event | null;
  isTarget?: boolean;
  matchTerms?: string[];
  expandTools?: boolean;
  expandThinking?: boolean;
  targetLogEventId?: number | null;
}) {
  const d = stop ? (stop.data ?? {}) as Record<string, unknown> : {};
  const msg = str(d.last_assistant_message);
  const thinking = str(d.thinking);
  const reason = str(d.reason);
  const thinkingLogEventId = typeof d.thinkingLogEventId === "number" ? d.thinkingLogEventId : null;
  const thinkingUuid = typeof d.thinkingUuid === "string" ? d.thinkingUuid : null;
  const toolsLogEventId = typeof d.toolsLogEventId === "number" ? d.toolsLogEventId : null;
  const toolsUuid = typeof d.toolsUuid === "string" ? d.toolsUuid : null;
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [thinkingExpanded, setThinkingExpanded] = useState(false);
  const totalTools = toolGroups.reduce((n, g) => n + g.length, 0);

  useEffect(() => {
    if (expandThinking && thinking) setThinkingExpanded(true);
  }, [expandThinking, thinking]);

  useEffect(() => {
    if (expandTools && totalTools > 0) setToolsExpanded(true);
  }, [expandTools, totalTools]);

  return (
    <Box style={{ display: "flex", padding: "12px 20px 4px", gap: 10 }}>
      <img src={claudeLogo} alt="Claude" style={{ width: 28, height: 28, borderRadius: "50%", flexShrink: 0, marginTop: 2 }} />
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Group gap={8} mb={6} align="center">
          <Text size="xs" fw={600} c="orange">Claude</Text>
          {reason && <Badge color="orange" size="xs" variant="light">{reason}</Badge>}
          {stop && <TimeAgo iso={stop.timestamp} />}
        </Group>
        {thinking && (
          <Box mb={6} id={thinkingUuid ?? (thinkingLogEventId != null ? `log-event-${thinkingLogEventId}` : undefined)}>
            <Group
              gap={6}
              mb={4}
              style={{ cursor: "pointer" }}
              onClick={() => setThinkingExpanded((v) => !v)}
            >
              <Text size="xs" c="dimmed" fs="italic">thinking {thinkingExpanded ? "▲" : "▼"}</Text>
            </Group>
            <Collapse in={thinkingExpanded}>
              <Box style={{
                backgroundColor: "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-7))",
                border: "1px solid light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-5))",
                borderRadius: 8,
                padding: "10px 14px",
                fontFamily: "monospace",
                fontSize: 12,
                lineHeight: 1.6,
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                color: "light-dark(var(--mantine-color-gray-7), var(--mantine-color-gray-4))",
              }}>
                {highlightText(thinking, matchTerms ?? [])}
              </Box>
            </Collapse>
          </Box>
        )}
        {stop && msg && (
          <Box style={{
            backgroundColor: "light-dark(var(--mantine-color-white), var(--mantine-color-dark-6))",
            border: "1px solid light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-4))",
            borderRadius: "2px 14px 14px 14px",
            padding: "12px 16px",
            marginBottom: toolGroups.length > 0 ? 8 : 0,
          }}>
            <MarkdownView text={msg} highlightTerms={matchTerms} />
          </Box>
        )}
        {toolGroups.length > 0 && (
          <Box id={toolsUuid ?? (toolsLogEventId != null ? `log-event-${toolsLogEventId}` : undefined)}>
            <Group
              gap={6}
              mb={4}
              style={{ cursor: "pointer" }}
              onClick={() => setToolsExpanded((v) => !v)}
            >
              <Text size="xs" c="dimmed">
                {totalTools} tool {totalTools === 1 ? "use" : "uses"}
              </Text>
              <Text size="xs" c="dimmed">{toolsExpanded ? "▲" : "▼"}</Text>
            </Group>
            <Collapse in={toolsExpanded}>
              <Box style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {toolGroups.map((tools, i) => (
                  <ToolGroupItem key={i} tools={tools} autoExpand={expandTools} matchTerms={matchTerms} targetLogEventId={expandTools ? targetLogEventId : null} />
                ))}
              </Box>
            </Collapse>
          </Box>
        )}
      </Box>
    </Box>
  );
}

// TODO: we're dropping the UUIDs from LogEventItems, or at least mixing them up into currentTurnLogEventIds.
// We need to attach these UUIDs to the components that these generate. That way the scrolling will work.
/**
 * Convert LogEventItems (from full.jsonl tables) into pseudo-Event objects that
 * match the shape the existing UI components expect.  This lets all downstream
 * grouping and rendering code remain unchanged.
 */
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
  // All LogEvent IDs seen in the current assistant turn (thinking, text, tool_use may be separate events)
  const currentTurnLogEventIds: number[] = [];

  // TODO: look at which event types are useful.
  const filtered = logEvents.filter(
    (e) => !e.isSidechain && e.type !== "file-history-snapshot" && e.type !== "progress",
  );

  // Virtual SessionStart divider
  const first = filtered[0];
  if (first) {
    result.push({ id: id--, timestamp: first.timestamp ?? "", event: "SessionStart", sessionId: first.sessionId ?? "", blocked: false, data: { cwd: first.cwd ?? "" }, summary: null, keywords: [], _sourceLogEventId: first.id });
  }

  for (const le of filtered) {
    const ts  = le.timestamp ?? "";
    const sid = le.sessionId ?? "";

    if (le.type === "user") {
      const toolResults = le.contents.filter((c) => c.contentType === "tool_result");
      // TODO: show images and other content types
      const textBlocks  = le.contents.filter((c) => c.contentType === "text");

      if (toolResults.length > 0) {
        for (const tr of toolResults) {
          const failed = tr.isError === true;
          result.push({
            id: id--,
            timestamp: ts,
            event: failed ? "PostToolUseFailure" : "PostToolUse",
            sessionId: sid,
            blocked: false,
            data: {
              tool_use_id:   tr.toolUseId,
              tool_response: !failed ? (tr.toolResultContent ?? "") : undefined,
              error:          failed ? (tr.toolResultContent ?? "") : undefined,
            },
            summary: null, keywords: [], _sourceLogEventId: le.id, _sourceUuid: le.uuid ?? undefined,
          });
        }
      } else if (textBlocks.length > 0) {
        const prompt = textBlocks.map((b) => b.text ?? "").join("\n\n");
        result.push({ id: id--, timestamp: ts, event: "UserPromptSubmit", sessionId: sid, blocked: false, data: { prompt }, summary: null, keywords: [], _sourceLogEventId: le.id, _sourceUuid: le.uuid ?? undefined });
      }

    } else if (le.type === "assistant") {
      const toolUses      = le.contents.filter((c) => c.contentType === "tool_use");
      const textBlocks    = le.contents.filter((c) => c.contentType === "text");
      const thinkingBlocks = le.contents.filter((c) => c.contentType === "thinking");

      // Track all LogEvent IDs in this turn so thinking-only events are reachable
      if (!currentTurnLogEventIds.includes(le.id)) currentTurnLogEventIds.push(le.id);

      if (textBlocks.length > 0) {
        const newText = textBlocks.map((b) => b.text ?? "").filter(Boolean).join("\n\n");
        // If there was already planning text and tool uses have been emitted since,
        // fold the planning text into the thinking block so it isn't lost.
        if (lastAssistantText !== null && lastToolsLogEventId !== null) {
          lastAssistantThinking = lastAssistantThinking
            ? lastAssistantThinking + "\n\n" + lastAssistantText
            : lastAssistantText;
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

      for (const tu of toolUses) {
        lastToolsLogEventId = le.id;
        lastToolsUuid = le.uuid ?? null;
        result.push({
          id: id--,
          timestamp: ts,
          event: "PreToolUse",
          sessionId: sid,
          blocked: false,
          data: { tool_name: tu.toolName ?? "?", tool_use_id: tu.toolUseId, tool_input: tu.toolInput },
          summary: null, keywords: [], _sourceLogEventId: le.id, _sourceUuid: le.uuid ?? undefined,
        });
      }

    } else if (le.type === "system" && le.systemData?.subtype === "stop_hook_summary") {
      const primaryId = lastAssistantLogEventId ?? le.id;
      const extraIds = currentTurnLogEventIds.filter((x) => x !== primaryId);
      result.push({
        id: id--,
        timestamp: ts,
        event: "Stop",
        sessionId: sid,
        blocked: le.systemData.preventedContinuation ?? false,
        data: {
          last_assistant_message: lastAssistantText ?? "",
          thinking: lastAssistantThinking ?? "",
          reason: le.systemData.stopReason ?? "",
          thinkingLogEventId: lastThinkingLogEventId ?? undefined,
          thinkingUuid: lastThinkingUuid ?? undefined,
          toolsLogEventId: lastToolsLogEventId ?? undefined,
          toolsUuid: lastToolsUuid ?? undefined,
        },
        summary: null, keywords: [],
        _sourceLogEventId: primaryId,
        _extraSourceLogEventIds: extraIds.length > 0 ? extraIds : undefined,
      });
      lastAssistantText = null;
      lastAssistantThinking = null;
      lastAssistantLogEventId = null;
      lastThinkingLogEventId = null;
      lastThinkingUuid = null;
      lastToolsLogEventId = null;
      lastToolsUuid = null;
      currentTurnLogEventIds.length = 0;
    }
  }

  // Flush any trailing assistant text that had no stop event
  if (lastAssistantText !== null && filtered.length > 0) {
    const last = filtered[filtered.length - 1];
    const primaryId = lastAssistantLogEventId ?? last.id;
    const extraIds = currentTurnLogEventIds.filter((x) => x !== primaryId);
    result.push({
      id: id--,
      timestamp: last.timestamp ?? "",
      event: "Stop",
      sessionId: last.sessionId ?? "",
      blocked: false,
      data: { last_assistant_message: lastAssistantText, thinking: lastAssistantThinking ?? "", reason: "" },
      summary: null, keywords: [],
      _sourceLogEventId: primaryId,
      _extraSourceLogEventIds: extraIds.length > 0 ? extraIds : undefined,
    });
  }

  return result;
}

export function groupEvents(events: Event[]): DisplayItem[] {
  const postMap = new Map<string, Event>();
  for (const event of events) {
    if (event.event === "PostToolUse" || event.event === "PostToolUseFailure") {
      const d = event.data as Record<string, unknown>;
      const id = typeof d.tool_use_id === "string" ? d.tool_use_id : null;
      if (id) postMap.set(id, event);
    }
  }

  type RawItem =
    | { kind: "event"; event: Event }
    | { kind: "toolUse"; pre: Event; post?: Event; failed: boolean };

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

function SectionBlock({ title, color = "dimmed", children }: { title: string; color?: string; children: React.ReactNode }) {
  return (
    <Box style={{ borderLeft: "2px solid light-dark(var(--mantine-color-teal-3), var(--mantine-color-teal-8))", paddingLeft: 10 }}>
      <Text size="xs" fw={600} c={color} mb={5} tt="uppercase" style={{ letterSpacing: 0.4 }}>{title}</Text>
      {children}
    </Box>
  );
}

function BulletList({ items, color }: { items: string[]; color?: string }) {
  return (
    <Box style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {items.map((it, i) => (
        <Group key={i} gap={6} wrap="nowrap" align="flex-start">
          <Text size="xs" c={color ?? "teal"} style={{ flexShrink: 0, lineHeight: 1.6 }}>·</Text>
          <InlineMarkdown text={it} style={{ fontSize: 12, lineHeight: 1.6 }} />
        </Group>
      ))}
    </Box>
  );
}

export function CheckpointRow({ checkpoint, localPath, onPress }: { checkpoint: SessionCheckpoint; localPath: string | null; onPress: () => void }) {
  const [expanded, setExpanded] = useState(false);
  // null = not yet fetched, "" = fetched but empty / unavailable, string = raw unified diff
  const [diffPatch, setDiffPatch] = useState<string | null>(null);
  const outTokens = checkpoint.tokenUsage?.outputTokens ?? 0;
  const fileCount = checkpoint.filesTouched.length;
  const sum = checkpoint.summary;

  useEffect(() => {
    if (expanded && diffPatch === null) {
      fetchCheckpointDiff(checkpoint.checkpointId, localPath)
        .then((d) => setDiffPatch(d ?? ""))
        .catch(() => setDiffPatch(""));
    }
  }, [expanded, checkpoint.checkpointId, localPath, diffPatch]);

  return (
    <Box style={{ padding: "4px 20px 4px 58px" }}>
    <Box style={{ borderLeft: "4px solid var(--mantine-color-teal-6)", borderRadius: 8, overflow: "hidden" }}>
      <UnstyledButton
        onClick={() => setExpanded((v) => !v)}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", backgroundColor: "light-dark(var(--mantine-color-teal-0), var(--mantine-color-dark-6))" }}
      >
        <Box style={{ flex: 1 }}>
          <Group gap={8} mb={2}>
            <Text size="xs" fw={700} c="teal" tt="uppercase">Checkpoint</Text>
            <Text ff="monospace" size="xs" c="green" fw={600}>{checkpoint.checkpointId}</Text>
            {checkpoint.branch && <Badge variant="light" color="teal" size="xs">{checkpoint.branch}</Badge>}
          </Group>
          {sum?.intent && (
            <Text size="xs" c="dimmed" fs="italic" lineClamp={expanded ? undefined : 1}>{sum.intent}</Text>
          )}
        </Box>
        <Box style={{ textAlign: "right", flexShrink: 0 }}>
          {fileCount > 0 && <Text size="xs" c="dimmed" ff="monospace">{fileCount} file{fileCount !== 1 ? "s" : ""}</Text>}
          {outTokens > 0 && <Text size="xs" c="dimmed" ff="monospace">{outTokens.toLocaleString()} tok</Text>}
        </Box>
      </UnstyledButton>

      <Collapse in={expanded}>
        <Box style={{ backgroundColor: "light-dark(var(--mantine-color-teal-0), var(--mantine-color-dark-7))", borderTop: "1px solid var(--mantine-color-teal-2)", padding: "16px 16px", display: "flex", flexDirection: "column", gap: 14 }}>

          {sum?.outcome && (
            <SectionBlock title="Outcome">
              <InlineMarkdown text={sum.outcome} style={{ fontSize: 12, lineHeight: 1.6 }} />
            </SectionBlock>
          )}

          {sum?.repoLearnings?.length ? (
            <SectionBlock title="Repo learnings">
              <BulletList items={sum.repoLearnings} />
            </SectionBlock>
          ) : null}

          {sum?.codeLearnings?.length ? (
            <SectionBlock title="Code learnings">
              <Box style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {sum.codeLearnings.map((it, i) => (
                  <Box key={i}>
                    <Text size="xs" ff="monospace" c="violet" fw={600} mb={2}>{it.path}</Text>
                    <Box pl={8}><InlineMarkdown text={`→ ${it.finding}`} style={{ fontSize: 12, lineHeight: 1.6 }} /></Box>
                  </Box>
                ))}
              </Box>
            </SectionBlock>
          ) : null}

          {sum?.workflowLearnings?.length ? (
            <SectionBlock title="Workflow learnings">
              <BulletList items={sum.workflowLearnings} />
            </SectionBlock>
          ) : null}

          {sum?.friction?.length ? (
            <SectionBlock title="Friction" color="orange">
              <BulletList items={sum.friction} color="orange" />
            </SectionBlock>
          ) : null}

          {sum?.openItems?.length ? (
            <SectionBlock title="Open items">
              <Box style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {sum.openItems.map((it) => {
                  const statusColor = it.status === "complete" ? "teal" : it.status === "in_progress" ? "orange" : it.status === "na" ? "gray" : "blue";
                  const statusLabel = it.status === "in_progress" ? "in progress" : it.status === "na" ? "n/a" : it.status;
                  return (
                    <Group key={it.id} gap={8} wrap="nowrap" align="flex-start">
                      <Badge color={statusColor} size="xs" variant="light" style={{ flexShrink: 0, marginTop: 2, textTransform: "none" }}>{statusLabel}</Badge>
                      <InlineMarkdown text={it.text} style={{ fontSize: 12, lineHeight: 1.6 }} />
                    </Group>
                  );
                })}
              </Box>
            </SectionBlock>
          ) : null}

          <SectionBlock title="Files changed">
            {diffPatch === null ? (
              <Text size="xs" c="dimmed">Loading…</Text>
            ) : diffPatch === "" ? (
              fileCount > 0 ? (
                <Box style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {checkpoint.filesTouched.map((path) => (
                    <Text key={path} size="xs" ff="monospace" c="dimmed">{path}</Text>
                  ))}
                </Box>
              ) : (
                <Text size="xs" c="dimmed">No diff available</Text>
              )
            ) : (
              <Box
                className="d2h-wrapper"
                style={{ fontSize: 12, overflowX: "auto" }}
                dangerouslySetInnerHTML={{
                  __html: diff2htmlHtml(diffPatch, {
                    drawFileList: true,
                    matching: "lines",
                    outputFormat: "line-by-line",
                    colorScheme: "light",
                  }),
                }}
              />
            )}
          </SectionBlock>

          <UnstyledButton
            onClick={onPress}
            style={{ alignSelf: "flex-start", padding: "5px 10px", borderRadius: 4, border: "1px solid var(--mantine-color-teal-3)" }}
          >
            <Text size="xs" c="teal" ff="monospace">Open checkpoint →</Text>
          </UnstyledButton>
        </Box>
      </Collapse>
    </Box>
    </Box>
  );
}

// ── Search snippet helpers ─────────────────────────────────────────────────────

function extractMatchTerms(snippet: string): string[] {
  const terms: string[] = [];
  const re = /«([^»]+)»/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet)) !== null) terms.push(m[1]);
  return [...new Set(terms)];
}

// ── Source log event ID extractor ─────────────────────────────────────────────

function getItemSourceIds(item: RenderItem): number[] {
  if (item.kind === "event") {
    const ids = item.event._sourceLogEventId != null ? [item.event._sourceLogEventId] : [];
    if (item.event._extraSourceLogEventIds) ids.push(...item.event._extraSourceLogEventIds);
    return ids;
  }
  if (item.kind === "claudeTurn") {
    const ids: number[] = [];
    for (const group of item.toolGroups) {
      for (const tool of group) {
        if (tool.pre._sourceLogEventId != null) ids.push(tool.pre._sourceLogEventId);
        if (tool.pre._extraSourceLogEventIds) ids.push(...tool.pre._extraSourceLogEventIds);
        if (tool.post?._sourceLogEventId != null) ids.push(tool.post._sourceLogEventId);
        if (tool.post?._extraSourceLogEventIds) ids.push(...tool.post._extraSourceLogEventIds);
      }
    }
    if (item.stop?._sourceLogEventId != null) ids.push(item.stop._sourceLogEventId);
    if (item.stop?._extraSourceLogEventIds) ids.push(...item.stop._extraSourceLogEventIds);
    return ids;
  }
  return [];
}

export function SessionDetail() {
  const navigate = useNavigate();
  const { sessionId } = useParams<{ sessionId: string }>();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const targetLogEventId = searchParams.get("logEventId") ? parseInt(searchParams.get("logEventId")!) : null;
  const searchSnippet = (location.state as { snippet?: string; contentType?: string } | null)?.snippet ?? null;
  const searchContentType = (location.state as { snippet?: string; contentType?: string } | null)?.contentType ?? null;
  const [highlightActive, setHighlightActive] = useState(false);
  const scrolledRef = useRef(false);
  const viewportRef = useRef<HTMLDivElement>(null);
  const logEventsRef = useRef<LogEventItem[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [latestCheckpoint, setLatestCheckpoint] = useState<SessionCheckpoint | null>(null);
  const [items, setItems] = useState<RenderItem[]>([]);
  const [userInfo, setUserInfo] = useState<UserInfo | undefined>(undefined);
  const [openItems, setOpenItems] = useState<OpenItem[]>([]);
  const [selectedItems, setSelectedItems] = useState<Set<number>>(new Set());
  const [spawning, setSpawning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const id = sessionId!;
  const { setCrumbs } = useBreadcrumb();

  function applyCheckpoints(logEvs: LogEventItem[], checkpoints: SessionCheckpoint[]) {
    const grouped = groupEvents(logEventsToEvents(logEvs));
    const merged: DisplayItem[] = [];
    let cpIdx = 0;
    const sortedCps = [...checkpoints].sort((a, b) => (a.createdAt ?? "") < (b.createdAt ?? "") ? -1 : 1);
    const latest = sortedCps[sortedCps.length - 1] ?? null;
    setLatestCheckpoint(latest);
    setOpenItems(latest?.summary?.openItems ?? []);

    for (const item of grouped) {
      const itemTime = item.kind === "event" ? item.event.timestamp : item.kind === "toolGroup" ? item.tools[0]?.pre.timestamp ?? "" : "";
      while (cpIdx < sortedCps.length && (sortedCps[cpIdx].createdAt ?? "") <= itemTime) {
        merged.push({ kind: "checkpoint", checkpoint: sortedCps[cpIdx++] });
      }
      merged.push(item);
    }
    while (cpIdx < sortedCps.length) merged.push({ kind: "checkpoint", checkpoint: sortedCps[cpIdx++] });
    setItems(groupClaudeTurns(merged));
  }

  // Initial load
  useEffect(() => {
    Promise.all([fetchSession(id), fetchLogEvents(id), fetchSessionCheckpoints(id)])
      .then(([s, logEvs, checkpoints]) => {
        logEventsRef.current = logEvs;
        setSession(s);
        const user = s.gitUserName ?? s.gitUserEmail ?? null;
        const repo = s.repoName ?? null;
        const shortId = s.sessionId.slice(0, 8) + "…";
        if (user) {
          setUserInfo({
            name: s.gitUserName ?? user,
            avatarUrl: s.gitUserName ? `https://github.com/${s.gitUserName}.png?size=40` : undefined,
          });
        }
        setCrumbs([
          ...(user ? [{ label: user, path: "/" }] : []),
          ...(repo ? [{ label: repo, path: "/" }] : []),
          { label: shortId },
        ]);
        applyCheckpoints(logEvs, checkpoints);
        setError(null);
      })
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [id]);

  // Live updates: re-fetch checkpoints and log events when the server broadcasts a change
  useEffect(() => {
    return subscribeToUpdates(() => {
      Promise.all([fetchLogEvents(id), fetchSessionCheckpoints(id)])
        .then(([logEvs, checkpoints]) => applyCheckpoints(logEvs, checkpoints))
        .catch(() => undefined);
    });
  }, [id]);

  // Step 1: activate highlight once items are loaded (triggers Collapse expand + mark rendering)
  useEffect(() => {
    if (targetLogEventId === null || items.length === 0 || scrolledRef.current) return;
    const t = setTimeout(() => {
      setHighlightActive(true);
      scrolledRef.current = true;
      setTimeout(() => setHighlightActive(false), 10000);
    }, 150);
    return () => clearTimeout(t);
  }, [items, targetLogEventId]);

  // Step 2: once highlightActive is true (marks rendered, Collapses expanding), scroll to first <mark>
  useEffect(() => {
    if (!highlightActive || targetLogEventId === null) return;
    // Wait for Collapse animations (~200ms) to reach their final layout before measuring
    const t = setTimeout(() => {
      requestAnimationFrame(() => {
        // Resolve UUID for the target logEventId, then find the most precise element
        const uuid = logEventsRef.current.find((le) => le.id === targetLogEventId)?.uuid ?? null;
        const el = (
          (uuid ? document.getElementById(uuid) : null)
          ?? document.getElementById(`log-event-${targetLogEventId}`)
          ?? document.querySelector(`[data-log-event-id="${targetLogEventId}"]`)
        ) as HTMLElement | null;
        const viewport = viewportRef.current;
        if (!el || !viewport) return;
        const targetRect = el.getBoundingClientRect();
        const vpRect = viewport.getBoundingClientRect();
        const scrollTop = viewport.scrollTop + targetRect.top - vpRect.top - viewport.clientHeight / 2 + targetRect.height / 2 + 16;
        viewport.scrollTo({ top: Math.max(0, scrollTop), behavior: "smooth" });
      });
    }, 250);
    return () => clearTimeout(t);
  }, [highlightActive, targetLogEventId]);

  if (loading) return <Center style={{ flex: 1 }}><Loader size="md" color="indigo" /></Center>;
  if (error) return <Center style={{ flex: 1 }}><Text c="red">{error}</Text></Center>;

  return (
    <ScrollArea style={{ flex: 1 }} viewportRef={viewportRef}>
      <Box style={{ maxWidth: 860, margin: "0 auto", paddingBottom: 40 }}>
      {session?.parentSessionId && (
        <UnstyledButton
          onClick={() => navigate(`/sessions/${session.parentSessionId}`, { state: { title: session.parentSessionId!.slice(0, 8) + "…" } })}
          style={{ width: "100%", display: "flex", alignItems: "center", gap: 6, backgroundColor: "light-dark(var(--mantine-color-blue-0), var(--mantine-color-dark-6))", borderBottom: "1px solid var(--mantine-color-blue-2)", padding: "8px 14px" }}
        >
          <Text size="xs" c="blue">↑ Continuation of</Text>
          <Text size="xs" c="blue" ff="monospace" fw={600} td="underline">{session.parentSessionId.slice(0, 8)}…</Text>
        </UnstyledButton>
      )}
      {session?.childSessionIds?.map((childId) => (
        <UnstyledButton
          key={childId}
          onClick={() => navigate(`/sessions/${childId}`, { state: { title: childId.slice(0, 8) + "…" } })}
          style={{ width: "100%", display: "flex", alignItems: "center", gap: 6, backgroundColor: "light-dark(var(--mantine-color-green-0), var(--mantine-color-dark-6))", borderBottom: "1px solid var(--mantine-color-green-2)", padding: "8px 14px" }}
        >
          <Text size="xs" c="green">↓ Continued as</Text>
          <Text size="xs" c="green" ff="monospace" fw={600} td="underline">{childId.slice(0, 8)}…</Text>
        </UnstyledButton>
      ))}

      {latestCheckpoint?.summary && (
        <Box style={{
          borderBottom: "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
          padding: "16px 20px",
          backgroundColor: "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-7))",
        }}>
          <Text size="sm" fw={600} lh={1.5} mb={latestCheckpoint.summary.openItems?.length ? 12 : 0}>
            {latestCheckpoint.summary.intent}
          </Text>
          {openItems.length > 0 && (
            <Box>
              <Text size="xs" fw={700} c="dimmed" tt="uppercase" mb={8} style={{ letterSpacing: 0.5 }}>
                Open items
              </Text>
              {openItems.map((item, i) => {
                const selectable = item.status === "open";
                const statusColor = item.status === "complete" ? "teal" : item.status === "in_progress" ? "orange" : item.status === "na" ? "gray" : "blue";
                const statusLabel = item.status === "in_progress" ? "in progress" : item.status === "na" ? "n/a" : item.status;
                return (
                  <Group key={item.id} gap={10} align="flex-start" mb={6} wrap="nowrap">
                    {selectable ? (
                      <Checkbox
                        size="xs"
                        radius="xl"
                        checked={selectedItems.has(i)}
                        onChange={(e) => {
                          setSelectedItems((prev) => {
                            const next = new Set(prev);
                            e.currentTarget.checked ? next.add(i) : next.delete(i);
                            return next;
                          });
                        }}
                        onClick={(e) => e.stopPropagation()}
                        style={{ marginTop: 2, flexShrink: 0 }}
                      />
                    ) : (
                      <Box style={{ width: 16, flexShrink: 0 }} />
                    )}
                    <Menu withinPortal position="bottom-start" shadow="sm">
                      <Menu.Target>
                        <Badge
                          color={statusColor}
                          size="xs"
                          variant="light"
                          style={{ cursor: "pointer", flexShrink: 0, marginTop: 2, textTransform: "none" }}
                        >
                          {statusLabel}
                        </Badge>
                      </Menu.Target>
                      <Menu.Dropdown>
                        {(["open", "in_progress", "complete", "na"] as const).map((s) => (
                          <Menu.Item
                            key={s}
                            fw={item.status === s ? 700 : undefined}
                            onClick={async () => {
                              await updateOpenItemStatus(item.id, s).catch(() => undefined);
                              setOpenItems((prev) => prev.map((it) => it.id === item.id ? { ...it, status: s } : it));
                              if (s !== "open") setSelectedItems((prev) => { const n = new Set(prev); n.delete(i); return n; });
                            }}
                          >
                            {s === "in_progress" ? "in progress" : s === "na" ? "n/a" : s}
                          </Menu.Item>
                        ))}
                      </Menu.Dropdown>
                    </Menu>
                    <Text size="xs" lh={1.5} c={selectable ? undefined : "dimmed"} style={{ cursor: "default" }}>{item.text}</Text>
                  </Group>
                );
              })}
              {selectedItems.size > 0 && (
                <Group gap={8} mt={10}>
                  <Text size="xs" c="dimmed">Work on selection in new session?</Text>
                  <Tooltip label={spawning ? "Starting…" : "Start new Claude session"} withArrow>
                    <ActionIcon
                      size="sm"
                      variant="light"
                      color="indigo"
                      loading={spawning}
                      onClick={async () => {
                        if (!session?.cwd) return;
                        const selected = openItems.filter((_, i) => selectedItems.has(i));
                        const lines = selected.map((item) => `- ${item.text}`).join("\n");
                        const prompt = `Please work on the following open items:\n${lines}`;
                        setSpawning(true);
                        try {
                          await spawnSession(prompt, session.cwd, selected.map((it) => it.id), session.sessionId);
                          const selectedIds = new Set(selected.map((it) => it.id));
                          setOpenItems((prev) => prev.map((it) => selectedIds.has(it.id) ? { ...it, status: "in_progress" as const } : it));
                          setSelectedItems(new Set());
                        } finally {
                          setSpawning(false);
                        }
                      }}
                    >
                      →
                    </ActionIcon>
                  </Tooltip>
                </Group>
              )}
            </Box>
          )}
        </Box>
      )}

      {items.length === 0 ? (
        <Center p="xl"><Text c="dimmed" size="sm">No events for this session.</Text></Center>
      ) : (<>
        <style>{`
          @keyframes search-highlight-fade {
            0%   { background-color: rgba(255, 210, 0, 0.25); box-shadow: 0 0 0 2px rgba(255, 210, 0, 0.6); border-radius: 8px; }
            100% { background-color: rgba(255, 210, 0, 0);    box-shadow: 0 0 0 2px rgba(255, 210, 0, 0);   border-radius: 8px; }
          }
          .search-target-highlight { animation: search-highlight-fade 10s ease-out forwards; border-radius: 8px; }
        `}</style>
        {items.map((item, idx) => {
          const sourceIds = getItemSourceIds(item);
          const isTarget = targetLogEventId !== null && sourceIds.includes(targetLogEventId);
          const matchTerms = isTarget && highlightActive && searchSnippet ? extractMatchTerms(searchSnippet) : undefined;
          const key = item.kind === "claudeTurn" ? `turn-${idx}`
            : item.kind === "checkpoint" ? `cp-${item.checkpoint.checkpointId}`
            : `evt-${item.event.id}`;
          return (
            <div
              key={key}
              data-log-event-id={isTarget ? targetLogEventId! : (sourceIds[0] ?? undefined)}
              className={isTarget && highlightActive ? "search-target-highlight" : undefined}
            >
              {item.kind === "claudeTurn" ? (
                <ClaudeTurnCard
                  toolGroups={item.toolGroups}
                  stop={item.stop}
                  isTarget={isTarget}
                  matchTerms={matchTerms}
                  expandTools={isTarget && (searchContentType === "tool_use" || searchContentType === "tool_result")}
                  expandThinking={isTarget && searchContentType === "thinking"}
                  targetLogEventId={targetLogEventId}
                />
              ) : item.kind === "checkpoint" ? (
                <CheckpointRow
                  checkpoint={item.checkpoint}
                  localPath={session?.repoRoot ?? null}
                  onPress={() => navigate(`/checkpoints/${item.checkpoint.checkpointId}`, {
                    state: { title: item.checkpoint.branch ? `${item.checkpoint.branch} · ${item.checkpoint.checkpointId}` : item.checkpoint.checkpointId, localPath: session?.repoRoot ?? null },
                  })}
                />
              ) : (
                <EventItem event={item.event} user={userInfo} matchTerms={matchTerms} />
              )}
            </div>
          );
        })}
      </>)}
      </Box>
    </ScrollArea>
  );
}
