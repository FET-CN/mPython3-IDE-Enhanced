import { describe, it, expect } from "vitest";
import { COMMANDS, helpText, parseRewindArgs, parseSlash } from "../../src/agent/commands.mjs";

describe("slash commands", () => {
  it("registers /rewind as a local command", () => {
    expect(COMMANDS.rewind).toMatchObject({ kind: "local" });
    expect(helpText()).toContain("/rewind");
    expect(helpText()).toContain("--chat-only");
    expect(helpText()).toContain("/undo");
  });

  it("parses rewind slash input and preserves raw args", () => {
    expect(parseSlash("/rewind")).toEqual({ name: "rewind", arg: "" });
    expect(parseSlash("/rewind 2")).toEqual({ name: "rewind", arg: "2" });
    expect(parseSlash("/rewind --chat-only")).toEqual({ name: "rewind", arg: "--chat-only" });
    expect(parseSlash("/ReWind 3 --chat-only")).toEqual({ name: "rewind", arg: "3 --chat-only" });
    expect(parseSlash("/missing x")).toEqual({ name: "missing", arg: "x", unknown: true });
  });

  it("parses rewind arguments", () => {
    expect(parseRewindArgs("")).toEqual({ mode: "interactive" });
    expect(parseRewindArgs("1")).toEqual({ mode: "direct", count: 1, chatOnly: false });
    expect(parseRewindArgs("2 --chat-only")).toEqual({ mode: "direct", count: 2, chatOnly: true });
    expect(parseRewindArgs("--chat-only 2")).toEqual({ mode: "direct", count: 2, chatOnly: true });
    expect(parseRewindArgs("--chat-only")).toEqual({ mode: "direct", count: 1, chatOnly: true });
  });

  it("rejects invalid rewind arguments", () => {
    for (const arg of ["0", "-1", "abc", "1 2", "--unknown"]) {
      expect(parseRewindArgs(arg).mode).toBe("error");
    }
  });
});
