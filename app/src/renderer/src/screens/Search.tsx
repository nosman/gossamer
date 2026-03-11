import React, { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ScrollArea, Box, Text, Group, Badge, Center, Loader, UnstyledButton } from "@mantine/core";
import { fetchSearch, type SearchResult } from "../api";
import { TimeAgo } from "../components/TimeAgo";

const CONTENT_TYPE_COLOR: Record<string, string> = {
  text:              "indigo",
  thinking:          "violet",
  tool_use:          "teal",
  tool_result:       "cyan",
};

/** Replace «…» markers with bold spans for display. */
function Snippet({ raw }: { raw: string }) {
  const parts = raw.split(/(«[^»]*»)/g);
  return (
    <Text size="xs" c="dimmed" ff="monospace" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
      {parts.map((part, i) =>
        part.startsWith("«") && part.endsWith("»") ? (
          <Text key={i} component="span" size="xs" fw={700} c="yellow.6" ff="monospace">
            {part.slice(1, -1)}
          </Text>
        ) : (
          part
        )
      )}
    </Text>
  );
}

export function Search() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const query = params.get("q") ?? "";

  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <ScrollArea style={{ flex: 1 }}>
      <Box style={{ maxWidth: 860, margin: "0 auto", padding: "16px 20px 40px" }}>
        <Group mb={16} gap={8} align="center">
          <Text size="sm" fw={600}>Results for</Text>
          <Text size="sm" fw={700} c="indigo" ff="monospace">"{query}"</Text>
          <Text size="sm" c="dimmed">— {results.length} match{results.length !== 1 ? "es" : ""}</Text>
        </Group>

        {results.length === 0 ? (
          <Center p="xl"><Text c="dimmed" size="sm">No results found.</Text></Center>
        ) : (
          <Box style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {results.map((r) => (
              <UnstyledButton
                key={r.logContentId}
                onClick={() => navigate(`/sessions/${r.sessionId}`)}
                style={{
                  display: "block",
                  border: "1px solid light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-4))",
                  borderRadius: 8,
                  padding: "10px 14px",
                  backgroundColor: "light-dark(var(--mantine-color-white), var(--mantine-color-dark-7))",
                }}
              >
                <Group gap={8} mb={6} wrap="nowrap">
                  <Badge
                    size="xs"
                    color={CONTENT_TYPE_COLOR[r.contentType] ?? "gray"}
                    variant="light"
                    style={{ flexShrink: 0 }}
                  >
                    {r.contentType}
                  </Badge>
                  {r.toolName && (
                    <Badge size="xs" color="gray" variant="outline" style={{ flexShrink: 0 }}>
                      {r.toolName}
                    </Badge>
                  )}
                  <Text size="xs" ff="monospace" c="dimmed" style={{ flexShrink: 0 }}>
                    {r.sessionId.slice(0, 8)}…
                  </Text>
                  {r.timestamp && <TimeAgo iso={r.timestamp} />}
                </Group>
                <Snippet raw={r.snippet} />
              </UnstyledButton>
            ))}
          </Box>
        )}
      </Box>
    </ScrollArea>
  );
}
