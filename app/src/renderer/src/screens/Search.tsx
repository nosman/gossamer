import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ScrollArea, Box, Text, Group, Badge, Center, Loader, UnstyledButton, Avatar, Chip } from "@mantine/core";
import { fetchSearch, type SearchResult } from "../api";
import { TimeAgo } from "../components/TimeAgo";
import { MarkdownView } from "../components/MarkdownView";
import claudeLogo from "../assets/claude-logo.png";

// ── Snippet renderer ──────────────────────────────────────────────────────────

function Snippet({ raw }: { raw: string }) {
  const terms: string[] = [];
  const re = /«([^»]+)»/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) terms.push(m[1]);
  const clean = raw.replace(/«([^»]*)»/g, "$1");
  return <MarkdownView text={clean} highlightTerms={[...new Set(terms)]} />;
}

// ── Content-type label ────────────────────────────────────────────────────────

const CONTENT_LABEL: Record<string, string> = {
  text:            "message",
  thinking:        "thinking",
  tool_use:        "tool call",
  tool_result:     "tool result",
};

// ── Per-result card ───────────────────────────────────────────────────────────

function ResultCard({ r, onClick }: { r: SearchResult; onClick: () => void }) {
  const isHuman = r.logEventType === "user" && r.contentType !== "tool_result";
  const isClaude = r.logEventType === "assistant" || r.contentType === "thinking" || r.contentType === "tool_result";

  const displayName = r.gitUserName ?? r.gitUserEmail ?? "You";
  const initials = displayName.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase();
  const avatarUrl = r.gitUserName ? `https://github.com/${r.gitUserName}.png?size=40` : undefined;

  return (
    <UnstyledButton
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        border: "1px solid light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-4))",
        borderRadius: 10,
        overflow: "hidden",
        backgroundColor: "light-dark(var(--mantine-color-white), var(--mantine-color-dark-7))",
      }}
    >
      {/* Row header */}
      <Group
        gap={8}
        px={12}
        py={7}
        style={{ borderBottom: "1px solid light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-6))" }}
      >
        {isClaude ? (
          <img src={claudeLogo} alt="Claude" style={{ width: 18, height: 18, borderRadius: "50%", flexShrink: 0 }} />
        ) : (
          <Avatar src={avatarUrl} size={18} radius="xl" color="indigo" style={{ flexShrink: 0 }}>
            <Text size="xs" fw={700} style={{ fontSize: 9 }}>{initials}</Text>
          </Avatar>
        )}

        <Text size="xs" fw={600} c={isClaude ? "orange" : "indigo"}>
          {isClaude ? "Claude" : displayName}
        </Text>

        <Badge size="xs" variant="light" color={isClaude ? "orange" : "indigo"}>
          {CONTENT_LABEL[r.contentType] ?? r.contentType}
        </Badge>

        {r.toolName && (
          <Badge size="xs" color="teal" variant="dot">
            {r.toolName}
          </Badge>
        )}

        <Box style={{ flex: 1 }} />

        <Text size="xs" ff="monospace" c="dimmed">{r.sessionId.slice(0, 8)}…</Text>
        {r.timestamp && <TimeAgo iso={r.timestamp} />}
      </Group>

      {/* Snippet body */}
      <Box
        px={12}
        py={8}
        style={{
          backgroundColor: isClaude
            ? "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-8))"
            : "light-dark(var(--mantine-color-indigo-0), var(--mantine-color-dark-8))",
        }}
      >
        <Snippet raw={r.snippet} />
      </Box>
    </UnstyledButton>
  );
}

// ── Screen ────────────────────────────────────────────────────────────────────

const TYPE_FILTERS: { value: string; label: string; contentType: string | null }[] = [
  { value: "all",         label: "All",         contentType: null          },
  { value: "message",     label: "Message",     contentType: "text"        },
  { value: "tool_call",   label: "Tool call",   contentType: "tool_use"    },
  { value: "tool_result", label: "Tool result", contentType: "tool_result" },
  { value: "thinking",    label: "Thinking",    contentType: "thinking"    },
];

export function Search() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const query = params.get("q") ?? "";

  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState("all");

  useEffect(() => {
    if (!query) { setResults([]); return; }
    setLoading(true);
    setError(null);
    fetchSearch(query, 100)
      .then(setResults)
      .catch((e: unknown) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [query]);

  if (!query) {
    return <Center style={{ flex: 1 }}><Text c="dimmed">Enter a search term above.</Text></Center>;
  }
  if (loading) return <Center style={{ flex: 1 }}><Loader size="md" color="indigo" /></Center>;
  if (error)   return <Center style={{ flex: 1 }}><Text c="red">{error}</Text></Center>;

  const activeFilter = TYPE_FILTERS.find((f) => f.value === typeFilter)!;
  const filtered = activeFilter.contentType
    ? results.filter((r) => r.contentType === activeFilter.contentType)
    : results;

  return (
    <ScrollArea style={{ flex: 1 }}>
      <Box style={{ maxWidth: 860, margin: "0 auto", padding: "16px 20px 40px" }}>
        <Group mb={12} gap={8} align="center">
          <Text size="sm" fw={600}>Results for</Text>
          <Text size="sm" fw={700} c="indigo" ff="monospace">"{query}"</Text>
          <Text size="sm" c="dimmed">— {filtered.length} match{filtered.length !== 1 ? "es" : ""}</Text>
        </Group>

        <Chip.Group value={typeFilter} onChange={(v) => setTypeFilter(v as string)}>
          <Group gap={6} mb={16}>
            {TYPE_FILTERS.map((f) => (
              <Chip key={f.value} value={f.value} size="xs" variant="light" color="indigo">
                {f.label}
              </Chip>
            ))}
          </Group>
        </Chip.Group>

        {filtered.length === 0 ? (
          <Center p="xl"><Text c="dimmed" size="sm">No results found.</Text></Center>
        ) : (
          <Box style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {filtered.map((r) => (
              <ResultCard
                key={r.logContentId}
                r={r}
                onClick={() => {
                  console.log("[search] clicking result — sessionId:", r.sessionId, "logEventId:", r.logEventId, "logContentId:", r.logContentId, "snippet:", r.snippet);
                  navigate(`/sessions/${r.sessionId}?logEventId=${r.logEventId}`, { state: { snippet: r.snippet, contentType: r.contentType } });
                }}
              />
            ))}
          </Box>
        )}
      </Box>
    </ScrollArea>
  );
}
