// Runner: wraps command execution with filtering, token tracking, and tee
import { execSync as syncRun } from "node:child_process";
import { recordUsage } from "./tracking.js";
import { saveTeeFile } from "./tee.js";

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface FilteredResult {
  raw: string;
  filtered: string;
  teePath?: string;
  exitCode: number;
  tokensBefore: number;
  tokensAfter: number;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function translateCmd(cmd: string): string {
  if (process.platform !== "win32") return cmd;
  return cmd.replace(/\bcat\s+/g, "type ");
}

export function runCommand(
  cmd: string,
  cwd?: string,
  timeoutMs = 30_000
): RunResult {
  const command = translateCmd(cmd);
  try {
    const stdout = syncRun(command, {
      cwd: cwd || process.env.HOME,
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
    });
    return { stdout: stdout.replace(/\r/g, ""), stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: (e.stdout || "").replace(/\r/g, ""),
      stderr: (e.stderr || "").replace(/\r/g, ""),
      exitCode: e.status ?? 1,
    };
  }
}

export function runFiltered(
  rawCmd: string,
  rtkCmd: string,
  filter: (raw: string) => string,
  cwd?: string,
  timeoutMs = 30_000
): FilteredResult {
  const result = runCommand(rawCmd, cwd, timeoutMs);
  const raw = result.stdout + (result.stderr ? "\n" + result.stderr : "");
  const filtered = filter(raw);

  const tokensBefore = estimateTokens(raw);
  const tokensAfter = estimateTokens(filtered);

  recordUsage(rawCmd, rtkCmd, raw, filtered);

  let teePath: string | undefined;
  if (result.exitCode !== 0) {
    teePath = saveTeeFile(rawCmd, raw);
  }

  return {
    raw,
    filtered,
    teePath,
    exitCode: result.exitCode,
    tokensBefore,
    tokensAfter,
  };
}

export function formatResult(r: FilteredResult, label?: string): string {
  const pct =
    r.tokensBefore > 0
      ? Math.round((1 - r.tokensAfter / r.tokensBefore) * 100)
      : 0;
  const header =
    r.exitCode !== 0
      ? `[exit: ${r.exitCode}]`
      : `[${pct}% compression: ${r.tokensBefore}→${r.tokensAfter} tokens]`;
  const tee = r.teePath ? `\n[full output saved to: ${r.teePath}]` : "";
  const body = label ? `${label}\n${r.filtered}` : r.filtered;
  return `${header}\n${body}${tee}`;
}
