// src/guard.ts

export interface GuardResult {
  safe: boolean;
  reason?: string;
}

// ─── Shell Tokenizer ─────────────────────────────────────────────────────────
// Walks the input character-by-character tracking quote state.
// Blocks shell metacharacters found outside quoted strings.

export function validateArgs(input: string): GuardResult {
  type State = "normal" | "single_quote" | "double_quote";
  let state: State = "normal";
  let i = 0;

  while (i < input.length) {
    const ch = input[i];
    const next = input[i + 1] ?? "";

    if (state === "single_quote") {
      if (ch === "'") state = "normal";
      i++;
      continue;
    }

    if (state === "double_quote") {
      if (ch === "\\") { i += 2; continue; }  // skip escaped char
      if (ch === '"') state = "normal";
      i++;
      continue;
    }

    // state === "normal"
    if (ch === "'") { state = "single_quote"; i++; continue; }
    if (ch === '"') { state = "double_quote"; i++; continue; }

    // Blocked patterns outside quotes
    if (ch === ";") return { safe: false, reason: "semicolon outside quotes — use separate tool calls instead of chaining commands" };
    if (ch === "&" && next === "&") return { safe: false, reason: "'&&' outside quotes — use separate tool calls instead of chaining commands" };
    if (ch === "&" && next !== "&") return { safe: false, reason: "'&' outside quotes — cmd.exe command separator, use separate tool calls instead" };
    if (ch === "|" && next === "|") return { safe: false, reason: "'||' outside quotes — use separate tool calls instead of chaining commands" };
    if (ch === "|") return { safe: false, reason: "pipe operator outside quotes — use rtk_run with a single command, not a pipeline" };
    if (ch === "<" && next === "(") return { safe: false, reason: "process substitution '<(' not permitted in tool arguments" };
    if (ch === ">" && next === "(") return { safe: false, reason: "process substitution '>(' not permitted in tool arguments" };
    if (ch === ">" || ch === "<") return { safe: false, reason: "redirect operator outside quotes — rtk tools return output to Claude, not to files" };
    if (ch === "`") return { safe: false, reason: "backtick substitution not permitted in tool arguments" };
    if (ch === "$" && next === "(") return { safe: false, reason: "command substitution '$(' not permitted in tool arguments" };

    i++;
  }

  return { safe: true };
}

// ─── Shell Literal Sanitizer ─────────────────────────────────────────────────
// Escapes double-quote characters in values that are interpolated into
// pre-quoted shell strings like `rg "${pattern}"`. A bare " would break out
// of the surrounding quotes and allow command injection.
// Uses "" (cmd.exe escape) which rg/grep also accept as a literal ".

export function sanitizeShellLiteral(s: string): string {
  return s.replace(/"/g, '""');
}

// ─── rtk_run Allowlist ───────────────────────────────────────────────────────

const ALLOWED_PREFIXES = new Set([
  // Version control
  "git",
  // Node / JS
  "npm", "npx", "node", "pnpm", "yarn",
  // TypeScript / linting
  "tsc", "eslint", "biome", "prettier",
  // Rust
  "cargo", "rustc",
  // Go
  "go", "golangci-lint",
  // Python
  "pytest", "python", "python3", "pip", "pip3", "ruff",
  // Testing
  "vitest", "jest", "mocha",
  // E2E
  "playwright",
  // Containers / cloud
  "docker", "docker-compose", "kubectl", "helm",
  // GitHub CLI
  "gh",
  // Network
  "curl", "wget",
  // Android
  "gradle", "gradlew", "./gradlew",
  "adb",
  // ORM
  "prisma",
  // Frontend build
  "next", "vite", "webpack", "esbuild",
  // Search / file
  "rg", "grep", "find", "fd",
  // Basic shell read-only
  "ls", "dir", "cat", "head", "tail", "echo", "type",
  // Diff
  "diff",
  // Env
  "env", "printenv",
]);

export interface AllowlistResult {
  allowed: boolean;
  prefix?: string;
}

export function checkAllowlist(command: string): AllowlistResult {
  const trimmed = command.trim();
  if (!trimmed) return { allowed: false, prefix: "" };

  const prefix = trimmed.split(/\s+/)[0];
  if (ALLOWED_PREFIXES.has(prefix)) return { allowed: true, prefix };
  return { allowed: false, prefix };
}

// ─── Path Traversal Guard ────────────────────────────────────────────────────

export function checkPathTraversal(filePath: string): GuardResult {
  const decoded = decodeURIComponent(filePath).replace(/\\/g, "/");
  if (decoded.includes("../") || decoded.includes("/..")) {
    return { safe: false, reason: "path traversal '..' — relative path escapes working directory" };
  }
  if (/%2e%2e/i.test(filePath)) {
    return { safe: false, reason: "path traversal (encoded) — relative path escapes working directory" };
  }
  return { safe: true };
}
