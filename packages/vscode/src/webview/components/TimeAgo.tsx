import React, { useState } from "react";
import { Tooltip, Text } from "@mantine/core";

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

export function absoluteTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

interface Props {
  iso: string;
  size?: string;
}

export function TimeAgo({ iso, size = "xs" }: Props) {
  const [copied, setCopied] = useState(false);
  const abs = absoluteTime(iso);

  function copy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(abs).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Tooltip label={copied ? "Copied!" : abs} withArrow openDelay={200}>
      <Text
        component="span"
        size={size as never}
        c="dimmed"
        style={{ cursor: "pointer" }}
        onClick={copy}
      >
        {relativeTime(iso)}
      </Text>
    </Tooltip>
  );
}
