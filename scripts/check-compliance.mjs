#!/usr/bin/env node
/**
 * Fails if the repo references capabilities that would turn this passive screen reader
 * into a bannable third-party client. See CLAUDE.md -> "Non-negotiable compliance rules".
 *
 * This is a coarse text scan, not a proof. It exists to make crossing the line loud.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import process from "node:process";

const ROOT = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

const SKIP_DIRS = new Set([
  "node_modules",
  "target",
  "dist",
  "build",
  ".git",
  "gen",
  "icons",
]);

const SCAN_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|rs|toml|json)$/;

/** @type {{ id: string; why: string; pattern: RegExp }[]} */
const RULES = [
  {
    id: "synthetic-input",
    why: "synthesises keyboard/mouse input — the user's hands must be the only input source",
    pattern:
      /\b(SendInput|keybd_event|mouse_event|SetCursorPos|SendMessageW?|PostMessageW?)\b/,
  },
  {
    id: "input-library",
    why: "input-synthesis library",
    pattern:
      /["'`\s=]((enigo|rdev|inputbot|autopilot|winput)|(robotjs|@nut-tree\/nut-js|nut-js|node-key-sender))["'`\s=@]/,
  },
  {
    id: "process-memory",
    why: "reads or writes another process's memory",
    pattern:
      /\b(ReadProcessMemory|WriteProcessMemory|VirtualAllocEx|VirtualProtectEx|CreateRemoteThread|OpenProcess)\b/,
  },
  {
    id: "injection-hooking",
    why: "DLL injection or API hooking",
    pattern: /\b(SetWindowsHookEx[AW]?|LoadLibraryEx?[AW]?\s*\(|detour|minhook)\b/i,
  },
  {
    id: "packet-interception",
    why: "intercepts game network traffic",
    pattern: /\b(pcap|winpcap|npcap|WinDivert|raw_socket|SOCK_RAW)\b/i,
  },
];

/** Lines carrying this marker are the rules themselves or docs about them. */
const EXEMPT_LINE = /compliance-exempt/;

const EXEMPT_FILES = new Set([
  join("scripts", "check-compliance.mjs"),
  "CLAUDE.md",
  "README.md",
]);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(join(dir, entry.name));
    } else if (SCAN_EXT.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

const violations = [];
let scanned = 0;

for await (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (EXEMPT_FILES.has(rel) || EXEMPT_FILES.has(rel.split(sep).join("/"))) continue;
  scanned += 1;

  const lines = (await readFile(file, "utf8")).split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (EXEMPT_LINE.test(line)) continue;
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        violations.push({ rel, line: index + 1, rule, text: line.trim().slice(0, 120) });
      }
    }
  }
}

if (violations.length === 0) {
  console.log(`compliance: ok (${scanned} files scanned)`);
  process.exit(0);
}

console.error(`compliance: ${violations.length} violation(s) in ${scanned} files scanned\n`);
for (const v of violations) {
  console.error(`  ${v.rel}:${v.line}  [${v.rule.id}] ${v.rule.why}`);
  console.error(`    ${v.text}\n`);
}
console.error("See CLAUDE.md. This is a design boundary, not a lint nit.");
process.exit(1);
