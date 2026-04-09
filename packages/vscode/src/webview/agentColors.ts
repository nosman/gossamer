// Maps an agent name (as stored on CheckpointSessionMetadata.agent) to its
// brand color. Used for the turn card border, agent label text, and badges so
// each agent is visually distinct.

/** Short Mantine color name (e.g. "orange") — use with Badge, ActionIcon etc. */
const AGENT_MANTINE_COLOR: Record<string, string> = {
  "Claude Code": "orange",
  "Gemini CLI":  "blue",
  "Codex":       "teal",
};

const DEFAULT_AGENT_MANTINE_COLOR = "gray";

export function agentMantineColor(agent: string | null | undefined): string {
  if (!agent) return AGENT_MANTINE_COLOR["Claude Code"];
  return AGENT_MANTINE_COLOR[agent] ?? DEFAULT_AGENT_MANTINE_COLOR;
}

/** CSS variable form (e.g. "var(--mantine-color-orange-5)") — use for inline styles. */
export function agentColor(agent: string | null | undefined): string {
  return `var(--mantine-color-${agentMantineColor(agent)}-5)`;
}
