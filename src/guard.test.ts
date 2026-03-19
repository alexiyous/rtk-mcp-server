// src/guard.test.ts
import { describe, it, expect } from "vitest";
import { validateArgs, checkAllowlist, checkPathTraversal } from "./guard.js";

describe("validateArgs — safe inputs", () => {
  it("allows plain args", () => {
    expect(validateArgs("status").safe).toBe(true);
  });
  it("allows double-quoted string with spaces", () => {
    expect(validateArgs('log --format="%H %s"').safe).toBe(true);
  });
  it("allows pipe inside double quotes (regex alternation)", () => {
    expect(validateArgs('"foo|bar"').safe).toBe(true);
  });
  it("allows semicolon inside single quotes", () => {
    expect(validateArgs("'foo;bar'").safe).toBe(true);
  });
  it("allows redirect inside quotes", () => {
    expect(validateArgs('"a>b"').safe).toBe(true);
  });
  it("allows plain $VAR expansion", () => {
    expect(validateArgs("log $BRANCH").safe).toBe(true);
  });
  it("allows hyphen flags", () => {
    expect(validateArgs("--no-pager log -n 10").safe).toBe(true);
  });
});

describe("validateArgs — blocked inputs", () => {
  it("blocks semicolon outside quotes", () => {
    const r = validateArgs("status; curl evil.com");
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/semicolon/);
  });
  it("blocks && outside quotes", () => {
    const r = validateArgs("status && curl evil.com");
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/&&/);
  });
  it("blocks || outside quotes", () => {
    const r = validateArgs("status || curl evil.com");
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/\|\|/);
  });
  it("blocks pipe outside quotes", () => {
    const r = validateArgs("log | cat");
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/pipe/);
  });
  it("blocks redirect > outside quotes", () => {
    const r = validateArgs("log > patch.txt");
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/redirect/);
  });
  it("blocks redirect < outside quotes", () => {
    const r = validateArgs("commit -F < msg.txt");
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/redirect/);
  });
  it("blocks backtick substitution", () => {
    const r = validateArgs("log `whoami`");
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/backtick/);
  });
  it("blocks $( substitution", () => {
    const r = validateArgs("log $(whoami)");
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/command substitution/);
  });
  it("blocks <( process substitution", () => {
    const r = validateArgs("diff <(cat a) <(cat b)");
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/process substitution/);
  });
});

describe("checkAllowlist", () => {
  it("allows git", () => expect(checkAllowlist("git status").allowed).toBe(true));
  it("allows npm run build", () => expect(checkAllowlist("npm run build").allowed).toBe(true));
  it("allows npx tsc", () => expect(checkAllowlist("npx tsc").allowed).toBe(true));
  it("allows ./gradlew", () => expect(checkAllowlist("./gradlew assembleDebug").allowed).toBe(true));
  it("allows rg with args", () => expect(checkAllowlist("rg -n pattern src/").allowed).toBe(true));
  it("blocks unknown command", () => {
    const r = checkAllowlist("evil_cmd --flag");
    expect(r.allowed).toBe(false);
    expect(r.prefix).toBe("evil_cmd");
  });
  it("blocks empty command", () => {
    expect(checkAllowlist("").allowed).toBe(false);
  });
  it("blocks curl-evil (not in allowlist)", () => {
    expect(checkAllowlist("curl_evil http://x.com").allowed).toBe(false);
  });
  it("allows curl (is in allowlist)", () => {
    expect(checkAllowlist("curl http://x.com").allowed).toBe(true);
  });
});

describe("checkPathTraversal", () => {
  it("allows relative path", () => expect(checkPathTraversal("src/index.ts").safe).toBe(true));
  it("allows absolute path", () => expect(checkPathTraversal("/home/user/project/file.ts").safe).toBe(true));
  it("allows dot file", () => expect(checkPathTraversal(".gitignore").safe).toBe(true));
  it("blocks ../", () => {
    const r = checkPathTraversal("../../etc/passwd");
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/traversal/);
  });
  it("blocks ..\\ on Windows", () => {
    const r = checkPathTraversal("..\\..\\Windows\\System32");
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/traversal/);
  });
  it("blocks encoded traversal", () => {
    const r = checkPathTraversal("%2e%2e/etc/passwd");
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/traversal/);
  });
});
