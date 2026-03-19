import fs from "fs";
import path from "path";
import os from "os";

export interface RtkConfig {
  tracking: {
    database_path: string;
  };
  hooks: {
    exclude_commands: string[];
  };
  tee: {
    enabled: boolean;
    mode: "failures" | "always" | "never";
    max_files: number;
  };
}

const DEFAULT_CONFIG: RtkConfig = {
  tracking: {
    database_path: path.join(os.homedir(), ".rtk-mcp", "history.db"),
  },
  hooks: {
    exclude_commands: [],
  },
  tee: {
    enabled: true,
    mode: "failures",
    max_files: 20,
  },
};

function deepMerge(base: RtkConfig, override: Partial<RtkConfig>): RtkConfig {
  return {
    tracking: { ...base.tracking, ...(override.tracking ?? {}) },
    hooks: { ...base.hooks, ...(override.hooks ?? {}) },
    tee: { ...base.tee, ...(override.tee ?? {}) },
  };
}

let _config: RtkConfig | null = null;

export function loadConfig(): RtkConfig {
  if (_config) return _config;

  const configPath = path.join(os.homedir(), ".rtk-mcp", "config.json");
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<RtkConfig>;
      _config = deepMerge(DEFAULT_CONFIG, parsed);
    } catch {
      _config = { ...DEFAULT_CONFIG };
    }
  } else {
    _config = { ...DEFAULT_CONFIG };
  }

  // Expand ~ in database_path
  if (_config.tracking.database_path.startsWith("~")) {
    _config.tracking.database_path = path.join(
      os.homedir(),
      _config.tracking.database_path.slice(1)
    );
  }

  return _config;
}

export function getConfig(): RtkConfig {
  return _config ?? loadConfig();
}
