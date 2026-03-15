import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Center, Loader, Text, ScrollArea, Box, Badge, Group, UnstyledButton } from "@mantine/core";
import { fetchCheckpoint, fetchCheckpointDiff, type Checkpoint, type CheckpointSummary, type OpenItem } from "../api";
import { html as diff2htmlHtml } from "diff2html";
import "diff2html/bundles/css/diff2html.min.css";
import "../diff2html-theme.css";
import { InlineMarkdown } from "../components/MarkdownView";

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

function SummaryDetail({ summary, diff, fileCount }: { summary: CheckpointSummary | null; diff: string | null; fileCount: number }) {
  return (
    <Box style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 20px" }}>
      {summary?.intent && (
        <Text size="sm" fs="italic" c="dimmed">{summary.intent}</Text>
      )}

      {summary?.outcome && (
        <SectionBlock title="Outcome">
          <InlineMarkdown text={summary.outcome} style={{ fontSize: 12, lineHeight: 1.6 }} />
        </SectionBlock>
      )}

      {(summary?.repoLearnings?.length ?? 0) > 0 && (
        <SectionBlock title="Repo learnings">
          <BulletList items={summary!.repoLearnings} />
        </SectionBlock>
      )}

      {(summary?.codeLearnings?.length ?? 0) > 0 && (
        <SectionBlock title="Code learnings">
          <Box style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {summary!.codeLearnings.map((it, i) => (
              <Box key={i}>
                <Text size="xs" ff="monospace" c="violet" fw={600} mb={2}>{it.path}</Text>
                <Box pl={8}><InlineMarkdown text={`→ ${it.finding}`} style={{ fontSize: 12, lineHeight: 1.6 }} /></Box>
              </Box>
            ))}
          </Box>
        </SectionBlock>
      )}

      {(summary?.workflowLearnings?.length ?? 0) > 0 && (
        <SectionBlock title="Workflow learnings">
          <BulletList items={summary!.workflowLearnings} />
        </SectionBlock>
      )}

      {(summary?.friction?.length ?? 0) > 0 && (
        <SectionBlock title="Friction" color="orange">
          <BulletList items={summary!.friction} color="orange" />
        </SectionBlock>
      )}

      {(summary?.openItems?.length ?? 0) > 0 && (
        <SectionBlock title="Open items">
          <Box style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {summary!.openItems.map((it: OpenItem) => {
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
      )}

      <SectionBlock title="Files changed">
        {diff === null ? (
          <Text size="xs" c="dimmed">Loading…</Text>
        ) : diff === "" ? (
          fileCount > 0 ? (
            <Text size="xs" c="dimmed">{fileCount} file{fileCount !== 1 ? "s" : ""} changed (diff not available)</Text>
          ) : (
            <Text size="xs" c="dimmed">No changes</Text>
          )
        ) : (
          <Box
            className="d2h-wrapper"
            style={{ fontSize: 12, overflowX: "auto" }}
            dangerouslySetInnerHTML={{
              __html: diff2htmlHtml(diff, {
                drawFileList: true,
                matching: "lines",
                outputFormat: "line-by-line",
                colorScheme: "light",
              }),
            }}
          />
        )}
      </SectionBlock>
    </Box>
  );
}

export function CheckpointDetail() {
  const navigate = useNavigate();
  const { checkpointId } = useParams<{ checkpointId: string }>();
  const [checkpoint, setCheckpoint] = useState<Checkpoint | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const id = checkpointId!;

  useEffect(() => {
    fetchCheckpoint(id)
      .then((cp) => {
        setCheckpoint(cp);
        setError(null);
        return fetchCheckpointDiff(id);
      })
      .then((d) => setDiff(d ?? ""))
      .catch((err: unknown) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <Center style={{ flex: 1 }}><Loader size="md" color="teal" /></Center>;
  if (error)   return <Center style={{ flex: 1 }}><Text c="red">{error}</Text></Center>;
  if (!checkpoint) return null;

  const outTokens = checkpoint.tokenUsage?.outputTokens ?? 0;
  const fileCount = checkpoint.filesTouched.length;

  return (
    <ScrollArea style={{ flex: 1 }}>
      <Box style={{ maxWidth: 860, margin: "0 auto", paddingBottom: 40 }}>

        {/* Header */}
        <Box
          style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "8px 20px",
            backgroundColor: "light-dark(var(--mantine-color-teal-0), var(--mantine-color-dark-6))",
            borderBottom: "1px solid light-dark(var(--mantine-color-teal-2), var(--mantine-color-dark-4))",
          }}
        >
          <Box style={{ flex: 1 }}>
            <Group gap={8} mb={2}>
              <Text size="xs" fw={700} c="teal" tt="uppercase">Checkpoint</Text>
              <Text ff="monospace" size="xs" c="green" fw={600}>{checkpoint.checkpointId}</Text>
              {checkpoint.branch && (
                <UnstyledButton onClick={() => navigate("/checkpoints/timeline")}>
                  <Badge variant="light" color="teal" size="xs" style={{ cursor: "pointer" }}>{checkpoint.branch}</Badge>
                </UnstyledButton>
              )}
            </Group>
            {checkpoint.summary?.intent && (
              <Text size="xs" c="dimmed" fs="italic">{checkpoint.summary.intent}</Text>
            )}
          </Box>
          <Box style={{ textAlign: "right", flexShrink: 0 }}>
            {fileCount > 0 && <Text size="xs" c="dimmed" ff="monospace">{fileCount} file{fileCount !== 1 ? "s" : ""}</Text>}
            {outTokens > 0 && <Text size="xs" c="dimmed" ff="monospace">{outTokens.toLocaleString()} tok</Text>}
          </Box>
        </Box>

        <SummaryDetail summary={checkpoint.summary} diff={diff} fileCount={fileCount} />

      </Box>
    </ScrollArea>
  );
}
