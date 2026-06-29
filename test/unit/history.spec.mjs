import { describe, it, expect, vi } from "vitest";
import { createHistory } from "../../src/agent/history.mjs";

describe("history rewind turns", () => {
  it("tracks closed turns and rewinds a full user/assistant/tool group", () => {
    const h = createHistory("sys");
    const live = h.messages();
    const t = h.beginTurn("u1");
    live.push({ role: "assistant", content: "a", tool_calls: [{ id: "c1" }] });
    live.push({ role: "tool", tool_call_id: "c1", name: "x", content: "ok" });
    h.closeTurn(t);
    expect(h.rewindableCount()).toBe(1);
    expect(live).toHaveLength(4);
    const r = h.rewind(1);
    expect(r.ok).toBe(true);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ role: "system", content: "sys" });
    expect(h.rewindableCount()).toBe(0);
  });

  it("rewinds multiple turns to the correct messageStart", () => {
    const h = createHistory("sys");
    const live = h.messages();
    for (const label of ["one", "two", "three"]) {
      const t = h.beginTurn(label);
      live.push({ role: "assistant", content: "a:" + label });
      h.closeTurn(t);
    }
    expect(live.map((m) => m.content)).toEqual(["sys", "one", "a:one", "two", "a:two", "three", "a:three"]);
    const r = h.rewind(2);
    expect(r.ok).toBe(true);
    expect(live.map((m) => m.content)).toEqual(["sys", "one", "a:one"]);
    expect(h.closedTurns()).toHaveLength(1);
  });

  it("does not rewind open turns until they are closed", () => {
    const h = createHistory("sys");
    h.beginTurn("u");
    expect(h.rewindableCount()).toBe(0);
    expect(h.rewind(1).ok).toBe(false);
  });

  it("can discard an open turn", () => {
    const h = createHistory("sys");
    const live = h.messages();
    const t = h.beginTurn("u");
    live.push({ role: "assistant", content: "partial" });
    expect(h.discardTurn(t)).toBe(true);
    expect(live).toHaveLength(1);
    expect(h.rewindableCount()).toBe(0);
  });

  it("clear keeps the live array reference and clears turns", () => {
    const h = createHistory("sys");
    const live = h.messages();
    const t = h.beginTurn("u");
    h.closeTurn(t);
    h.clear();
    expect(h.messages()).toBe(live);
    expect(live).toEqual([{ role: "system", content: "sys" }]);
    expect(h.rewindableCount()).toBe(0);
  });

  it("compact clears rewind turns only after success", async () => {
    const h = createHistory("sys");
    const live = h.messages();
    const t = h.beginTurn("u");
    h.closeTurn(t);
    await expect(h.compact({ complete: async () => "摘要" })).resolves.toBe("摘要");
    expect(h.messages()).toBe(live);
    expect(live.map((m) => m.role)).toEqual(["system", "user"]);
    expect(live[1].content).toContain("摘要");
    expect(h.rewindableCount()).toBe(0);

    const h2 = createHistory("sys");
    const t2 = h2.beginTurn("u");
    h2.closeTurn(t2);
    await expect(h2.compact({ complete: async () => { throw new Error("boom"); } })).rejects.toThrow("boom");
    expect(h2.rewindableCount()).toBe(1);
  });

  it("preserves system updates across rewind", () => {
    const h = createHistory("old");
    h.setSystem("new");
    const t = h.beginTurn("u");
    h.closeTurn(t);
    h.rewind(1);
    expect(h.getSystem()).toBe("new");
  });
});
