import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { getConfig } from "./config.js";

interface HistoryRow {
  id: number;
  timestamp: number;
  raw_cmd: string;
  rtk_cmd: string;
  raw_tokens: number;
  filtered_tokens: number;
  tokens_saved: number;
}

interface DailyRow {
  date: string;
  total_saved: number;
  runs: number;
}

let _db: Database.Database | null = null;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const CREATE_TABLE_SQL = [
  `CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    raw_cmd TEXT NOT NULL,
    rtk_cmd TEXT NOT NULL,
    raw_tokens INTEGER NOT NULL,
    filtered_tokens INTEGER NOT NULL,
    tokens_saved INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_timestamp ON history(timestamp)`,
];

function getDb(): Database.Database {
  if (_db) return _db;

  const cfg = getConfig();
  const dbPath = cfg.tracking.database_path;
  const dbDir = path.dirname(dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  _db = new Database(dbPath);
  for (const stmt of CREATE_TABLE_SQL) {
    _db.prepare(stmt).run();
  }

  return _db;
}

export function recordUsage(
  rawCmd: string,
  rtkCmd: string,
  rawOutput: string,
  filteredOutput: string
): void {
  try {
    const db = getDb();
    const rawTokens = estimateTokens(rawOutput);
    const filteredTokens = estimateTokens(filteredOutput);
    const tokensSaved = Math.max(0, rawTokens - filteredTokens);

    db.prepare(
      `INSERT INTO history (timestamp, raw_cmd, rtk_cmd, raw_tokens, filtered_tokens, tokens_saved)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(Date.now(), rawCmd, rtkCmd, rawTokens, filteredTokens, tokensSaved);
  } catch {
    // Non-fatal — tracking failure should not break tool execution
  }
}

export function getSummary(): {
  total_runs: number;
  total_raw_tokens: number;
  total_filtered_tokens: number;
  total_saved: number;
  savings_pct: number;
} {
  try {
    const db = getDb();
    const row = db
      .prepare(
        `SELECT COUNT(*) as runs,
                SUM(raw_tokens) as raw,
                SUM(filtered_tokens) as filtered,
                SUM(tokens_saved) as saved
         FROM history`
      )
      .get() as { runs: number; raw: number; filtered: number; saved: number };

    const raw = row.raw ?? 0;
    const saved = row.saved ?? 0;
    return {
      total_runs: row.runs ?? 0,
      total_raw_tokens: raw,
      total_filtered_tokens: row.filtered ?? 0,
      total_saved: saved,
      savings_pct: raw > 0 ? Math.round((saved / raw) * 100) : 0,
    };
  } catch {
    return {
      total_runs: 0,
      total_raw_tokens: 0,
      total_filtered_tokens: 0,
      total_saved: 0,
      savings_pct: 0,
    };
  }
}

export function getHistory(n: number): HistoryRow[] {
  try {
    const db = getDb();
    return db
      .prepare(`SELECT * FROM history ORDER BY timestamp DESC LIMIT ?`)
      .all(n) as HistoryRow[];
  } catch {
    return [];
  }
}

export function recordBlocked(rawCmd: string, rtkCmd: string, reason: string): void {
  try {
    const db = getDb();
    db.prepare(
      `INSERT INTO history (timestamp, raw_cmd, rtk_cmd, raw_tokens, filtered_tokens, tokens_saved)
       VALUES (?, ?, ?, 0, 0, 0)`
    ).run(Date.now(), `[BLOCKED] ${rawCmd} — ${reason}`, rtkCmd);
  } catch {
    // Non-fatal
  }
}

export function getDailyBreakdown(): DailyRow[] {
  try {
    const db = getDb();
    return db
      .prepare(
        `SELECT date(timestamp/1000, 'unixepoch') as date,
                SUM(tokens_saved) as total_saved,
                COUNT(*) as runs
         FROM history
         GROUP BY date(timestamp/1000, 'unixepoch')
         ORDER BY date DESC
         LIMIT 30`
      )
      .all() as DailyRow[];
  } catch {
    return [];
  }
}
