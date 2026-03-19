#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { runCommand, runFiltered, formatResult } from "./runner.js";
import { getSummary, getHistory, getDailyBreakdown, recordBlocked } from "./tracking.js";
import { validateArgs, checkAllowlist, checkPathTraversal, sanitizeShellLiteral } from "./guard.js";
import {
  detectAndFilter,
  filterGitStatus, filterGitLog, filterGitDiff, filterGitSimple,
  filterTestOutput, filterBuildOutput,
  filterLs, filterFind, filterGrep,
  filterDockerPs, filterLogs, filterJson, compressGeneric,
  filterGradleBuild, filterGradleTasks,
  filterLogcat, filterAdbDevices, filterAdbInstall,
  filterCargo, filterPytest, filterGoTest, filterVitest, filterPlaywright,
  filterTsc, filterLint, filterRuff, filterGolangci,
  filterNext, filterPrettier, filterNpm, filterPnpm, filterPip,
  filterDocker, filterKubectl, filterGh, filterCurl,
  filterEnv, filterDiff, filterPrisma, filterSummary,
} from "./filters.js";

// Load config on startup
loadConfig();

// ─── Helpers ────────────────────────────────────────────────────────────────

function tokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

function blocked(reason: string, rawCmd = "", rtkCmd = "") {
  recordBlocked(rawCmd, rtkCmd, reason);
  return { content: [{ type: "text" as const, text: `blocked: ${reason}` }] };
}

// ─── Server Setup ───────────────────────────────────────────────────────────

const server = new McpServer({
  name: "rtk-mcp-server",
  version: "1.0.0",
});

// ─── Tool: rtk_run ──────────────────────────────────────────────────────────

server.registerTool(
  "rtk_run",
  {
    title: "Run Command (Compressed)",
    description: `Execute any shell command and return compressed output with token savings.
Automatically detects command type (git, test, build, grep, etc.) and applies the best compression strategy.
Use this instead of running shell commands directly to save 60-90% of tokens.

Args:
  - command (string): The shell command to execute
  - cwd (string, optional): Working directory (defaults to $HOME)

Returns: Compressed output with token savings stats.`,
    inputSchema: {
      command: z.string().min(1).describe("Shell command to execute"),
      cwd: z.string().optional().describe("Working directory (defaults to $HOME)"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ command, cwd }) => {
    const al = checkAllowlist(command);
    if (!al.allowed) return blocked(`command not in allowlist: '${al.prefix}' — rtk_run only accepts known developer commands`, command, 'rtk_run');
    const firstSpace = command.indexOf(" ");
    const argsOnly = firstSpace >= 0 ? command.slice(firstSpace + 1) : "";
    const gv = validateArgs(argsOnly);
    if (!gv.safe) return blocked(gv.reason!, command, 'rtk_run');
    const result = runCommand(command, cwd);
    const raw = result.stdout + (result.stderr ? "\n" + result.stderr : "");
    const { filtered, strategy } = detectAndFilter(command, raw);

    const rawTokens = tokenEstimate(raw);
    const filteredTokens = tokenEstimate(filtered);
    const savings = rawTokens > 0 ? Math.round((1 - filteredTokens / rawTokens) * 100) : 0;
    const meta = result.exitCode !== 0 ? `[exit: ${result.exitCode}] ` : "";
    const stats = rawTokens > filteredTokens ? `\n[${strategy}] ~${rawTokens}→${filteredTokens} tokens (${savings}% saved)` : "";

    return { content: [{ type: "text", text: `${meta}${filtered}${stats}` }] };
  }
);

// ─── Tool: rtk_git ──────────────────────────────────────────────────────────

server.registerTool(
  "rtk_git",
  {
    title: "Git (Compressed)",
    description: `Run git commands with compressed output. Saves 75-92% tokens.

Args:
  - args (string): Git arguments (e.g., "status", "log -n 10", "diff", "push")
  - cwd (string, optional): Repository path

Returns: Compressed git output.
  - status: branch + changed files summary
  - log: one-line per commit
  - diff: file summary + condensed hunks
  - push/pull/add/commit: "ok" + essential info`,
    inputSchema: {
      args: z.string().min(1).describe("Git arguments (e.g., 'status', 'log -n 10', 'diff HEAD~1')"),
      cwd: z.string().optional().describe("Repository path"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ args, cwd }) => {
    const g = validateArgs(args); if (!g.safe) return blocked(g.reason!, args, 'rtk_git');
    const filterKey = `git ${args}`;
    let cmd = `git ${args}`;

    if (/^status(\s|$)/.test(args)) {
      cmd = `git status --porcelain=v1 -b`;
    } else if (
      /^log(\s|$)/.test(args) &&
      !args.includes("--format") && !args.includes("--pretty") && !args.includes("--oneline")
    ) {
      const extraArgs = args.replace(/^log\s*/, "").trim();
      cmd = `git log --format="%h %s%n%b%n---END---" ${extraArgs}`.trimEnd();
    }

    const result = runCommand(cmd, cwd);
    let raw = result.stdout + (result.stderr ? "\n" + result.stderr : "");

    if (/^add(\s|$)/.test(args)) {
      const stat = runCommand(`git diff --cached --shortstat`, cwd);
      if (stat.stdout.trim()) raw = stat.stdout;
    }

    const { filtered } = detectAndFilter(filterKey, raw);
    const meta = result.exitCode !== 0 ? `[exit: ${result.exitCode}] ` : "";
    return { content: [{ type: "text", text: `${meta}${filtered}` }] };
  }
);

// ─── Tool: rtk_test ─────────────────────────────────────────────────────────

server.registerTool(
  "rtk_test",
  {
    title: "Test Runner (Compressed)",
    description: `Run tests with compressed output — shows failures only. Saves ~90% tokens.

Args:
  - command (string): Full test command (e.g., "cargo test", "pytest", "npm test", "go test ./...")
  - cwd (string, optional): Project directory

Returns: "PASSED: N tests" or "FAILED: N/M tests" with failure details only.`,
    inputSchema: {
      command: z.string().min(1).describe("Test command"),
      cwd: z.string().optional().describe("Project directory"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async ({ command, cwd }) => {
    const g = validateArgs(command); if (!g.safe) return blocked(g.reason!, command, 'rtk_test');
    const result = runCommand(command, cwd, 120_000);
    const raw = result.stdout + (result.stderr ? "\n" + result.stderr : "");
    const filtered = filterTestOutput(raw);
    return { content: [{ type: "text", text: result.exitCode !== 0 ? `[exit: ${result.exitCode}]\n${filtered}` : filtered }] };
  }
);

// ─── Tool: rtk_read ─────────────────────────────────────────────────────────

server.registerTool(
  "rtk_read",
  {
    title: "Read File (Compressed)",
    description: `Read a file with smart compression. For large files, shows first and last sections with line count.

Args:
  - path (string): File path to read
  - cwd (string, optional): Base directory
  - mode (string, optional): "full" (default), "signatures" (function signatures only), or "head" (first 50 lines)

Returns: File content, compressed based on mode.`,
    inputSchema: {
      path: z.string().min(1).describe("File path to read"),
      cwd: z.string().optional().describe("Base directory"),
      mode: z.enum(["full", "signatures", "head"]).default("full").describe("Read mode"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ path, cwd, mode }) => {
    const pt = checkPathTraversal(path); if (!pt.safe) return blocked(pt.reason!, path, 'rtk_read');
    const catCmd = process.platform === "win32" ? `type "${path}"` : `cat "${path}"`;
    const result = runCommand(catCmd, cwd);
    if (result.exitCode !== 0) {
      return { content: [{ type: "text", text: `Error reading ${path}: ${result.stderr.trim()}` }] };
    }

    const raw = result.stdout;
    const lines = raw.split("\n");
    let output: string;

    if (mode === "head") {
      output = lines.slice(0, 50).join("\n");
      if (lines.length > 50) output += `\n... (${lines.length - 50} more lines)`;
    } else if (mode === "signatures") {
      const sigs = lines.filter((l) =>
        /^\s*(export\s+)?(async\s+)?(function|class|const\s+\w+\s*=|def |fn |pub fn |interface |type |struct |impl )/.test(l) ||
        /^\s*(public|private|protected)\s+(static\s+)?(async\s+)?[\w<>\[\]]+\s+\w+\s*\(/.test(l)
      );
      output = sigs.length > 0
        ? `${path} (${lines.length} lines, ${sigs.length} signatures):\n${sigs.join("\n")}`
        : `${path} (${lines.length} lines, no signatures detected):\n${lines.slice(0, 30).join("\n")}`;
    } else {
      if (lines.length > 200) {
        output = [
          `${path} (${lines.length} lines):`,
          ...lines.slice(0, 80),
          `\n... (${lines.length - 120} lines omitted) ...\n`,
          ...lines.slice(-40),
        ].join("\n");
      } else {
        output = raw;
      }
    }

    return { content: [{ type: "text", text: output }] };
  }
);

// ─── Tool: rtk_ls ───────────────────────────────────────────────────────────

server.registerTool(
  "rtk_ls",
  {
    title: "List Directory (Compressed)",
    description: `Token-optimized directory listing. Returns a compact view.

Args:
  - path (string, optional): Directory to list (defaults to ".")
  - cwd (string, optional): Base directory

Returns: Compact directory listing.`,
    inputSchema: {
      path: z.string().default(".").describe("Directory to list"),
      cwd: z.string().optional().describe("Base directory"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ path, cwd }) => {
    const pt = checkPathTraversal(path); if (!pt.safe) return blocked(pt.reason!, path, 'rtk_ls');
    const lsCmd = process.platform === "win32" ? `dir "${path}"` : `ls -la "${path}"`;
    const result = runCommand(lsCmd, cwd);
    return { content: [{ type: "text", text: filterLs(result.stdout) }] };
  }
);

// ─── Tool: rtk_grep ─────────────────────────────────────────────────────────

server.registerTool(
  "rtk_grep",
  {
    title: "Search (Compressed)",
    description: `Search files with compressed, grouped results. Saves ~80% tokens.

Args:
  - pattern (string): Search pattern (regex supported)
  - path (string, optional): Directory or file to search (defaults to ".")
  - cwd (string, optional): Base directory

Returns: Matches grouped by file with counts.`,
    inputSchema: {
      pattern: z.string().min(1).describe("Search pattern"),
      path: z.string().default(".").describe("Search path"),
      cwd: z.string().optional().describe("Base directory"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ pattern, path, cwd }) => {
    const pt = checkPathTraversal(path); if (!pt.safe) return blocked(pt.reason!, path, 'rtk_grep');
    const safePattern = sanitizeShellLiteral(pattern);
    const safePath = sanitizeShellLiteral(path);
    let result = runCommand(`rg -n --with-filename "${safePattern}" "${safePath}"`, cwd);
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      result = runCommand(`grep -rn "${safePattern}" "${safePath}"`, cwd);
    }
    if ((result.exitCode !== 0 || !result.stdout.trim()) && process.platform === "win32") {
      const winPath = path.replace(/\//g, "\\");
      const safeWinPath = sanitizeShellLiteral(winPath);
      result = runCommand(`findstr /rn "${safePattern}" "${safeWinPath}"`, cwd);
      // findstr single-file output is "linenum:content" — prepend filename so filterGrep parses it correctly
      if (result.stdout.trim() && /^\d+:/.test(result.stdout.trim().split("\n")[0])) {
        const basename = winPath.split("\\").pop() ?? winPath;
        result = { ...result, stdout: result.stdout.split("\n").map(l => l.trim() ? `${basename}:${l}` : l).join("\n") };
      }
    }
    return { content: [{ type: "text", text: filterGrep(result.stdout, pattern) }] };
  }
);

// ─── Tool: rtk_build ────────────────────────────────────────────────────────

server.registerTool(
  "rtk_build",
  {
    title: "Build/Lint (Compressed)",
    description: `Run build or lint commands with compressed output. Shows errors and warnings only.

Args:
  - command (string): Build command (e.g., "npm run build", "cargo build", "tsc", "eslint .")
  - cwd (string, optional): Project directory

Returns: "build ok" or grouped errors/warnings.`,
    inputSchema: {
      command: z.string().min(1).describe("Build/lint command"),
      cwd: z.string().optional().describe("Project directory"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async ({ command, cwd }) => {
    const g = validateArgs(command); if (!g.safe) return blocked(g.reason!, command, 'rtk_build');
    const result = runCommand(command, cwd, 120_000);
    const raw = result.stdout + (result.stderr ? "\n" + result.stderr : "");
    const filtered = filterBuildOutput(raw);
    return { content: [{ type: "text", text: result.exitCode !== 0 ? `[exit: ${result.exitCode}]\n${filtered}` : filtered }] };
  }
);

// ─── Tool: rtk_logs ─────────────────────────────────────────────────────────

server.registerTool(
  "rtk_logs",
  {
    title: "View Logs (Deduplicated)",
    description: `View log files or container logs with deduplication. Collapses repeated lines with counts.

Args:
  - command (string): Log command (e.g., "cat app.log", "docker logs mycontainer", "kubectl logs mypod")
  - cwd (string, optional): Working directory

Returns: Deduplicated logs with repeat counts.`,
    inputSchema: {
      command: z.string().min(1).describe("Log command"),
      cwd: z.string().optional().describe("Working directory"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  async ({ command, cwd }) => {
    const g = validateArgs(command); if (!g.safe) return blocked(g.reason!, command, 'rtk_logs');
    const result = runCommand(command, cwd);
    return { content: [{ type: "text", text: filterLogs(result.stdout) }] };
  }
);

// ─── Tool: rtk_gradle ───────────────────────────────────────────────────────

server.registerTool(
  "rtk_gradle",
  {
    title: "Gradle (Compressed)",
    description: `Run Gradle/Gradlew commands with compressed output. Ideal for Android projects.
Strips download progress, UP-TO-DATE noise, keeps only errors, warnings, and build results.

Args:
  - args (string): Gradle arguments (e.g., "assembleDebug", "test", "lintDebug", "tasks", "clean build")
  - cwd (string, optional): Project directory

Returns: BUILD SUCCESSFUL or errors/warnings only.`,
    inputSchema: {
      args: z.string().min(1).describe("Gradle arguments"),
      cwd: z.string().optional().describe("Project directory"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ args, cwd }) => {
    const g = validateArgs(args); if (!g.safe) return blocked(g.reason!, args, 'rtk_gradle');
    const gradleCmd = process.platform === "win32" ? "gradlew.bat" : "./gradlew";
    const result = runCommand(`${gradleCmd} ${args}`, cwd, 900_000);
    const raw = result.stdout + (result.stderr ? "\n" + result.stderr : "");
    const { filtered } = detectAndFilter(`gradlew ${args}`, raw);
    const meta = result.exitCode !== 0 ? `[exit: ${result.exitCode}]\n` : "";
    return { content: [{ type: "text", text: `${meta}${filtered}` }] };
  }
);

// ─── Tool: rtk_adb ──────────────────────────────────────────────────────────

server.registerTool(
  "rtk_adb",
  {
    title: "ADB (Compressed)",
    description: `Run ADB commands with compressed output. Especially useful for logcat.

Args:
  - args (string): ADB arguments (e.g., "devices", "logcat -d", "install app.apk")
  - cwd (string, optional): Working directory

Returns: Compressed ADB output.`,
    inputSchema: {
      args: z.string().min(1).describe("ADB arguments"),
      cwd: z.string().optional().describe("Working directory"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ args, cwd }) => {
    const g = validateArgs(args); if (!g.safe) return blocked(g.reason!, args, 'rtk_adb');
    const result = runCommand(`adb ${args}`, cwd, 60_000);
    const raw = result.stdout + (result.stderr ? "\n" + result.stderr : "");
    const { filtered } = detectAndFilter(`adb ${args}`, raw);
    const meta = result.exitCode !== 0 ? `[exit: ${result.exitCode}]\n` : "";
    return { content: [{ type: "text", text: `${meta}${filtered}` }] };
  }
);

// ─── Tool: rtk_cargo ────────────────────────────────────────────────────────

server.registerTool(
  "rtk_cargo",
  {
    title: "Cargo (Compressed)",
    description: `Run cargo test/build/clippy with compressed output. Shows failures only for tests.

Args:
  - command (string): Cargo subcommand + args (e.g., "test", "build --release", "clippy -- -D warnings")
  - cwd (string, optional): Project directory`,
    inputSchema: {
      command: z.string().min(1).describe("Cargo command (e.g., 'test', 'build --release', 'clippy')"),
      cwd: z.string().optional().describe("Project directory"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ command, cwd }) => {
    const g = validateArgs(command); if (!g.safe) return blocked(g.reason!, command, 'rtk_cargo');
    const r = runFiltered(`cargo ${command}`, "rtk_cargo", filterCargo, cwd, 120_000);
    return { content: [{ type: "text", text: formatResult(r) }] };
  }
);

// ─── Tool: rtk_pytest ───────────────────────────────────────────────────────

server.registerTool(
  "rtk_pytest",
  {
    title: "Pytest (Compressed)",
    description: `Run pytest and show failures only. Saves ~90% tokens on passing test suites.

Args:
  - args (string, optional): pytest arguments (e.g., "tests/", "-k test_login", "-x")
  - cwd (string, optional): Project directory`,
    inputSchema: {
      args: z.string().default("").describe("pytest arguments"),
      cwd: z.string().optional().describe("Project directory"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ args, cwd }) => {
    const g = validateArgs(args); if (!g.safe) return blocked(g.reason!, args, 'rtk_pytest');
    const cmd = args.trim() ? `pytest ${args}` : "pytest";
    const r = runFiltered(cmd, "rtk_pytest", filterPytest, cwd, 120_000);
    return { content: [{ type: "text", text: formatResult(r) }] };
  }
);

// ─── Tool: rtk_go ───────────────────────────────────────────────────────────

server.registerTool(
  "rtk_go",
  {
    title: "Go (Compressed)",
    description: `Run go test/build/vet with compressed output.

Args:
  - command (string): Go subcommand (e.g., "test ./...", "build .", "vet ./...")
  - cwd (string, optional): Project directory`,
    inputSchema: {
      command: z.string().min(1).describe("Go command (e.g., 'test ./...', 'build .', 'vet ./...')"),
      cwd: z.string().optional().describe("Project directory"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ command, cwd }) => {
    const g = validateArgs(command); if (!g.safe) return blocked(g.reason!, command, 'rtk_go');
    const isTest = /^test/.test(command.trim());
    const filter = isTest ? filterGoTest : filterBuildOutput;
    const r = runFiltered(`go ${command}`, "rtk_go", filter, cwd, 120_000);
    return { content: [{ type: "text", text: formatResult(r) }] };
  }
);

// ─── Tool: rtk_vitest ───────────────────────────────────────────────────────

server.registerTool(
  "rtk_vitest",
  {
    title: "Vitest (Compressed)",
    description: `Run vitest and show failures only.

Args:
  - args (string, optional): vitest arguments (e.g., "run", "run --reporter=verbose")
  - cwd (string, optional): Project directory`,
    inputSchema: {
      args: z.string().default("run").describe("vitest arguments"),
      cwd: z.string().optional().describe("Project directory"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ args, cwd }) => {
    const g = validateArgs(args); if (!g.safe) return blocked(g.reason!, args, 'rtk_vitest');
    const r = runFiltered(`vitest ${args}`, "rtk_vitest", filterVitest, cwd, 120_000);
    return { content: [{ type: "text", text: formatResult(r) }] };
  }
);

// ─── Tool: rtk_playwright ───────────────────────────────────────────────────

server.registerTool(
  "rtk_playwright",
  {
    title: "Playwright (Compressed)",
    description: `Run Playwright E2E tests and show failures only.

Args:
  - args (string, optional): playwright arguments (e.g., "", "--project=chromium", "tests/login.spec.ts")
  - cwd (string, optional): Project directory`,
    inputSchema: {
      args: z.string().default("").describe("playwright test arguments"),
      cwd: z.string().optional().describe("Project directory"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ args, cwd }) => {
    const g = validateArgs(args); if (!g.safe) return blocked(g.reason!, args, 'rtk_playwright');
    const cmd = args.trim() ? `npx playwright test ${args}` : "npx playwright test";
    const r = runFiltered(cmd, "rtk_playwright", filterPlaywright, cwd, 300_000);
    return { content: [{ type: "text", text: formatResult(r) }] };
  }
);

// ─── Tool: rtk_tsc ──────────────────────────────────────────────────────────

server.registerTool(
  "rtk_tsc",
  {
    title: "TypeScript Compiler (Compressed)",
    description: `Run tsc type-checking and group errors by file.

Args:
  - args (string, optional): tsc arguments (e.g., "--noEmit", "--project tsconfig.json")
  - cwd (string, optional): Project directory`,
    inputSchema: {
      args: z.string().default("--noEmit").describe("tsc arguments"),
      cwd: z.string().optional().describe("Project directory"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ args, cwd }) => {
    const g = validateArgs(args); if (!g.safe) return blocked(g.reason!, args, 'rtk_tsc');
    const r = runFiltered(`npx tsc ${args}`, "rtk_tsc", filterTsc, cwd, 60_000);
    return { content: [{ type: "text", text: formatResult(r) }] };
  }
);

// ─── Tool: rtk_lint ─────────────────────────────────────────────────────────

server.registerTool(
  "rtk_lint",
  {
    title: "ESLint/Biome (Compressed)",
    description: `Run ESLint or Biome and group results by rule.

Args:
  - command (string): Lint command (e.g., "eslint .", "eslint src --ext .ts", "biome check .")
  - cwd (string, optional): Project directory`,
    inputSchema: {
      command: z.string().min(1).describe("Lint command (e.g., 'eslint .', 'biome check .')"),
      cwd: z.string().optional().describe("Project directory"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ command, cwd }) => {
    const g = validateArgs(command); if (!g.safe) return blocked(g.reason!, command, 'rtk_lint');
    const r = runFiltered(command, "rtk_lint", filterLint, cwd, 60_000);
    return { content: [{ type: "text", text: formatResult(r) }] };
  }
);

// ─── Tool: rtk_ruff ─────────────────────────────────────────────────────────

server.registerTool(
  "rtk_ruff",
  {
    title: "Ruff (Compressed)",
    description: `Run ruff Python linter with compressed output grouped by file.

Args:
  - args (string, optional): ruff arguments (e.g., "check .", "check src/ --output-format json")
  - cwd (string, optional): Project directory`,
    inputSchema: {
      args: z.string().default("check .").describe("ruff arguments"),
      cwd: z.string().optional().describe("Project directory"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ args, cwd }) => {
    const g = validateArgs(args); if (!g.safe) return blocked(g.reason!, args, 'rtk_ruff');
    const r = runFiltered(`ruff ${args}`, "rtk_ruff", filterRuff, cwd, 60_000);
    return { content: [{ type: "text", text: formatResult(r) }] };
  }
);

// ─── Tool: rtk_golangci ─────────────────────────────────────────────────────

server.registerTool(
  "rtk_golangci",
  {
    title: "golangci-lint (Compressed)",
    description: `Run golangci-lint with compressed output grouped by linter.

Args:
  - args (string, optional): golangci-lint arguments (e.g., "run", "run --out-format json ./...")
  - cwd (string, optional): Project directory`,
    inputSchema: {
      args: z.string().default("run").describe("golangci-lint arguments"),
      cwd: z.string().optional().describe("Project directory"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ args, cwd }) => {
    const g = validateArgs(args); if (!g.safe) return blocked(g.reason!, args, 'rtk_golangci');
    const r = runFiltered(`golangci-lint ${args}`, "rtk_golangci", filterGolangci, cwd, 120_000);
    return { content: [{ type: "text", text: formatResult(r) }] };
  }
);

// ─── Tool: rtk_next ─────────────────────────────────────────────────────────

server.registerTool(
  "rtk_next",
  {
    title: "Next.js Build (Compressed)",
    description: `Run Next.js build/dev with compressed output. Strips download/compile progress.

Args:
  - args (string, optional): next arguments (e.g., "build", "lint")
  - cwd (string, optional): Project directory`,
    inputSchema: {
      args: z.string().default("build").describe("next arguments"),
      cwd: z.string().optional().describe("Project directory"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ args, cwd }) => {
    const g = validateArgs(args); if (!g.safe) return blocked(g.reason!, args, 'rtk_next');
    const r = runFiltered(`next ${args}`, "rtk_next", filterNext, cwd, 120_000);
    return { content: [{ type: "text", text: formatResult(r) }] };
  }
);

// ─── Tool: rtk_prettier ─────────────────────────────────────────────────────

server.registerTool(
  "rtk_prettier",
  {
    title: "Prettier (Compressed)",
    description: `Run prettier --check and list only files needing formatting.

Args:
  - args (string, optional): prettier arguments (e.g., "--check .", "--check src/**/*.ts")
  - cwd (string, optional): Project directory`,
    inputSchema: {
      args: z.string().default("--check .").describe("prettier arguments"),
      cwd: z.string().optional().describe("Project directory"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ args, cwd }) => {
    const g = validateArgs(args); if (!g.safe) return blocked(g.reason!, args, 'rtk_prettier');
    const r = runFiltered(`npx prettier ${args}`, "rtk_prettier", filterPrettier, cwd, 60_000);
    return { content: [{ type: "text", text: formatResult(r) }] };
  }
);

// ─── Tool: rtk_npm ──────────────────────────────────────────────────────────

server.registerTool(
  "rtk_npm",
  {
    title: "NPM (Compressed)",
    description: `Run npm commands with progress stripped, errors preserved.

Args:
  - command (string): npm command (e.g., "install", "run build", "run test", "ci")
  - cwd (string, optional): Project directory`,
    inputSchema: {
      command: z.string().min(1).describe("npm command (e.g., 'install', 'run build')"),
      cwd: z.string().optional().describe("Project directory"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ command, cwd }) => {
    const g = validateArgs(command); if (!g.safe) return blocked(g.reason!, command, 'rtk_npm');
    const r = runFiltered(`npm ${command}`, "rtk_npm", filterNpm, cwd, 120_000);
    return { content: [{ type: "text", text: formatResult(r) }] };
  }
);

// ─── Tool: rtk_pnpm ─────────────────────────────────────────────────────────

server.registerTool(
  "rtk_pnpm",
  {
    title: "pnpm (Compressed)",
    description: `Run pnpm commands with compact output.

Args:
  - command (string): pnpm command (e.g., "install", "list", "outdated", "run build")
  - cwd (string, optional): Project directory`,
    inputSchema: {
      command: z.string().min(1).describe("pnpm command"),
      cwd: z.string().optional().describe("Project directory"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ command, cwd }) => {
    const g = validateArgs(command); if (!g.safe) return blocked(g.reason!, command, 'rtk_pnpm');
    const r = runFiltered(`pnpm ${command}`, "rtk_pnpm", filterPnpm, cwd, 120_000);
    return { content: [{ type: "text", text: formatResult(r) }] };
  }
);

// ─── Tool: rtk_pip ──────────────────────────────────────────────────────────

server.registerTool(
  "rtk_pip",
  {
    title: "pip (Compressed)",
    description: `Run pip commands with compact output.

Args:
  - command (string): pip command (e.g., "install -r requirements.txt", "list", "outdated")
  - cwd (string, optional): Project directory`,
    inputSchema: {
      command: z.string().min(1).describe("pip command"),
      cwd: z.string().optional().describe("Project directory"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ command, cwd }) => {
    const g = validateArgs(command); if (!g.safe) return blocked(g.reason!, command, 'rtk_pip');
    const r = runFiltered(`pip ${command}`, "rtk_pip", filterPip, cwd, 120_000);
    return { content: [{ type: "text", text: formatResult(r) }] };
  }
);

// ─── Tool: rtk_docker ───────────────────────────────────────────────────────

server.registerTool(
  "rtk_docker",
  {
    title: "Docker (Compressed)",
    description: `Run docker commands with compact output.

Args:
  - command (string): docker command (e.g., "ps", "images", "logs mycontainer", "ps -a")
  - cwd (string, optional): Working directory`,
    inputSchema: {
      command: z.string().min(1).describe("docker command (e.g., 'ps', 'images', 'logs mycontainer')"),
      cwd: z.string().optional().describe("Working directory"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ command, cwd }) => {
    const g = validateArgs(command); if (!g.safe) return blocked(g.reason!, command, 'rtk_docker');
    const result = runCommand(`docker ${command}`, cwd, 30_000);
    const raw = result.stdout + (result.stderr ? "\n" + result.stderr : "");
    const filtered = filterDocker(raw, command);
    const meta = result.exitCode !== 0 ? `[exit: ${result.exitCode}]\n` : "";
    return { content: [{ type: "text", text: `${meta}${filtered}` }] };
  }
);

// ─── Tool: rtk_kubectl ──────────────────────────────────────────────────────

server.registerTool(
  "rtk_kubectl",
  {
    title: "kubectl (Compressed)",
    description: `Run kubectl commands with compact output.

Args:
  - command (string): kubectl command (e.g., "get pods", "get services", "logs mypod", "describe pod mypod")
  - cwd (string, optional): Working directory`,
    inputSchema: {
      command: z.string().min(1).describe("kubectl command (e.g., 'get pods', 'logs mypod')"),
      cwd: z.string().optional().describe("Working directory"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ command, cwd }) => {
    const g = validateArgs(command); if (!g.safe) return blocked(g.reason!, command, 'rtk_kubectl');
    const result = runCommand(`kubectl ${command}`, cwd, 30_000);
    const raw = result.stdout + (result.stderr ? "\n" + result.stderr : "");
    const filtered = filterKubectl(raw, command);
    const meta = result.exitCode !== 0 ? `[exit: ${result.exitCode}]\n` : "";
    return { content: [{ type: "text", text: `${meta}${filtered}` }] };
  }
);

// ─── Tool: rtk_gh ───────────────────────────────────────────────────────────

server.registerTool(
  "rtk_gh",
  {
    title: "GitHub CLI (Compressed)",
    description: `Run gh CLI commands with compact output.

Args:
  - command (string): gh command (e.g., "pr list", "issue list", "run list", "pr view 123")
  - cwd (string, optional): Repository directory`,
    inputSchema: {
      command: z.string().min(1).describe("gh command (e.g., 'pr list', 'issue list', 'run list')"),
      cwd: z.string().optional().describe("Repository directory"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ command, cwd }) => {
    const g = validateArgs(command); if (!g.safe) return blocked(g.reason!, command, 'rtk_gh');
    const result = runCommand(`gh ${command}`, cwd, 30_000);
    const raw = result.stdout + (result.stderr ? "\n" + result.stderr : "");
    const filtered = filterGh(raw, command);
    const meta = result.exitCode !== 0 ? `[exit: ${result.exitCode}]\n` : "";
    return { content: [{ type: "text", text: `${meta}${filtered}` }] };
  }
);

// ─── Tool: rtk_curl ─────────────────────────────────────────────────────────

server.registerTool(
  "rtk_curl",
  {
    title: "curl (Compressed)",
    description: `Run curl and auto-detect JSON responses for structure-only output.

Args:
  - url (string): URL to request
  - args (string, optional): Additional curl arguments (e.g., "-X POST -H 'Content-Type: application/json'")
  - cwd (string, optional): Working directory`,
    inputSchema: {
      url: z.string().min(1).describe("URL to request"),
      args: z.string().default("").describe("Additional curl arguments"),
      cwd: z.string().optional().describe("Working directory"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ url, args, cwd }) => {
    const g = validateArgs(args); if (!g.safe) return blocked(g.reason!, args, 'rtk_curl');
    const curlArgs = args.trim() ? `${args} ${url}` : url;
    const r = runFiltered(`curl -s ${curlArgs}`, "rtk_curl", filterCurl, cwd, 30_000);
    return { content: [{ type: "text", text: formatResult(r) }] };
  }
);

// ─── Tool: rtk_json ─────────────────────────────────────────────────────────

server.registerTool(
  "rtk_json",
  {
    title: "JSON Structure (Compressed)",
    description: `Read a JSON file and show its structure without values — field names, types, array lengths.

Args:
  - path (string): Path to JSON file
  - cwd (string, optional): Base directory`,
    inputSchema: {
      path: z.string().min(1).describe("Path to JSON file"),
      cwd: z.string().optional().describe("Base directory"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ path, cwd }) => {
    const pt = checkPathTraversal(path); if (!pt.safe) return blocked(pt.reason!, path, 'rtk_json');
    const catCmd = process.platform === "win32" ? `type "${path}"` : `cat "${path}"`;
    const result = runCommand(catCmd, cwd);
    if (result.exitCode !== 0) {
      return { content: [{ type: "text", text: `Error reading ${path}: ${result.stderr.trim()}` }] };
    }
    return { content: [{ type: "text", text: filterJson(result.stdout) }] };
  }
);

// ─── Tool: rtk_env ──────────────────────────────────────────────────────────

server.registerTool(
  "rtk_env",
  {
    title: "Environment Variables (Masked)",
    description: `List environment variables with secrets masked. Safe to use in AI context.

Args:
  - filter (string, optional): Filter pattern (e.g., "PATH", "NODE")
  - cwd (string, optional): Working directory`,
    inputSchema: {
      filter: z.string().optional().describe("Filter pattern for variable names"),
      cwd: z.string().optional().describe("Working directory"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ filter, cwd }) => {
    const envCmd = process.platform === "win32" ? "set" : "env";
    const result = runCommand(envCmd, cwd);
    return { content: [{ type: "text", text: filterEnv(result.stdout, filter) }] };
  }
);

// ─── Tool: rtk_diff ─────────────────────────────────────────────────────────

server.registerTool(
  "rtk_diff",
  {
    title: "Diff (Condensed)",
    description: `Run diff and show a condensed unified diff with per-file change counts.

Args:
  - args (string): diff arguments (e.g., "file1.txt file2.txt", "-u old.py new.py")
  - cwd (string, optional): Working directory`,
    inputSchema: {
      args: z.string().min(1).describe("diff arguments"),
      cwd: z.string().optional().describe("Working directory"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ args, cwd }) => {
    const g = validateArgs(args); if (!g.safe) return blocked(g.reason!, args, 'rtk_diff');
    // Try native diff first, fall back to git diff --no-index (works on Windows without diff in PATH)
    let diffResult = runCommand(`diff ${args}`, cwd, 30_000);
    if (diffResult.exitCode === 127 || /not recognized|not found/i.test(diffResult.stderr + diffResult.stdout)) {
      diffResult = runCommand(`git diff --no-index -- ${args}`, cwd, 30_000);
    }
    const raw = diffResult.stdout + (diffResult.stderr ? "\n" + diffResult.stderr : "");
    const filtered = filterDiff(raw);
    const r = { raw, filtered, exitCode: diffResult.exitCode, tokensBefore: Math.ceil(raw.length / 4), tokensAfter: Math.ceil(filtered.length / 4) };
    return { content: [{ type: "text", text: formatResult(r) }] };
  }
);

// ─── Tool: rtk_prisma ───────────────────────────────────────────────────────

server.registerTool(
  "rtk_prisma",
  {
    title: "Prisma (Compressed)",
    description: `Run Prisma commands with ASCII art stripped.

Args:
  - command (string): prisma command (e.g., "generate", "migrate dev", "migrate status", "db push")
  - cwd (string, optional): Project directory`,
    inputSchema: {
      command: z.string().min(1).describe("prisma command (e.g., 'generate', 'migrate dev')"),
      cwd: z.string().optional().describe("Project directory"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ command, cwd }) => {
    const g = validateArgs(command); if (!g.safe) return blocked(g.reason!, command, 'rtk_prisma');
    const r = runFiltered(`npx prisma ${command}`, "rtk_prisma", filterPrisma, cwd, 120_000);
    return { content: [{ type: "text", text: formatResult(r) }] };
  }
);

// ─── Tool: rtk_find ─────────────────────────────────────────────────────────

server.registerTool(
  "rtk_find",
  {
    title: "Find Files (Grouped)",
    description: `Find files matching a pattern, grouped by directory.

Args:
  - pattern (string): File pattern to search for (e.g., "*.ts", "*.log", "test_*")
  - path (string, optional): Directory to search in (defaults to ".")
  - cwd (string, optional): Working directory`,
    inputSchema: {
      pattern: z.string().min(1).describe("File pattern (e.g., '*.ts', 'test_*')"),
      path: z.string().default(".").describe("Search root directory"),
      cwd: z.string().optional().describe("Working directory"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ pattern, path, cwd }) => {
    const pt = checkPathTraversal(path); if (!pt.safe) return blocked(pt.reason!, path, 'rtk_find');
    let result = runCommand(`fd "${pattern}" "${path}"`, cwd);
    if (result.exitCode !== 0 || !result.stdout.trim()) {
      const findCmd = process.platform === "win32"
        ? `dir /s /b "${path}\\${pattern}"`
        : `find "${path}" -name "${pattern}"`;
      result = runCommand(findCmd, cwd);
    }
    return { content: [{ type: "text", text: filterFind(result.stdout) }] };
  }
);

// ─── Tool: rtk_summary ──────────────────────────────────────────────────────

server.registerTool(
  "rtk_summary",
  {
    title: "Command Summary (Heuristic)",
    description: `Run any command and return a heuristic 6-line summary: first 3 + last 3 non-empty lines.
Use as a fallback for commands without a dedicated rtk tool.

Args:
  - command (string): Command to run
  - cwd (string, optional): Working directory`,
    inputSchema: {
      command: z.string().min(1).describe("Command to run"),
      cwd: z.string().optional().describe("Working directory"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ command, cwd }) => {
    const al = checkAllowlist(command);
    if (!al.allowed) return blocked(`command not in allowlist: '${al.prefix}' — rtk_summary only accepts known developer commands`, command, 'rtk_summary');
    const firstSpace = command.indexOf(" ");
    const argsOnly = firstSpace >= 0 ? command.slice(firstSpace + 1) : "";
    const gv = validateArgs(argsOnly); if (!gv.safe) return blocked(gv.reason!, command, 'rtk_summary');
    const r = runFiltered(command, "rtk_summary", filterSummary, cwd, 60_000);
    return { content: [{ type: "text", text: formatResult(r) }] };
  }
);

// ─── Tool: rtk_gain ─────────────────────────────────────────────────────────

server.registerTool(
  "rtk_gain",
  {
    title: "Token Savings Analytics",
    description: `Show how many tokens rtk-mcp-server has saved across all tool invocations.

Args:
  - args (string, optional): "history N" (last N runs), "daily" (daily breakdown), or empty for summary`,
    inputSchema: {
      args: z.string().default("").describe("'history N', 'daily', or empty for summary"),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  async ({ args }) => {
    const trimmed = args.trim().toLowerCase();

    if (trimmed.startsWith("history")) {
      const n = parseInt(trimmed.replace("history", "").trim()) || 20;
      const rows = getHistory(n);
      if (rows.length === 0) return { content: [{ type: "text", text: "No history yet." }] };
      const lines = rows.map((r) => {
        const date = new Date(r.timestamp).toISOString().slice(0, 19);
        const pct = r.raw_tokens > 0 ? Math.round((r.tokens_saved / r.raw_tokens) * 100) : 0;
        return `${date}  ${r.rtk_cmd.padEnd(18)}  ${r.tokens_saved}↓ (${pct}%)  ${r.raw_cmd.slice(0, 60)}`;
      });
      return { content: [{ type: "text", text: `Last ${rows.length} runs:\n${lines.join("\n")}` }] };
    }

    if (trimmed === "daily") {
      const rows = getDailyBreakdown();
      if (rows.length === 0) return { content: [{ type: "text", text: "No history yet." }] };
      const lines = rows.map((r) => `${r.date}  ${r.runs} runs  ${r.total_saved} tokens saved`);
      return { content: [{ type: "text", text: `Daily breakdown:\n${lines.join("\n")}` }] };
    }

    const s = getSummary();
    const text = [
      `rtk-mcp-server token savings:`,
      `  Total runs: ${s.total_runs}`,
      `  Raw tokens: ${s.total_raw_tokens.toLocaleString()}`,
      `  Filtered:   ${s.total_filtered_tokens.toLocaleString()}`,
      `  Saved:      ${s.total_saved.toLocaleString()} (${s.savings_pct}%)`,
      ``,
      `Use 'history N' or 'daily' for more detail.`,
    ].join("\n");
    return { content: [{ type: "text", text }] };
  }
);

// ─── Tool: rtk_init ─────────────────────────────────────────────────────────

server.registerTool(
  "rtk_init",
  {
    title: "Install Claude Code Hook",
    description: `Install or uninstall the Claude Code PreToolUse hook that auto-rewrites Bash commands to rtk tools.

Args:
  - args (string, optional): empty to install, "--uninstall" to remove`,
    inputSchema: {
      args: z.string().default("").describe("empty to install, '--uninstall' to remove"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  async ({ args }) => {
    import("os").then(() => {});
    import("fs").then(() => {});
    import("path").then(() => {});

    const os = await import("os");
    const fs = await import("fs");
    const path = await import("path");

    const hookDir = path.join(os.homedir(), ".rtk-mcp");
    const hookPath = path.join(hookDir, "hook.cjs");

    if (args.trim() === "--uninstall") {
      if (fs.existsSync(hookPath)) {
        fs.unlinkSync(hookPath);
        return {
          content: [{
            type: "text",
            text: [
              "Hook removed.",
              "",
              "Also remove this from ~/.claude/settings.json:",
              '  "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "node ~/.rtk-mcp/hook.cjs" }] }] }',
            ].join("\n"),
          }],
        };
      }
      return { content: [{ type: "text", text: "Hook not found (already removed)." }] };
    }

    // Install
    if (!fs.existsSync(hookDir)) fs.mkdirSync(hookDir, { recursive: true });

    const HOOK_SCRIPT = `#!/usr/bin/env node
// rtk-mcp hook: rewrites Bash commands to rtk MCP tools
// Auto-generated by rtk_init

const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin });
let input = '';
rl.on('line', (line) => { input += line + '\\n'; });
rl.on('close', () => {
  let payload;
  try { payload = JSON.parse(input); } catch { process.exit(0); }

  const toolName = payload?.tool_name ?? '';
  if (toolName !== 'Bash') { process.exit(0); }

  const cmd = (payload?.tool_input?.command ?? '').trim();
  const rewrite = rewriteCmd(cmd);
  if (!rewrite) { process.exit(0); }

  // Output the decision to block the Bash call
  process.stdout.write(JSON.stringify({ decision: 'block', reason: 'Use ' + rewrite.tool + ' instead', action: rewrite }));
  process.exit(0);
});

function rewriteCmd(cmd) {
  if (/^git\\s+(status|log|diff|add|commit|push|pull)/.test(cmd))
    return { tool: 'rtk_git', args: cmd.replace(/^git\\s+/, '') };
  if (/^cargo\\s+(test|build|clippy)/.test(cmd))
    return { tool: 'rtk_cargo', command: cmd.replace(/^cargo\\s+/, '') };
  if (/^pytest(\\s|$)/.test(cmd))
    return { tool: 'rtk_pytest', args: cmd.replace(/^pytest\\s*/, '') };
  if (/^go\\s+(test|build|vet)/.test(cmd))
    return { tool: 'rtk_go', command: cmd.replace(/^go\\s+/, '') };
  if (/^npm\\s+(run|install|ci)/.test(cmd))
    return { tool: 'rtk_npm', command: cmd.replace(/^npm\\s+/, '') };
  if (/^pnpm\\s+/.test(cmd))
    return { tool: 'rtk_pnpm', command: cmd.replace(/^pnpm\\s+/, '') };
  if (/^tsc(\\s|$)/.test(cmd))
    return { tool: 'rtk_tsc', args: cmd.replace(/^tsc\\s*/, '') };
  if (/^(eslint|biome)\\s+/.test(cmd))
    return { tool: 'rtk_lint', command: cmd };
  if (/^ruff\\s+(check|format)/.test(cmd))
    return { tool: 'rtk_ruff', args: cmd.replace(/^ruff\\s+/, '') };
  if (/^golangci-lint\\s+/.test(cmd))
    return { tool: 'rtk_golangci', args: cmd.replace(/^golangci-lint\\s+/, '') };
  if (/^docker\\s+(ps|images|logs)/.test(cmd))
    return { tool: 'rtk_docker', command: cmd.replace(/^docker\\s+/, '') };
  if (/^kubectl\\s+(get|logs|describe)/.test(cmd))
    return { tool: 'rtk_kubectl', command: cmd.replace(/^kubectl\\s+/, '') };
  if (/^gh\\s+(pr|issue|run)\\s+(list|view)/.test(cmd))
    return { tool: 'rtk_gh', command: cmd.replace(/^gh\\s+/, '') };
  if (/^ls(\\s|$)/.test(cmd) || /^dir(\\s|$)/.test(cmd))
    return { tool: 'rtk_ls', path: cmd.replace(/^(ls|dir)\\s*/, '') || '.' };
  if (/^(grep|rg)\\s+/.test(cmd)) {
    const m = cmd.match(/(?:grep|rg)\\s+(?:-\\S+\\s+)*["']?([^"'\\s]+)["']?\\s*(.*)?/);
    return { tool: 'rtk_grep', pattern: m?.[1] ?? '', path: m?.[2] ?? '.' };
  }
  if (/^(find|fd)\\s+/.test(cmd)) {
    const m = cmd.match(/(?:find|fd)\\s+(.+)/);
    return { tool: 'rtk_find', pattern: m?.[1] ?? '' };
  }
  if (/^cat\\s+.*\\.json/.test(cmd)) {
    const m = cmd.match(/cat\\s+(.+)/);
    return { tool: 'rtk_json', path: m?.[1] ?? '' };
  }
  return null;
}
`;

    fs.writeFileSync(hookPath, HOOK_SCRIPT, "utf8");

    const settingsSnippet = JSON.stringify({
      hooks: {
        PreToolUse: [{
          matcher: "Bash",
          hooks: [{ type: "command", command: "node ~/.rtk-mcp/hook.cjs" }],
        }],
      },
    }, null, 2);

    return {
      content: [{
        type: "text",
        text: [
          `Hook installed at: ${hookPath}`,
          "",
          "Add this to ~/.claude/settings.json:",
          settingsSnippet,
          "",
          "Then restart Claude Code. Bash commands will auto-route to rtk tools.",
          "Run rtk_init --uninstall to remove.",
        ].join("\n"),
      }],
    };
  }
);

// ─── Start Server ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("rtk-mcp-server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
