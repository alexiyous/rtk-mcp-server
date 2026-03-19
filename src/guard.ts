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
