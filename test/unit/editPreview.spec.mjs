import { describe, it, expect } from "vitest";
import { DOMParser, parseHTML } from "linkedom";
import { blockTreeHtml } from "../../src/ui/blockTree.mjs";
import { computeEditPreview, renderWorkspaceSvg } from "../../src/host/renderBlocks.mjs";
import { compile } from "../../src/xml/compile.mjs";
import { catalogBuilt, loadCatalogMap } from "../helpers/catalog.mjs";

const d = catalogBuilt ? describe : describe.skip;

// Minimal fake host caps: computeEditPreview needs state().xmlCode (read path),
// win.DOMParser (patchOps). No Blockly → afterXml may stay empty, which is the
// point: the offline summary + postIR must still be correct.
function fakeCaps(xmlCode = "") {
  return {
    win: { DOMParser, localStorage: {}, XMLSerializer: null },
    Blockly: null,
    state: () => ({ xmlCode }),
    workspace: () => null,
  };
}

d("edit preview (blockTree + computeEditPreview)", () => {
  const catalog = loadCatalogMap();

  describe("blockTreeHtml", () => {
    it("empty program → muted empty-workspace line", () => {
      const html = blockTreeHtml([], catalog);
      expect(html).toContain("空工作区");
    });

    it("fills zh template with the dropdown's zh label, escaped", () => {
      // mpython3_button_event: zh "当按键 %1 被 %2 时", fields ACTION/BUTTON.
      const ir = [[{ type: "mpython3_button_event", fields: { ACTION: "pressed", BUTTON: "a" } }]];
      const html = blockTreeHtml(ir, catalog);
      expect(html).toContain("当按键");
      // dropdown values resolve to their zh labels, not the raw codes
      expect(html).toContain("按下");
      expect(html).toContain("rounded-md border"); // chip chrome present
      expect(html).not.toContain("pressed");
    });

    it("renders nested statement bodies as indented sub-chips", () => {
      const ir = [[
        {
          type: "controls_repeat_ext",
          inputs: { TIMES: { type: "math_number", fields: { NUM: "3" } } },
          statements: { DO: [{ type: "math_number", fields: { NUM: "7" } }] },
        },
      ]];
      const html = blockTreeHtml(ir, catalog);
      expect(html).toContain("重复");
      expect(html).toContain("DO");      // statement-slot label
      expect(html).toContain("border-l-2"); // nested body rail
      // inline value chip for TIMES
      expect(html).toContain("3");
    });

    it("never injects unescaped angle brackets from field values", () => {
      const ir = [[{ type: "math_number", fields: { NUM: "<script>" } }]];
      const html = blockTreeHtml(ir, catalog);
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;");
    });
  });

  describe("computeEditPreview (offline, no workspace mutation)", () => {
    it("catalog declares only mpython3_main as a statement container", () => {
      expect(catalog.get("mpython_main")?.statements).toEqual([]);
      expect(catalog.get("mpython3_main")?.statements).toEqual(["DO"]);
    });

    it("insert on empty workspace → ok, postIR + zh summary", () => {
      const caps = fakeCaps("");
      const ops = [{ op: "insert", anchor: { at: "new" }, blocks: [{ type: "mpython3_button_event", fields: { ACTION: "pressed", BUTTON: "a" } }] }];
      const pre = computeEditPreview(caps, ops, catalog);
      expect(pre.ok).toBe(true);
      expect(pre.summary.join("")).toContain("新增");
      expect(pre.postIR.flat()[0].type).toBe("mpython3_button_event");
      // afterXml round-trips through patchOps (DOMParser is available)
      expect(pre.afterXml).toContain("mpython3_button_event");
    });

    it("does not treat legacy mpython_main as a statement container", () => {
      // Live-site truth: mpython_main only has a dummy input, no body. Fake
      // <statement> XML makes host Blockly throw connection=null while loading.
      const mainXml = '<xml xmlns="https://developers.google.com/blockly/xml"><block type="mpython_main" id="m1"></block></xml>';
      const caps = fakeCaps(mainXml);
      const ops = [{ op: "insert", anchor: { at: "body", id: "b1", input: "" }, blocks: [{ type: "mpython_display_Show" }] }];
      const pre = computeEditPreview(caps, ops, catalog);
      expect(pre.ok).toBe(false);
      expect(pre.feedback).toContain("没有语句体");
      expect(pre.summary.join("")).toContain("新增");
    });

    it("keeps mpython_main and inserts visible execution blocks as a new top-level stack", () => {
      const mainXml = '<xml xmlns="https://developers.google.com/blockly/xml"><block type="mpython_main" id="m1"></block></xml>';
      const caps = fakeCaps(mainXml);
      const ops = [{ op: "insert", anchor: { at: "new" }, blocks: [{ type: "mpython_display_Show" }] }];
      const pre = computeEditPreview(caps, ops, catalog);
      expect(pre.ok).toBe(true);
      expect(pre.afterXml).toContain("mpython_main");
      expect(pre.afterXml).toContain("mpython_display_Show");
      expect(pre.afterXml).not.toContain("mpython3_main");
    });

    it("invalid ops → ok:false, but summary still computed for the card", () => {
      const caps = fakeCaps("");
      const pre = computeEditPreview(caps, [{ op: "delete", id: "nope" }], catalog);
      expect(pre.ok).toBe(false);
      expect(typeof pre.feedback).toBe("string");
      // summary survives validation failure so the confirm card never reads blank
      expect(Array.isArray(pre.summary)).toBe(true);
      expect(pre.summary.join("")).toContain("删除");
    });

    it("invalid dropdown values still produce raw block preview", () => {
      const caps = fakeCaps("");
      const ops = [{ op: "insert", anchor: { at: "new" }, blocks: [
        { type: "mpython_display_fill", fields: { display_fill: "清空(fill(0))" } },
        { type: "mpython_display_DispChar", fields: { AUTORETURN: "不换行(False)", TEXTMODE: "普通(1)" }, inputs: {
          x: { type: "math_number", fields: { NUM: "0" } },
          y: { type: "math_number", fields: { NUM: "0" } },
          message: { type: "text", fields: { TEXT: "Hello World" } },
        } },
        { type: "mpython_display_Show" },
      ] }];
      const pre = computeEditPreview(caps, ops, catalog);
      expect(pre.ok).toBe(false);
      expect(pre.rawIR.length).toBe(1);
      const html = blockTreeHtml(pre.rawIR, catalog);
      expect(html).toContain("Hello World");
      expect(html).toContain("OLED 显示");
    });

    it("accepts a 4-part text_join edit before showing the confirmation preview", () => {
      const base = [[
        { type: "mpython_display_Show" },
        { type: "mpython_display_Show" },
        { type: "mpython_display_Show" },
        { type: "mpython_display_Show" },
        { type: "mpython_display_Show" },
        { type: "mpython_display_Show" },
        { type: "mpython_display_Show" },
      ]];
      const caps = fakeCaps(compile(base, { catalog }));
      const ops = [{ op: "insert", anchor: { at: "after", id: "b7" }, blocks: [
        { type: "mpython_display_DispChar", fields: { TEXTMODE: "1", AUTORETURN: "False" }, inputs: {
          x: { type: "math_number", fields: { NUM: "0" } },
          y: { type: "math_number", fields: { NUM: "16" } },
          message: { type: "text_join", inputs: {
            ADD0: { type: "mpython_time_localtime", fields: { time_localtime: "[1]" } },
            ADD1: { type: "text", fields: { TEXT: "月" } },
            ADD2: { type: "mpython_time_localtime", fields: { time_localtime: "[2]" } },
            ADD3: { type: "text", fields: { TEXT: "日" } },
          } },
        } },
        { type: "mpython_display_Show" },
      ] }];
      const pre = computeEditPreview(caps, ops, catalog);
      expect(pre.ok).toBe(true);
      expect(pre.feedback).toBeUndefined();
      expect(pre.afterXml).toMatch(/<mutation items="4"\s*\/?>/);
      expect(pre.postIR.flat().at(-2).type).toBe("mpython_display_DispChar");
    });

    it("blockTree output parses as HTML (well-formed for shadow DOM)", () => {
      const ir = [[{ type: "controls_repeat_ext", inputs: { TIMES: { type: "math_number", fields: { NUM: "42" } } }, statements: { DO: [] } }]];
      const html = blockTreeHtml(ir, catalog);
      const { document } = parseHTML(`<div id="root">${html}</div>`);
      const root = document.querySelector("#root");
      expect(root).toBeTruthy();
      expect(root.textContent).toContain("42");
    });
  });

  describe("renderWorkspaceSvg live-capture (intrusive path restores workspace)", () => {
    // Fake host with the closure-Blockly shape of mpython.cn: no inject/Xml, but a
    // live workspace SVG + loadXMLCode mutation. Records every committed XML so we
    // can assert the user's workspace is restored after the screenshot.
    function fakeLiveCaps(originalXml) {
      const { document } = parseHTML("<!doctype html><html><body></body></html>");
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const canvas = document.createElementNS("http://www.w3.org/2000/svg", "g");
      canvas.setAttribute("class", "blocklyBlockCanvas");
      svg.appendChild(canvas);
      const commits = [];
      let liveXml = originalXml;
      return {
        commits,
        liveXml: () => liveXml,
        win: { DOMParser, getComputedStyle: () => ({ getPropertyValue: () => "" }) },
        doc: document,
        Blockly: { Msg: {} }, // closure build: no inject/Xml → off-screen path skipped
        mutations: { loadXMLCode: true, changeXmlCode: false },
        commit: (name, payload) => { if (name === "loadXMLCode") { liveXml = payload.xmlCode; commits.push(payload.xmlCode); } },
        state: () => ({ xmlCode: liveXml }),
        workspace: () => ({
          getParentSvg: () => svg,
          getBlockCanvas: () => canvas,
          getCanvas: () => canvas,
        }),
      };
    }

    it("injects the preview XML then restores the original, leaving workspace unchanged", () => {
      const original = '<xml xmlns="https://developers.google.com/blockly/xml"><block type="math_number"><field name="NUM">1</field></block></xml>';
      const preview = '<xml xmlns="https://developers.google.com/blockly/xml"><block type="math_number"><field name="NUM">2</field></block></xml>';
      const caps = fakeLiveCaps(original);

      const svg = renderWorkspaceSvg(caps, preview);
      expect(svg).toBeTruthy();               // a cloned SVG came back
      expect(svg.tagName.toLowerCase()).toBe("svg");
      // baseline Blockly CSS is embedded so text/field colours survive Shadow DOM
      const style = svg.querySelector("style");
      expect(style?.textContent).toContain(".blocklyText");
      // commit sequence: load preview, then restore original
      expect(caps.commits[0]).toContain('name="NUM">2');
      expect(caps.commits[caps.commits.length - 1]).toBe(original);
      expect(caps.liveXml()).toBe(original);  // workspace ends on the user's XML
    });

    it("calls lock.freeze/unfreeze around the swap", () => {
      const caps = fakeLiveCaps('<xml xmlns="https://developers.google.com/blockly/xml"></xml>');
      const xml = '<xml xmlns="https://developers.google.com/blockly/xml"><block type="math_number"></block></xml>';
      const calls = [];
      const lock = { freeze: () => { calls.push("freeze"); return true; }, unfreeze: () => calls.push("unfreeze") };
      renderWorkspaceSvg(caps, xml, { lock });
      expect(calls).toEqual(["freeze", "unfreeze"]);
    });

    it("empty XML → null (nothing to draw)", () => {
      const caps = fakeLiveCaps("");
      expect(renderWorkspaceSvg(caps, '<xml xmlns="https://developers.google.com/blockly/xml"></xml>')).toBe(null);
    });
  });
});
