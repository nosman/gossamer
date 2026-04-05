#!/usr/bin/env node
/**
 * Gossamer MCP installer
 *
 * Reads the port from ~/.gossamer/config.json and writes the Gossamer MCP
 * server entry into the config files of supported AI tools.
 *
 * Usage: node scripts/install-mcp.mjs [--port <n>] [--dry-run]
 *
 * Supported tools:
 *   Claude Code  →  ~/.claude.json
 *   Codex CLI    →  ~/.codex/config.yaml
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── CLI flags ─────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const dryRun  = args.includes("--dry-run");
const flagIdx = args.indexOf("--port");
const flagPort = flagIdx !== -1 && args[flagIdx + 1] ? parseInt(args[flagIdx + 1], 10) : null;

// ── Port resolution ───────────────────────────────────────────────────────────

const DEFAULT_PORT = 3456;
const gossamerConfig = join(homedir(), ".gossamer", "config.json");

function resolvePort() {
  if (flagPort) return flagPort;
  try {
    const cfg = JSON.parse(readFileSync(gossamerConfig, "utf8"));
    return typeof cfg.port === "number" ? cfg.port : DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

const port   = resolvePort();
const mcpUrl = `http://localhost:${port}/mcp`;

console.log(`\nGossamer MCP installer`);
console.log(`  port: ${port}  (${mcpUrl})`);
if (dryRun) console.log(`  --dry-run: no files will be written\n`);
else console.log("");

// ── Helpers ───────────────────────────────────────────────────────────────────

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return null; }
}

function writeJson(path, obj) {
  if (dryRun) return;
  const dir = path.slice(0, path.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

// ── Claude Code: ~/.claude.json ───────────────────────────────────────────────

function installClaude() {
  const configPath = join(homedir(), ".claude.json");
  const existing   = readJson(configPath) ?? {};
  const prev       = existing?.mcpServers?.gossamer;

  existing.mcpServers ??= {};
  existing.mcpServers.gossamer = { type: "http", url: mcpUrl };

  if (prev?.url === mcpUrl) {
    console.log(`  Claude Code  already up to date (${configPath})`);
    return;
  }

  writeJson(configPath, existing);
  const action = prev ? `updated (was ${prev.url})` : "added";
  console.log(`✓ Claude Code  ${action}`);
  console.log(`               ${configPath}`);
}

// ── Codex CLI: ~/.codex/config.yaml ──────────────────────────────────────────
// Codex uses YAML. We do a targeted find-and-replace so we don't need a YAML dep.
// If no mcpServers block exists we append one; if a gossamer entry exists we patch it.

function installCodex() {
  const configPath = join(homedir(), ".codex", "config.yaml");
  if (!existsSync(configPath)) {
    console.log(`  Codex CLI    not found (${configPath} missing) — skipping`);
    return;
  }

  let yaml = readFileSync(configPath, "utf8");

  // If there's already a gossamer url line, replace it
  const gossamerUrlRe = /^(\s+url:\s*http:\/\/localhost:)\d+(\/mcp\s*)$/m;
  if (gossamerUrlRe.test(yaml)) {
    const updated = yaml.replace(gossamerUrlRe, `$1${port}$2`);
    if (updated === yaml) {
      console.log(`  Codex CLI    already up to date (${configPath})`);
      return;
    }
    if (!dryRun) writeFileSync(configPath, updated, "utf8");
    console.log(`✓ Codex CLI    updated port → ${port}`);
    console.log(`               ${configPath}`);
    return;
  }

  // No existing gossamer entry — look for mcpServers block and append, or add block
  const mcpEntry = [
    `  gossamer:`,
    `    type: http`,
    `    url: "${mcpUrl}"`,
  ].join("\n");

  if (/^mcpServers:/m.test(yaml)) {
    // Append under existing mcpServers block (before next top-level key or EOF)
    yaml = yaml.replace(/^(mcpServers:.*?)(\n(?=[^\s]|\s*$))/ms, `$1\n${mcpEntry}$2`);
  } else {
    yaml = yaml.trimEnd() + `\n\nmcpServers:\n${mcpEntry}\n`;
  }

  if (!dryRun) writeFileSync(configPath, yaml, "utf8");
  console.log(`✓ Codex CLI    added`);
  console.log(`               ${configPath}`);
}

// ── Run ───────────────────────────────────────────────────────────────────────

installClaude();
installCodex();

console.log(`
To change the port later, edit ~/.gossamer/config.json and re-run this script.`);
