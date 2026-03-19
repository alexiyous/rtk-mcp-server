import fs from "fs";
import path from "path";
import os from "os";
import { getConfig } from "./config.js";

const TEE_DIR = path.join(os.homedir(), ".rtk-mcp", "tee");

function ensureTeeDir(): void {
  if (!fs.existsSync(TEE_DIR)) {
    fs.mkdirSync(TEE_DIR, { recursive: true });
  }
}

function sanitizeCmd(cmd: string): string {
  return cmd
    .replace(/[^a-zA-Z0-9_\-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 60);
}

function rotateFiles(maxFiles: number): void {
  const files = fs
    .readdirSync(TEE_DIR)
    .filter((f) => f.endsWith(".log"))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(TEE_DIR, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);

  while (files.length >= maxFiles) {
    const oldest = files.shift();
    if (oldest) {
      fs.unlinkSync(path.join(TEE_DIR, oldest.name));
    }
  }
}

export function saveTeeFile(cmd: string, output: string): string | undefined {
  const cfg = getConfig();
  if (!cfg.tee.enabled || cfg.tee.mode === "never") return undefined;

  try {
    ensureTeeDir();
    rotateFiles(cfg.tee.max_files);

    const ts = Date.now();
    const sanitized = sanitizeCmd(cmd);
    const filename = `${ts}_${sanitized}.log`;
    const filepath = path.join(TEE_DIR, filename);

    fs.writeFileSync(filepath, `CMD: ${cmd}\n\n${output}`, "utf8");
    return filepath;
  } catch {
    return undefined;
  }
}
