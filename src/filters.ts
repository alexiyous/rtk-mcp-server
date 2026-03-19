/**
 * Output filters that compress CLI output to save tokens.
 * Core filter logic ported from RTK (github.com/rtk-ai/rtk) — Rust → TypeScript.
 */

// ─── Helpers ─────────────────────────────────────────────────────────────────

function truncateLine(line: string, width: number): string {
  if (line.length <= width) return line;
  return line.slice(0, width - 3) + "...";
}

// ─── Git Status (ported from rtk: git.rs → format_status_output) ─────────────

const STATUS_MAX_FILES = 10;
const STATUS_MAX_UNTRACKED = 5;

export function filterGitStatus(raw: string): string {
  const lines = raw.split("\n");
  // Detect porcelain v1 format: lines starting with "##" or "XY "
  const isPorcelain = lines.some((l) => l.startsWith("##") || /^[ MADRCU?!]{2} /.test(l));
  if (isPorcelain) return formatStatusPorcelain(lines);
  return filterStatusVerbose(raw);
}

function formatStatusPorcelain(lines: string[]): string {
  let output = "";
  const staged: string[] = [];
  const modified: string[] = [];
  const untracked: string[] = [];
  let conflicts = 0;

  for (const line of lines) {
    if (!line.trim()) continue;

    if (line.startsWith("##")) {
      output += `* ${line.slice(3).trim()}\n`;
      continue;
    }

    if (line.length < 3) continue;
    const x = line[0];
    const y = line[1];
    const file = line.slice(3);

    if (x === "?" && y === "?") {
      untracked.push(file);
    } else {
      if (x !== " " && "MADRC".includes(x)) staged.push(file);
      if (x === "U") conflicts++;
      if (y !== " " && "MD".includes(y)) modified.push(file);
    }
  }

  if (staged.length > 0) {
    output += `+ Staged: ${staged.length} files\n`;
    for (const f of staged.slice(0, STATUS_MAX_FILES)) output += `   ${f}\n`;
    if (staged.length > STATUS_MAX_FILES)
      output += `   ... +${staged.length - STATUS_MAX_FILES} more\n`;
  }

  if (modified.length > 0) {
    output += `~ Modified: ${modified.length} files\n`;
    for (const f of modified.slice(0, STATUS_MAX_FILES)) output += `   ${f}\n`;
    if (modified.length > STATUS_MAX_FILES)
      output += `   ... +${modified.length - STATUS_MAX_FILES} more\n`;
  }

  if (untracked.length > 0) {
    output += `? Untracked: ${untracked.length} files\n`;
    for (const f of untracked.slice(0, STATUS_MAX_UNTRACKED)) output += `   ${f}\n`;
    if (untracked.length > STATUS_MAX_UNTRACKED)
      output += `   ... +${untracked.length - STATUS_MAX_UNTRACKED} more\n`;
  }

  if (conflicts > 0) output += `conflicts: ${conflicts} files\n`;

  if (staged.length === 0 && modified.length === 0 && untracked.length === 0 && conflicts === 0) {
    output += "clean — nothing to commit\n";
  }

  return output.trimEnd();
}

// Ported from rtk: git.rs → filter_status_with_args
// Strips git hint lines from verbose status output
function filterStatusVerbose(raw: string): string {
  const result: string[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (
      trimmed.startsWith('(use "git') ||
      trimmed.startsWith("(create/copy files") ||
      trimmed.includes('use "git add') ||
      trimmed.includes('use "git restore')
    )
      continue;
    if (trimmed.includes("nothing to commit") && trimmed.includes("working tree clean")) {
      result.push(trimmed);
      break;
    }
    result.push(line);
  }
  return result.length === 0 ? "ok" : result.join("\n");
}

// ─── Git Log (ported from rtk: git.rs → filter_log_output) ──────────────────

export function filterGitLog(raw: string): string {
  const TRUNCATE_WIDTH = 80;

  // RTK format: commits separated by ---END--- marker
  if (raw.includes("---END---")) {
    const commits = raw.split("---END---");
    const result: string[] = [];

    for (const block of commits) {
      const trimmed = block.trim();
      if (!trimmed) continue;

      const lines = trimmed.split("\n");
      const header = truncateLine(lines[0].trim(), TRUNCATE_WIDTH);

      const bodyLine = lines
        .slice(1)
        .map((l) => l.trim())
        .find(
          (l) =>
            l.length > 0 &&
            !l.startsWith("Signed-off-by:") &&
            !l.startsWith("Co-authored-by:")
        );

      if (bodyLine) {
        result.push(`${header}\n  ${truncateLine(bodyLine, TRUNCATE_WIDTH)}`);
      } else {
        result.push(header);
      }
    }

    return result.join("\n").trim();
  }

  // Fallback: parse standard verbose git log
  const lines = raw.split("\n");
  const commits: string[] = [];

  for (const line of lines) {
    const commitMatch = line.match(/^commit\s+([a-f0-9]+)/);
    if (commitMatch) {
      commits.push(commitMatch[1].substring(0, 7));
      continue;
    }
    const oneLineMatch = line.match(/^([a-f0-9]{7,})\s+(.+)/);
    if (oneLineMatch) {
      commits.push(
        truncateLine(`${oneLineMatch[1].substring(0, 7)} ${oneLineMatch[2]}`, TRUNCATE_WIDTH)
      );
      continue;
    }
    if (line.startsWith("    ") && line.trim() && commits.length > 0) {
      const last = commits[commits.length - 1];
      if (!last.includes(" ")) {
        commits[commits.length - 1] = truncateLine(`${last} ${line.trim()}`, TRUNCATE_WIDTH);
      }
    }
  }

  return commits.length ? commits.join("\n") : raw.trim();
}

// ─── Git Diff (ported from rtk: git.rs → compact_diff) ──────────────────────

export function filterGitDiff(raw: string): string {
  const MAX_LINES = 200;
  const MAX_HUNK_LINES = 30;

  const result: string[] = [];
  let currentFile = "";
  let added = 0;
  let removed = 0;
  let inHunk = false;
  let hunkLines = 0;
  let wasTruncated = false;

  for (const line of raw.split("\n")) {
    if (line.startsWith("diff --git")) {
      if (currentFile && (added > 0 || removed > 0)) {
        result.push(`  +${added} -${removed}`);
      }
      currentFile = line.split(" b/")[1] ?? "unknown";
      result.push(`\n${currentFile}`);
      added = 0;
      removed = 0;
      inHunk = false;
      hunkLines = 0;
    } else if (line.startsWith("@@")) {
      inHunk = true;
      hunkLines = 0;
      const hunkInfo = line.split("@@")[1]?.trim() ?? "";
      result.push(`  @@ ${hunkInfo} @@`);
    } else if (inHunk) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        added++;
        if (hunkLines < MAX_HUNK_LINES) {
          result.push(`  ${line}`);
          hunkLines++;
        }
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        removed++;
        if (hunkLines < MAX_HUNK_LINES) {
          result.push(`  ${line}`);
          hunkLines++;
        }
      } else if (!line.startsWith("\\")) {
        // Context lines: show only after first line of hunk
        if (hunkLines > 0 && hunkLines < MAX_HUNK_LINES) {
          result.push(`  ${line}`);
          hunkLines++;
        }
      }

      if (hunkLines === MAX_HUNK_LINES) {
        result.push("  ... (truncated)");
        hunkLines++;
        wasTruncated = true;
      }
    }

    if (result.length >= MAX_LINES) {
      result.push("\n... (more changes truncated)");
      wasTruncated = true;
      break;
    }
  }

  if (currentFile && (added > 0 || removed > 0)) {
    result.push(`  +${added} -${removed}`);
  }

  if (wasTruncated) {
    result.push("[full diff available — use git diff directly]");
  }

  return result.join("\n");
}

// ─── Git Simple (ported from rtk: git.rs → run_push / run_pull / run_commit / run_add) ──

export function filterGitSimple(raw: string, cmd: string): string {
  if (cmd.includes("push")) {
    if (raw.includes("Everything up-to-date") || raw.includes("up-to-date")) {
      return "ok (up-to-date)";
    }
    for (const line of raw.split("\n")) {
      if (line.includes("->")) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 3) return `ok ${parts[parts.length - 1]}`;
      }
    }
    return "ok";
  }

  if (cmd.includes("pull")) {
    if (raw.includes("Already up to date") || raw.includes("Already up-to-date")) {
      return "ok (up-to-date)";
    }
    let files = 0,
      insertions = 0,
      deletions = 0;
    for (const line of raw.split("\n")) {
      if (line.includes("file") && line.includes("changed")) {
        for (const part of line.split(",")) {
          const p = part.trim();
          const n = parseInt(p) || 0;
          if (p.includes("file")) files = n;
          else if (p.includes("insertion")) insertions = n;
          else if (p.includes("deletion")) deletions = n;
        }
      }
    }
    return files > 0 ? `ok ${files} files +${insertions} -${deletions}` : "ok";
  }

  if (cmd.includes("commit")) {
    if (raw.includes("nothing to commit")) return "ok (nothing to commit)";
    const firstLine = raw.split("\n").find((l) => l.trim());
    if (firstLine) {
      const match = firstLine.match(/\[[\w/.\-]+\s+([a-f0-9]+)\]/);
      if (match) return `ok ${match[1].slice(0, 7)}`;
    }
    return "ok";
  }

  if (cmd.includes("add")) {
    // shortstat may be appended by the tool handler
    const shortstat = raw.split("\n").find((l) => l.includes("changed"));
    if (shortstat) return `ok ${shortstat.trim()}`;
    if (!raw.trim()) return "ok (nothing to add)";
    return "ok";
  }

  return raw.trim().split("\n").slice(0, 5).join("\n");
}

// ─── Grep (ported from rtk: grep_cmd.rs) ─────────────────────────────────────

const GREP_MAX_LINE_LEN = 120;
const GREP_MAX_PER_FILE = 5;
const GREP_MAX_RESULTS = 50;

// Ported from rtk: grep_cmd.rs → clean_line
function cleanLine(line: string, maxLen: number, pattern?: string): string {
  const trimmed = line.trim();
  if (trimmed.length <= maxLen) return trimmed;

  if (pattern) {
    const lower = trimmed.toLowerCase();
    const patLower = pattern.toLowerCase();
    const pos = lower.indexOf(patLower);
    if (pos >= 0) {
      const start = Math.max(0, pos - Math.floor(maxLen / 3));
      const end = Math.min(trimmed.length, start + maxLen);
      const adjustedStart = end === trimmed.length ? Math.max(0, end - maxLen) : start;
      const slice = trimmed.slice(adjustedStart, end);
      if (adjustedStart > 0 && end < trimmed.length) return `...${slice}...`;
      if (adjustedStart > 0) return `...${slice}`;
      return `${slice}...`;
    }
  }

  return trimmed.slice(0, maxLen - 3) + "...";
}

// Ported from rtk: grep_cmd.rs → compact_path
function compactPath(path: string): string {
  if (path.length <= 50) return path;
  const parts = path.split("/");
  if (parts.length <= 3) return path;
  return `${parts[0]}/.../` + parts.slice(-2).join("/");
}

export function filterGrep(raw: string, pattern?: string): string {
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return "(no matches)";

  const byFile = new Map<string, Array<[number, string]>>();
  let total = 0;

  for (const line of lines) {
    // Parse file:linenum:content (rg --no-heading -n format)
    const firstColon = line.indexOf(":");
    if (firstColon < 0) continue;

    const rest = line.slice(firstColon + 1);
    const secondColon = rest.indexOf(":");
    let file: string, lineNum: number, content: string;

    if (secondColon >= 0 && /^\d+$/.test(rest.slice(0, secondColon))) {
      file = line.slice(0, firstColon);
      lineNum = parseInt(rest.slice(0, secondColon));
      content = rest.slice(secondColon + 1);
    } else {
      file = line.slice(0, firstColon);
      lineNum = 0;
      content = rest;
    }

    total++;
    const cleaned = cleanLine(content, GREP_MAX_LINE_LEN, pattern);
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file)!.push([lineNum, cleaned]);
  }

  if (byFile.size === 0) return lines.slice(0, 20).join("\n");

  let output = `${total} matches in ${byFile.size}F:\n\n`;
  let shown = 0;

  const sortedFiles = [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  for (const [file, matches] of sortedFiles) {
    if (shown >= GREP_MAX_RESULTS) break;
    const fileDisplay = compactPath(file);
    output += `[file] ${fileDisplay} (${matches.length}):\n`;

    for (const [lineNum, content] of matches.slice(0, GREP_MAX_PER_FILE)) {
      const ln = lineNum > 0 ? String(lineNum).padStart(4) : "   ?";
      output += `  ${ln}: ${content}\n`;
      shown++;
      if (shown >= GREP_MAX_RESULTS) break;
    }

    if (matches.length > GREP_MAX_PER_FILE) {
      output += `  +${matches.length - GREP_MAX_PER_FILE}\n`;
    }
    output += "\n";
  }

  if (total > shown) output += `... +${total - shown}\n`;

  return output.trimEnd();
}

// ─── Directory Listing (ported from rtk: ls.rs → compact_ls) ─────────────────

// Ported from rtk: ls.rs → NOISE_DIRS
const NOISE_DIRS = new Set([
  "node_modules", ".git", "target", "__pycache__", ".next", "dist", "build",
  ".cache", ".turbo", ".vercel", ".pytest_cache", ".mypy_cache", ".tox",
  ".venv", "venv", "coverage", ".nyc_output", ".DS_Store", "Thumbs.db",
  ".idea", ".vscode", ".vs", ".eggs",
]);

// Ported from rtk: ls.rs → human_size
function humanSize(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)}M`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${bytes}B`;
}

// Ported from rtk: ls.rs → compact_ls (Unix ls -la format)
function compactLsUnix(raw: string, showAll: boolean): string {
  const dirs: string[] = [];
  const files: Array<[string, string]> = [];
  const byExt = new Map<string, number>();

  for (const line of raw.split("\n")) {
    if (line.startsWith("total ") || !line.trim()) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 9) continue;

    const name = parts.slice(8).join(" ");
    if (name === "." || name === "..") continue;
    if (!showAll && NOISE_DIRS.has(name)) continue;

    if (line.startsWith("d")) {
      dirs.push(name);
    } else if (line.startsWith("-") || line.startsWith("l")) {
      const size = parseInt(parts[4]) || 0;
      const dotIdx = name.lastIndexOf(".");
      const ext = dotIdx >= 0 ? name.slice(dotIdx) : "no ext";
      byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
      files.push([name, humanSize(size)]);
    }
  }

  if (dirs.length === 0 && files.length === 0) return "(empty)";

  let out = "";
  for (const d of dirs) out += `${d}/\n`;
  for (const [name, size] of files) out += `${name} ${size}\n`;

  let summary = `${files.length} files, ${dirs.length} dirs`;
  if (byExt.size > 0) {
    const extCounts = [...byExt.entries()].sort((a, b) => b[1] - a[1]);
    const extParts = extCounts.slice(0, 5).map(([ext, count]) => `${count} ${ext}`);
    summary += ` (${extParts.join(", ")}`;
    if (extCounts.length > 5) summary += `, +${extCounts.length - 5} more`;
    summary += ")";
  }
  out += `\n${summary}`;
  return out;
}

// Windows dir output parser (same logic, different input format)
function compactLsWindows(raw: string, showAll: boolean): string {
  const dirs: string[] = [];
  const files: Array<[string, string]> = [];
  const byExt = new Map<string, number>();

  for (const line of raw.split("\n")) {
    const dirMatch = line.match(/<DIR>\s+(.+)$/);
    const fileMatch = line.match(/\s+([\d,]+)\s+([^\s].+)$/) ;

    if (dirMatch) {
      const name = dirMatch[1].trim();
      if (name === "." || name === "..") continue;
      if (!showAll && NOISE_DIRS.has(name)) continue;
      dirs.push(name);
    } else if (fileMatch && !/^(Volume|Directory|File\(s\)|Dir\(s\))/.test(line.trim()) && !line.includes("File(s)") && !line.includes("Dir(s)")) {
      const sizeStr = fileMatch[1].replace(/,/g, "");
      const name = fileMatch[2].trim();
      if (!name) continue;
      const size = parseInt(sizeStr) || 0;
      const dotIdx = name.lastIndexOf(".");
      const ext = dotIdx >= 0 ? name.slice(dotIdx) : "no ext";
      byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
      files.push([name, humanSize(size)]);
    }
  }

  if (dirs.length === 0 && files.length === 0) return "(empty)";

  let out = "";
  for (const d of dirs) out += `${d}/\n`;
  for (const [name, size] of files) out += `${name} ${size}\n`;

  let summary = `${files.length} files, ${dirs.length} dirs`;
  if (byExt.size > 0) {
    const extCounts = [...byExt.entries()].sort((a, b) => b[1] - a[1]);
    const extParts = extCounts.slice(0, 5).map(([ext, count]) => `${count} ${ext}`);
    summary += ` (${extParts.join(", ")}`;
    if (extCounts.length > 5) summary += `, +${extCounts.length - 5} more`;
    summary += ")";
  }
  out += `\n${summary}`;
  return out;
}

export function filterLs(raw: string, showAll = false): string {
  if (raw.includes("<DIR>") || raw.includes("Volume in drive")) {
    return compactLsWindows(raw, showAll);
  }
  return compactLsUnix(raw, showAll);
}

// ─── Find Filter ─────────────────────────────────────────────────────────────

export function filterFind(raw: string): string {
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return "(no results)";
  if (lines.length <= 30) return lines.join("\n");

  const dirs: Map<string, string[]> = new Map();
  for (const line of lines) {
    const dir = line.substring(0, line.lastIndexOf("/")) || ".";
    const file = line.substring(line.lastIndexOf("/") + 1);
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir)!.push(file);
  }

  const result: string[] = [`${lines.length} files found`];
  for (const [dir, files] of dirs) {
    if (files.length <= 5) {
      result.push(`${dir}/ (${files.length}): ${files.join(", ")}`);
    } else {
      result.push(`${dir}/ (${files.length}): ${files.slice(0, 3).join(", ")} ... +${files.length - 3} more`);
    }
  }
  return result.join("\n");
}

// ─── Build / Lint Filters ────────────────────────────────────────────────────

export function filterBuildOutput(raw: string): string {
  const lines = raw.split("\n");
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/error(\[|:|\s)/i.test(trimmed) && !trimmed.startsWith("0 error")) {
      errors.push(trimmed);
    } else if (/warning(\[|:|\s)/i.test(trimmed) && !trimmed.startsWith("0 warning")) {
      warnings.push(trimmed);
    }
  }

  if (errors.length === 0 && warnings.length === 0) {
    return "build ok";
  }

  const result: string[] = [];
  if (errors.length) {
    result.push(`${errors.length} error(s):`);
    result.push(...[...new Set(errors)].slice(0, 30));
  }
  if (warnings.length) {
    result.push(`${warnings.length} warning(s):`);
    result.push(...[...new Set(warnings)].slice(0, 10));
  }
  return result.join("\n");
}

// ─── Docker Filters ──────────────────────────────────────────────────────────

export function filterDockerPs(raw: string): string {
  if (/not recognized|not found|command not found/i.test(raw)) return compressGeneric(raw);
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length <= 1) return "(no containers)";

  const result: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(/\s{2,}/);
    if (parts.length >= 5) {
      result.push(`${parts[0]?.substring(0, 12)} ${parts[1]} [${parts[4] || parts[3]}] ${parts[parts.length - 1]}`);
    } else {
      result.push(lines[i].trim());
    }
  }
  return `${result.length} container(s)\n${result.join("\n")}`;
}

// ─── Log Analysis (ported from rtk: log_cmd.rs → analyze_logs) ───────────────

// Ported from rtk: log_cmd.rs — 5 normalization patterns
const TIMESTAMP_RE = /^\d{4}[-/]\d{2}[-/]\d{2}[T ]\d{2}:\d{2}:\d{2}[.,]?\d*\s*/;
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;
const HEX_RE = /0x[0-9a-fA-F]+/g;
const NUM_RE = /\b\d{4,}\b/g;
const LOG_PATH_RE = /\/[\w./\-]+/g;

function normalizeLogLine(line: string): string {
  return line
    .replace(TIMESTAMP_RE, "")
    .replace(UUID_RE, "<UUID>")
    .replace(HEX_RE, "<HEX>")
    .replace(NUM_RE, "<NUM>")
    .replace(LOG_PATH_RE, "<PATH>")
    .trim();
}

export function filterLogs(raw: string): string {
  const errorCounts = new Map<string, number>();
  const warnCounts = new Map<string, number>();
  let infoCount = 0;
  const uniqueErrors: string[] = [];
  const uniqueWarnings: string[] = [];

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const lower = line.toLowerCase();
    const normalized = normalizeLogLine(line);

    if (lower.includes("error") || lower.includes("fatal") || lower.includes("panic")) {
      const count = errorCounts.get(normalized) ?? 0;
      if (count === 0) uniqueErrors.push(line);
      errorCounts.set(normalized, count + 1);
    } else if (lower.includes("warn")) {
      const count = warnCounts.get(normalized) ?? 0;
      if (count === 0) uniqueWarnings.push(line);
      warnCounts.set(normalized, count + 1);
    } else if (lower.includes("info")) {
      infoCount++;
    }
  }

  const totalErrors = [...errorCounts.values()].reduce((a, b) => a + b, 0);
  const totalWarnings = [...warnCounts.values()].reduce((a, b) => a + b, 0);

  const result: string[] = [
    "Log Summary",
    `  [error] ${totalErrors} errors (${errorCounts.size} unique)`,
    `  [warn] ${totalWarnings} warnings (${warnCounts.size} unique)`,
    `  [info] ${infoCount} info messages`,
    "",
  ];

  if (uniqueErrors.length > 0) {
    result.push("[ERRORS]");
    const sorted = [...errorCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [normalized, count] of sorted.slice(0, 10)) {
      const original = uniqueErrors.find((e) => normalizeLogLine(e) === normalized) ?? normalized;
      const truncated = original.length > 100 ? original.slice(0, 97) + "..." : original;
      result.push(count > 1 ? `  [x${count}] ${truncated}` : `  ${truncated}`);
    }
    if (sorted.length > 10) result.push(`  ... +${sorted.length - 10} more unique errors`);
    result.push("");
  }

  if (uniqueWarnings.length > 0) {
    result.push("[WARNINGS]");
    const sorted = [...warnCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [normalized, count] of sorted.slice(0, 5)) {
      const original =
        uniqueWarnings.find((w) => normalizeLogLine(w) === normalized) ?? normalized;
      const truncated = original.length > 100 ? original.slice(0, 97) + "..." : original;
      result.push(count > 1 ? `  [x${count}] ${truncated}` : `  ${truncated}`);
    }
    if (sorted.length > 5) result.push(`  ... +${sorted.length - 5} more unique warnings`);
  }

  return result.join("\n");
}

// ─── JSON Structure Filter ───────────────────────────────────────────────────

export function filterJson(raw: string): string {
  try {
    const obj = JSON.parse(raw);
    return describeJsonStructure(obj, 0, 3);
  } catch {
    return compressGeneric(raw);
  }
}

function describeJsonStructure(obj: unknown, depth: number, maxDepth: number): string {
  const indent = "  ".repeat(depth);
  if (depth >= maxDepth) return `${indent}...`;
  if (obj === null) return `${indent}null`;
  if (typeof obj !== "object") return `${indent}${typeof obj}`;

  if (Array.isArray(obj)) {
    if (obj.length === 0) return `${indent}[]`;
    const sample = describeJsonStructure(obj[0], depth + 1, maxDepth);
    return `${indent}Array(${obj.length}) [\n${sample}\n${indent}]`;
  }

  const entries = Object.entries(obj as Record<string, unknown>);
  if (entries.length === 0) return `${indent}{}`;

  const lines = entries.map(([key, val]) => {
    if (typeof val === "string") return `${indent}  ${key}: string(${(val as string).length})`;
    if (typeof val === "number") return `${indent}  ${key}: ${val}`;
    if (typeof val === "boolean") return `${indent}  ${key}: ${val}`;
    if (val === null) return `${indent}  ${key}: null`;
    if (Array.isArray(val)) return `${indent}  ${key}: Array(${val.length})`;
    if (typeof val === "object")
      return `${indent}  ${key}: {\n${describeJsonStructure(val, depth + 2, maxDepth)}\n${indent}  }`;
    return `${indent}  ${key}: ${typeof val}`;
  });

  return lines.join("\n");
}

// ─── Gradle Filters ──────────────────────────────────────────────────────────

export function filterGradleBuild(raw: string): string {
  const lines = raw.split("\n");
  const errors: string[] = [];
  const warnings: string[] = [];
  let buildResult = "";
  let buildTime = "";
  const tasksSummary: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^BUILD (SUCCESSFUL|FAILED)/.test(trimmed)) buildResult = trimmed;
    if (/^Total time:/.test(trimmed) || /in\s+\d+[ms]/.test(trimmed)) buildTime = trimmed;
    if (/^e:|error:|FAILURE:|ERROR/i.test(trimmed) && !trimmed.startsWith("0 error"))
      errors.push(trimmed);
    if (/^w:|warning:/i.test(trimmed) && !trimmed.startsWith("0 warning"))
      warnings.push(trimmed);
    if (/^> Task .*(FAILED)/.test(trimmed)) tasksSummary.push(trimmed);
  }

  if (!buildResult && errors.length === 0 && warnings.length === 0) return compressGeneric(raw);

  const result: string[] = [];
  if (buildResult) result.push(buildResult);
  if (buildTime) result.push(buildTime);
  if (tasksSummary.length) {
    result.push(`Failed tasks(${tasksSummary.length}):`);
    result.push(...tasksSummary.slice(0, 10));
  }
  if (errors.length) {
    result.push(`${errors.length} error(s):`);
    result.push(...[...new Set(errors)].slice(0, 30));
  }
  if (warnings.length > 0 && warnings.length <= 10) {
    result.push(`${warnings.length} warning(s):`);
    result.push(...[...new Set(warnings)]);
  } else if (warnings.length > 10) {
    result.push(`${warnings.length} warning(s) (showing first 5):`);
    result.push(...[...new Set(warnings)].slice(0, 5));
  }

  return result.length ? result.join("\n") : "build ok";
}

export function filterGradleTasks(raw: string): string {
  const lines = raw.split("\n").filter((l) => l.trim());
  const tasks = lines.filter(
    (l) => /^\w/.test(l) && l.includes(" - ") && !l.startsWith("---") && !l.startsWith("===")
  );
  if (tasks.length === 0) return compressGeneric(raw);

  const groups: Map<string, string[]> = new Map();
  let currentGroup = "other";
  for (const line of lines) {
    if (line.endsWith(" tasks") && !line.startsWith(" ")) {
      currentGroup = line.replace(" tasks", "").trim();
    }
    if (/^\w/.test(line) && line.includes(" - ")) {
      if (!groups.has(currentGroup)) groups.set(currentGroup, []);
      groups.get(currentGroup)!.push(line.trim());
    }
  }

  const result: string[] = [`${tasks.length} tasks available`];
  for (const [group, items] of groups) {
    result.push(`${group} (${items.length}):`);
    result.push(...items.slice(0, 8).map((t) => `  ${t}`));
    if (items.length > 8) result.push(`  ... +${items.length - 8} more`);
  }
  return result.join("\n");
}

// ─── ADB / Logcat Filters ────────────────────────────────────────────────────

export function filterLogcat(raw: string): string {
  const lines = raw.split("\n");
  if (lines.length <= 20) return raw.trim();

  const errors: string[] = [];
  const warnings: string[] = [];
  const fatals: string[] = [];
  let totalLines = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    totalLines++;
    if (/\bF\/|FATAL/i.test(line)) fatals.push(line.trim());
    else if (/\bE\/|ERROR/i.test(line)) errors.push(line.trim());
    else if (/\bW\/|WARN/i.test(line)) warnings.push(line.trim());
    if (/AndroidRuntime|FATAL EXCEPTION|ANR in|Process:.*died/i.test(line))
      fatals.push(line.trim());
  }

  const result: string[] = [`logcat: ${totalLines} lines`];
  if (fatals.length) {
    result.push(`FATAL (${fatals.length}):`);
    result.push(...[...new Set(fatals)].slice(0, 20));
  }
  if (errors.length) {
    result.push(`ERRORS (${errors.length}):`);
    result.push(...[...new Set(errors)].slice(0, 20));
  }
  if (warnings.length) {
    result.push(`WARNINGS (${warnings.length}):`);
    result.push(...[...new Set(warnings)].slice(0, 10));
  }
  if (fatals.length === 0 && errors.length === 0 && warnings.length === 0) {
    result.push("(no errors/warnings found)");
    result.push("recent:");
    result.push(...lines.filter((l) => l.trim()).slice(-10));
  }
  return result.join("\n");
}

export function filterAdbDevices(raw: string): string {
  const lines = raw.split("\n").filter((l) => l.trim() && !l.startsWith("List of"));
  if (lines.length === 0) return "(no devices)";
  const devices = lines.map((l) => {
    const parts = l.split("\t");
    return parts.length >= 2 ? `${parts[0]} [${parts[1].trim()}]` : l.trim();
  });
  return `${devices.length} device(s): ${devices.join(", ")}`;
}

export function filterAdbInstall(raw: string): string {
  if (/Success/.test(raw)) return "ok installed";
  const failMatch = raw.match(/Failure \[(.+)\]/);
  if (failMatch) return `FAILED: ${failMatch[1]}`;
  return raw.trim().split("\n").slice(-3).join("\n");
}

// ─── Generic Compression ─────────────────────────────────────────────────────

export function compressGeneric(raw: string): string {
  const lines = raw.split("\n");
  if (lines.length <= 40) return raw.trim();

  const nonEmpty = lines.filter((l) => l.trim());
  const unique = [...new Set(nonEmpty)];
  if (unique.length <= 40) return unique.join("\n");

  const result = [
    ...unique.slice(0, 20),
    `\n... (${unique.length - 30} lines omitted) ...\n`,
    ...unique.slice(-10),
  ];
  return result.join("\n");
}

// ─── Smart Command Router ────────────────────────────────────────────────────

export function detectAndFilter(command: string, output: string): { filtered: string; strategy: string } {
  const cmd = command.toLowerCase().trim();

  if (/^git\s+status/.test(cmd)) return { filtered: filterGitStatus(output), strategy: "git-status" };
  if (/^git\s+log/.test(cmd)) return { filtered: filterGitLog(output), strategy: "git-log" };
  if (/^git\s+diff/.test(cmd)) return { filtered: filterGitDiff(output), strategy: "git-diff" };
  if (/^git\s+(push|pull|add|commit)/.test(cmd)) return { filtered: filterGitSimple(output, cmd), strategy: "git-simple" };

  if (/gradlew?\s+.*tasks/.test(cmd)) return { filtered: filterGradleTasks(output), strategy: "gradle-tasks" };
  if (/gradlew?\s/.test(cmd)) return { filtered: filterGradleBuild(output), strategy: "gradle" };

  if (/^adb\s+logcat/.test(cmd)) return { filtered: filterLogcat(output), strategy: "logcat" };
  if (/^adb\s+devices/.test(cmd)) return { filtered: filterAdbDevices(output), strategy: "adb-devices" };
  if (/^adb\s+install/.test(cmd)) return { filtered: filterAdbInstall(output), strategy: "adb-install" };

  if (/\b(test|pytest|jest|vitest|mocha|cargo\s+test|go\s+test|rspec|connectedAndroidTest|testDebug|testRelease)\b/.test(cmd))
    return { filtered: filterTestOutput(output), strategy: "test" };

  if (/\b(build|compile|tsc|eslint|biome|clippy|ruff|golangci-lint|prettier|assembleDebug|assembleRelease|lintDebug|lintRelease)\b/.test(cmd))
    return { filtered: filterBuildOutput(output), strategy: "build" };

  if (/^ls\b/.test(cmd) || /^dir\b/.test(cmd))
    return { filtered: filterLs(output), strategy: "ls" };

  if (/^find\b/.test(cmd) || /^fd\b/.test(cmd))
    return { filtered: filterFind(output), strategy: "find" };

  if (/^(grep|rg|ag)\b/.test(cmd)) {
    // Try to extract search pattern from command for context-aware line truncation
    const patternMatch = cmd.match(/(?:grep|rg|ag)\s+(?:-\S+\s+)*["']?([^"'\s]+)["']?/);
    return { filtered: filterGrep(output, patternMatch?.[1]), strategy: "grep" };
  }

  if (/^docker\s+(ps|images)/.test(cmd))
    return { filtered: filterDockerPs(output), strategy: "docker" };

  if (/^(docker\s+logs|kubectl\s+logs|cat\s+.*\.log|tail\s)/.test(cmd))
    return { filtered: filterLogs(output), strategy: "logs" };

  if (/\bjson\b/.test(cmd) || /^cat\s+.*\.json/.test(cmd)) {
    try {
      JSON.parse(output);
      return { filtered: filterJson(output), strategy: "json" };
    } catch { /* not json, fall through */ }
  }

  if (output.split("\n").length > 40)
    return { filtered: compressGeneric(output), strategy: "generic" };

  return { filtered: output.trim(), strategy: "passthrough" };
}

// ─── Cargo (Rust) Filter ─────────────────────────────────────────────────────

export function filterCargo(raw: string): string {
  const lines = raw.split("\n");
  const failures: string[] = [];
  let passed = 0, failed = 0;
  let summary = "";

  for (const line of lines) {
    const resultMatch = line.match(/test result:\s+(\w+)\.\s+(\d+) passed;\s+(\d+) failed/);
    if (resultMatch) {
      passed = parseInt(resultMatch[2]);
      failed = parseInt(resultMatch[3]);
      summary = line.trim();
    }
    if (/^test .+ \.\.\. FAILED/.test(line.trim())) failures.push(line.trim());
    if (/^FAILED/.test(line.trim()) || /^thread '.+' panicked/.test(line.trim())) failures.push(line.trim());
  }

  if (/not recognized|not found|command not found/i.test(raw)) return compressGeneric(raw);
  if (summary && failed === 0) return `PASSED: ${passed} tests`;
  if (failed > 0) {
    const out = [`FAILED: ${failed}/${passed + failed} tests`];
    out.push(...[...new Set(failures)].slice(0, 20));
    return out.join("\n");
  }
  // clippy/build output
  return filterBuildOutput(raw);
}

// ─── Pytest Filter ────────────────────────────────────────────────────────────

export function filterPytest(raw: string): string {
  const lines = raw.split("\n");
  const failures: string[] = [];
  let passed = 0, failed = 0;
  let inFailureBlock = false;
  let summary = "";

  for (const line of lines) {
    const summaryMatch = line.match(/(\d+) passed(?:.*?(\d+) failed)?/);
    if (summaryMatch && line.includes("=====")) {
      passed = parseInt(summaryMatch[1]);
      failed = summaryMatch[2] ? parseInt(summaryMatch[2]) : 0;
      summary = line.trim();
    }
    if (/^FAILED /.test(line)) failures.push(line.trim());
    if (/^_{5,} /.test(line)) inFailureBlock = true;
    if (/^={5,}/.test(line)) inFailureBlock = false;
    if (inFailureBlock && /AssertionError|assert |E\s+/.test(line)) {
      failures.push(line.trim().slice(0, 120));
    }
  }

  if (summary && failed === 0) return `PASSED: ${passed} tests`;
  if (failed > 0) {
    const out = [`FAILED: ${failed}/${passed + failed} tests`];
    out.push(...[...new Set(failures)].slice(0, 20));
    return out.join("\n");
  }
  return compressGeneric(raw);
}

// ─── Go Test Filter ───────────────────────────────────────────────────────────

export function filterGoTest(raw: string): string {
  // Go test outputs NDJSON with --json flag, or plain text
  const failures: string[] = [];
  let passed = 0, failed = 0;

  if (raw.includes('"Action"')) {
    // NDJSON format (go test -json)
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as { Action?: string; Test?: string; Output?: string };
        if (obj.Action === "fail" && obj.Test) failures.push(`FAIL ${obj.Test}`);
        if (obj.Action === "pass" && obj.Test) passed++;
        if (obj.Action === "fail" && !obj.Test) failed++;
      } catch { /* skip */ }
    }
  } else {
    // Plain text format
    for (const line of raw.split("\n")) {
      if (/^--- FAIL:/.test(line)) { failures.push(line.trim()); failed++; }
      if (/^--- PASS:/.test(line)) passed++;
      if (/^FAIL\s/.test(line)) failed++;
      if (/^ok\s/.test(line)) passed++;
    }
  }

  if (failed === 0 && failures.length === 0) return `PASSED: ${passed} tests`;
  const out = [`FAILED: ${failed || failures.length} tests`];
  out.push(...[...new Set(failures)].slice(0, 20));
  return out.join("\n");
}

// ─── Vitest Filter ────────────────────────────────────────────────────────────

export function filterVitest(raw: string): string {
  const lines = raw.split("\n");
  const failures: string[] = [];
  let passed = 0, failed = 0;

  for (const line of lines) {
    const summaryMatch = line.match(/Tests\s+(\d+) failed.*?(\d+) passed/);
    if (summaryMatch) { failed = parseInt(summaryMatch[1]); passed = parseInt(summaryMatch[2]); }
    if (/✓|PASS/.test(line)) passed++;
    if (/×|✗|FAIL/.test(line)) { failed++; failures.push(line.trim()); }
    if (/AssertionError|Expected|Received/.test(line)) failures.push(line.trim().slice(0, 120));
  }

  if (/not recognized|not found|command not found/i.test(raw)) return compressGeneric(raw);
  if (/No test files found|no tests found/i.test(raw)) return "no test files found";
  if (failed === 0) return `PASSED: ${passed} tests`;
  const out = [`FAILED: ${failed}/${passed + failed} tests`];
  out.push(...[...new Set(failures)].slice(0, 20));
  return out.join("\n");
}

// ─── Playwright Filter ────────────────────────────────────────────────────────

export function filterPlaywright(raw: string): string {
  if (/not recognized|not found|command not found/i.test(raw)) return compressGeneric(raw);
  const lines = raw.split("\n");
  const failures: string[] = [];
  let passed = 0, failed = 0;

  for (const line of lines) {
    const resultMatch = line.match(/(\d+) passed.*?(\d+) failed/);
    if (resultMatch) { passed = parseInt(resultMatch[1]); failed = parseInt(resultMatch[2]); }
    if (/✓|passed/.test(line) && /ms|s\)/.test(line)) passed++;
    if (/✗|failed|FAILED/.test(line)) { failed++; failures.push(line.trim()); }
    if (/expect|Error:/.test(line) && failures.length > 0) failures.push("  " + line.trim().slice(0, 100));
  }

  if (failed === 0) return `PASSED: ${passed} tests`;
  const out = [`FAILED: ${failed}/${passed + failed} tests`];
  out.push(...[...new Set(failures)].slice(0, 20));
  return out.join("\n");
}

// ─── TSC Filter ───────────────────────────────────────────────────────────────

export function filterTsc(raw: string): string {
  // Group "file(line,col): error TSxxxx: message" by file
  const byFile = new Map<string, string[]>();
  let totalErrors = 0;

  for (const line of raw.split("\n")) {
    const match = line.match(/^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+: .+)/);
    if (match) {
      const [, file, row, col, level, msg] = match;
      const key = file.trim();
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key)!.push(`  ${level === "error" ? "E" : "W"} ${row}:${col} ${msg}`);
      if (level === "error") totalErrors++;
    }
  }

  if (byFile.size === 0) {
    if (raw.includes("error TS")) return compressGeneric(raw);
    if (/not recognized|not found|command not found/i.test(raw)) return compressGeneric(raw);
    return "tsc ok";
  }

  const out = [`${totalErrors} TypeScript error(s) in ${byFile.size} file(s):`];
  for (const [file, msgs] of byFile) {
    out.push(file);
    out.push(...msgs.slice(0, 10));
    if (msgs.length > 10) out.push(`  ... +${msgs.length - 10} more`);
  }
  return out.join("\n");
}

// ─── ESLint / Biome Filter ────────────────────────────────────────────────────

export function filterLint(raw: string): string {
  // Group by rule/message
  const byRule = new Map<string, string[]>();
  let totalProblems = 0;

  for (const line of raw.split("\n")) {
    // ESLint: "  row:col  error  message  rule-name"
    const eslintMatch = line.match(/^\s+(\d+):(\d+)\s+(error|warning)\s+(.+?)\s+([\w/@\-]+)$/);
    if (eslintMatch) {
      const [, , , level, msg, rule] = eslintMatch;
      const key = `${level} ${rule}`;
      if (!byRule.has(key)) byRule.set(key, []);
      byRule.get(key)!.push(msg.trim());
      if (level === "error") totalProblems++;
    }
    // Biome: "file row:col ━ rule: message"
    const biomeMatch = line.match(/^(.+?) (\d+):(\d+) ━+\s+(.+)$/);
    if (biomeMatch) {
      const [, , , , msg] = biomeMatch;
      const key = "lint";
      if (!byRule.has(key)) byRule.set(key, []);
      byRule.get(key)!.push(msg.trim());
      totalProblems++;
    }
  }

  if (byRule.size === 0) {
    if (/not recognized|not found|command not found/i.test(raw)) return compressGeneric(raw);
    if (raw.toLowerCase().includes("problem") || raw.toLowerCase().includes("error")) return compressGeneric(raw);
    return "lint ok";
  }

  const out = [`${totalProblems} problem(s) across ${byRule.size} rule(s):`];
  for (const [rule, msgs] of byRule) {
    const unique = [...new Set(msgs)];
    out.push(`  ${rule} (${unique.length}):`);
    out.push(...unique.slice(0, 5).map((m) => `    ${m}`));
    if (unique.length > 5) out.push(`    ... +${unique.length - 5} more`);
  }
  return out.join("\n");
}

// ─── Ruff Filter ─────────────────────────────────────────────────────────────

export function filterRuff(raw: string): string {
  // Try JSON output first
  try {
    const results = JSON.parse(raw) as Array<{
      filename: string;
      message: string;
      code: string;
      location?: { row: number; column: number };
    }>;
    if (Array.isArray(results)) {
      const byFile = new Map<string, string[]>();
      for (const r of results) {
        if (!byFile.has(r.filename)) byFile.set(r.filename, []);
        const loc = r.location ? `${r.location.row}:${r.location.column}` : "?";
        byFile.get(r.filename)!.push(`  ${loc} ${r.code} ${r.message}`);
      }
      if (byFile.size === 0) return "ruff ok";
      const out = [`${results.length} issue(s) in ${byFile.size} file(s):`];
      for (const [file, msgs] of byFile) {
        out.push(file);
        out.push(...msgs.slice(0, 10));
        if (msgs.length > 10) out.push(`  ... +${msgs.length - 10} more`);
      }
      return out.join("\n");
    }
  } catch { /* not JSON, parse plain text */ }

  // Plain text: "file.py:row:col: Exxx message"
  const byFile = new Map<string, string[]>();
  for (const line of raw.split("\n")) {
    const m = line.match(/^(.+?):(\d+):(\d+): ([A-Z]\d+) (.+)$/);
    if (m) {
      const [, file, row, col, code, msg] = m;
      if (!byFile.has(file)) byFile.set(file, []);
      byFile.get(file)!.push(`  ${row}:${col} ${code} ${msg}`);
    }
  }

  if (byFile.size === 0) {
    if (/not recognized|not found|command not found/i.test(raw)) return compressGeneric(raw);
    return "ruff ok";
  }
  const total = [...byFile.values()].reduce((s, v) => s + v.length, 0);
  const out = [`${total} issue(s) in ${byFile.size} file(s):`];
  for (const [file, msgs] of byFile) {
    out.push(file);
    out.push(...msgs.slice(0, 10));
  }
  return out.join("\n");
}

// ─── Golangci-lint Filter ─────────────────────────────────────────────────────

export function filterGolangci(raw: string): string {
  try {
    const result = JSON.parse(raw) as {
      Issues?: Array<{ FromLinter: string; Text: string; Pos?: { Filename: string; Line: number } }>;
    };
    if (result.Issues && Array.isArray(result.Issues)) {
      const byLinter = new Map<string, string[]>();
      for (const issue of result.Issues) {
        if (!byLinter.has(issue.FromLinter)) byLinter.set(issue.FromLinter, []);
        const pos = issue.Pos ? `${issue.Pos.Filename}:${issue.Pos.Line}` : "?";
        byLinter.get(issue.FromLinter)!.push(`  ${pos}: ${issue.Text}`);
      }
      if (byLinter.size === 0) return "golangci-lint ok";
      const total = result.Issues.length;
      const out = [`${total} issue(s) across ${byLinter.size} linter(s):`];
      for (const [linter, msgs] of byLinter) {
        out.push(`${linter} (${msgs.length}):`);
        out.push(...msgs.slice(0, 5));
        if (msgs.length > 5) out.push(`  ... +${msgs.length - 5} more`);
      }
      return out.join("\n");
    }
  } catch { /* not JSON */ }

  // Plain text fallback
  return filterBuildOutput(raw);
}

// ─── Next.js Build Filter ─────────────────────────────────────────────────────

export function filterNext(raw: string): string {
  const lines = raw.split("\n");
  const errors: string[] = [];
  const warnings: string[] = [];
  let buildSuccess = false;

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    // Skip progress noise
    if (/^\s*[▲◆○●]\s+/.test(t) || /^(Compiling|Compiled|Creating|Building|Generating|Linting)\s/.test(t)) continue;
    if (/Route \(|Pages\s+\(|\s+Size\s+|\s+First Load/.test(t)) continue;
    if (/✓|✔/.test(t) && /compiled|linted/.test(t.toLowerCase())) { buildSuccess = true; continue; }
    if (/error:/i.test(t)) errors.push(t);
    if (/warn:/i.test(t)) warnings.push(t);
  }

  if (errors.length === 0 && warnings.length === 0) return buildSuccess ? "next build ok" : compressGeneric(raw);
  const out: string[] = [];
  if (errors.length) { out.push(`${errors.length} error(s):`); out.push(...errors.slice(0, 20)); }
  if (warnings.length) { out.push(`${warnings.length} warning(s):`); out.push(...warnings.slice(0, 10)); }
  return out.join("\n");
}

// ─── Prettier Filter ──────────────────────────────────────────────────────────

export function filterPrettier(raw: string): string {
  const files = raw.split("\n").filter((l) => l.trim() && !l.includes("Checking formatting") && !l.includes("All matched"));
  if (files.length === 0) return "prettier ok";
  return `${files.length} file(s) need formatting:\n${files.slice(0, 20).join("\n")}`;
}

// ─── NPM Filter ───────────────────────────────────────────────────────────────

export function filterNpm(raw: string): string {
  const lines = raw.split("\n");
  const errors: string[] = [];
  const important: string[] = [];

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    // Skip progress bars and download noise
    if (/^(npm (warn|notice)|WARN|notice)/.test(t) && !/error/i.test(t)) continue;
    if (/^[\u2800-\u28FF⠁-⣿]/.test(t) || /^\s*(|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏)\s/.test(t)) continue;
    if (/npm ERR!/i.test(t)) errors.push(t);
    else if (/added|removed|updated|audited|packages/.test(t)) important.push(t);
  }

  if (errors.length > 0) return errors.slice(0, 20).join("\n");
  if (important.length > 0) return important.slice(0, 5).join("\n");
  return compressGeneric(raw);
}

// ─── Pnpm Filter ──────────────────────────────────────────────────────────────

export function filterPnpm(raw: string): string {
  const lines = raw.split("\n").filter((l) => l.trim() && !/^(Progress|Packages|WARN)/.test(l.trim()));
  if (lines.length <= 30) return lines.join("\n");

  const deps = lines.filter((l) => /^\s+[\w@]/.test(l) || /^[└├─│]/.test(l));
  const summary = lines.find((l) => /packages?\s+\d/.test(l)) ?? `${deps.length} packages`;
  return `${summary}\n${deps.slice(0, 30).join("\n")}${deps.length > 30 ? `\n... +${deps.length - 30} more` : ""}`;
}

// ─── Pip Filter ───────────────────────────────────────────────────────────────

export function filterPip(raw: string): string {
  const lines = raw.split("\n").filter((l) => l.trim() && !/^(WARNING|DEPRECATION|Requirement already)/.test(l.trim()));
  if (lines.length <= 30) return lines.join("\n");
  return `${lines.length} packages\n${lines.slice(0, 20).join("\n")}\n... +${lines.length - 20} more`;
}

// ─── Docker Filter ────────────────────────────────────────────────────────────

export function filterDocker(raw: string, subcmd: string): string {
  if (/images/.test(subcmd)) {
    const lines = raw.split("\n").filter((l) => l.trim());
    if (lines.length <= 1) return "(no images)";
    const result: string[] = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(/\s{2,}/);
      if (parts.length >= 3) result.push(`${parts[0]}:${parts[1]} ${parts[6] ?? parts[4] ?? ""}`);
      else result.push(lines[i].trim());
    }
    return `${result.length} image(s)\n${result.join("\n")}`;
  }
  if (/logs/.test(subcmd)) return filterLogs(raw);
  return filterDockerPs(raw);
}

// ─── Kubectl Filter ───────────────────────────────────────────────────────────

export function filterKubectl(raw: string, subcmd: string): string {
  if (/not recognized|not found|command not found/i.test(raw)) return compressGeneric(raw);
  if (/logs/.test(subcmd)) return filterLogs(raw);

  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length <= 1) return "(no resources)";

  const result: string[] = [];
  // pods: NAME READY STATUS RESTARTS AGE
  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].trim().split(/\s+/);
    if (parts.length >= 3) {
      result.push(parts.slice(0, 5).join(" "));
    } else {
      result.push(lines[i].trim());
    }
  }
  return `${result.length} resource(s)\n${result.join("\n")}`;
}

// ─── GitHub CLI Filter ────────────────────────────────────────────────────────

export function filterGh(raw: string, subcmd: string): string {
  if (/not recognized|not found|command not found/i.test(raw)) return compressGeneric(raw);
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return "(no results)";

  const result: string[] = [];
  for (const line of lines) {
    const parts = line.split(/\t/);
    if (parts.length >= 3) {
      // pr/issue: #N  title  [state]  author
      result.push(parts.slice(0, 4).map((p) => p.trim()).join("  "));
    } else {
      result.push(line.trim().slice(0, 120));
    }
  }
  return `${result.length} item(s) [${subcmd}]:\n${result.join("\n")}`;
}

// ─── Curl Filter ─────────────────────────────────────────────────────────────

export function filterCurl(raw: string): string {
  // Strip HTTP response headers if present
  const bodyStart = raw.indexOf("\r\n\r\n");
  const body = bodyStart >= 0 ? raw.slice(bodyStart + 4) : raw;

  // Try JSON
  try {
    JSON.parse(body);
    return filterJson(body);
  } catch { /* not JSON */ }

  return compressGeneric(body);
}

// ─── Env Vars Filter ─────────────────────────────────────────────────────────

const SECRET_PATTERN = /key|token|secret|password|passwd|credential|auth|api_key|access|private/i;

export function filterEnv(raw: string, filter?: string): string {
  const lines = raw.split("\n").filter((l) => l.includes("="));
  const filtered = filter
    ? lines.filter((l) => l.toLowerCase().includes(filter.toLowerCase()))
    : lines;

  const result = filtered.map((line) => {
    const eq = line.indexOf("=");
    if (eq < 0) return line;
    const name = line.slice(0, eq);
    const val = line.slice(eq + 1);
    if (SECRET_PATTERN.test(name)) {
      return `${name}=***masked***`;
    }
    return val.length > 80 ? `${name}=${val.slice(0, 77)}...` : line;
  });

  return result.length > 0 ? result.join("\n") : "(no matching vars)";
}

// ─── Diff Filter ─────────────────────────────────────────────────────────────

export function filterDiff(raw: string): string {
  return filterGitDiff(raw);
}

// ─── Prisma Filter ────────────────────────────────────────────────────────────

export function filterPrisma(raw: string): string {
  const lines = raw.split("\n");
  const result: string[] = [];

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    // Strip ASCII art boxes and decorative borders
    if (/^[┌┐└┘│├┤┬┴┼─═╔╗╚╝║╠╣╦╩╬▓░▌▐▄▀■]+$/.test(t)) continue;
    if (/^[*#=\-]{5,}$/.test(t)) continue;
    // Keep error/success lines and model info
    if (/error|warn|Migration|Generated|Prisma Client|model |Running/i.test(t)) {
      result.push(t);
    }
  }

  return result.length > 0 ? result.join("\n") : compressGeneric(raw);
}

// ─── Summary Fallback ─────────────────────────────────────────────────────────

export function filterSummary(raw: string): string {
  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length <= 6) return lines.join("\n");
  return [
    ...lines.slice(0, 3),
    `... (${lines.length - 6} lines omitted) ...`,
    ...lines.slice(-3),
  ].join("\n");
}

// ─── Test Output Filter ───────────────────────────────────────────────────────

export function filterTestOutput(raw: string): string {
  const lines = raw.split("\n");
  const failures: string[] = [];
  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;
  let summary = "";

  for (const line of lines) {
    const jestMatch = line.match(/Tests:\s+(\d+)\s+failed.*?(\d+)\s+passed.*?(\d+)\s+total/);
    const pytestMatch = line.match(/(\d+)\s+passed(?:,\s+(\d+)\s+failed)?/);
    const cargoMatch = line.match(/test result:.*?(\d+)\s+passed;\s+(\d+)\s+failed/);

    if (jestMatch) {
      failedTests = parseInt(jestMatch[1]);
      passedTests = parseInt(jestMatch[2]);
      totalTests = parseInt(jestMatch[3]);
      summary = line.trim();
    } else if (cargoMatch) {
      passedTests = parseInt(cargoMatch[1]);
      failedTests = parseInt(cargoMatch[2]);
      totalTests = passedTests + failedTests;
      summary = line.trim();
    } else if (pytestMatch && !summary) {
      passedTests = parseInt(pytestMatch[1]);
      failedTests = pytestMatch[2] ? parseInt(pytestMatch[2]) : 0;
      totalTests = passedTests + failedTests;
      summary = line.trim();
    }

    if (
      /FAIL|FAILED|ERROR|panic|AssertionError|assert/i.test(line) &&
      !/^\s*$/.test(line) &&
      !line.includes("test result:")
    ) {
      failures.push(line.trim());
    }
  }

  if (failedTests === 0 && totalTests > 0) return `PASSED: ${totalTests} tests`;

  if (failedTests > 0) {
    const result = [`FAILED: ${failedTests}/${totalTests} tests`];
    result.push(...[...new Set(failures)].slice(0, 20));
    return result.join("\n");
  }

  return compressGeneric(raw);
}
