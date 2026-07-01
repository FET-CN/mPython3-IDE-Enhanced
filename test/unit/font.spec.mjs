import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { ensureEmbeddedFont, FONT_FAMILY, FONT_FACE_NAME } from "../../src/host/font.mjs";
import { installHostFontFix } from "../../src/host/hostFontFix.mjs";
import { installTerminalFix } from "../../src/host/termFix.mjs";

function installDoc() {
  const { document } = parseHTML("<!doctype html><html><head></head><body></body></html>");
  globalThis.document = document;
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  return document;
}

describe("embedded host font", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    delete globalThis.FontFace;
    delete globalThis.ace;
    delete globalThis.vm;
  });

  it("registers the embedded font once via FontFace", () => {
    const doc = installDoc();
    const added = [];
    const loaded = Promise.resolve("font-loaded");
    doc.fonts = { add: (ff) => added.push(ff) };
    globalThis.FontFace = class {
      constructor(name, src, opts) {
        this.name = name;
        this.src = src;
        this.opts = opts;
      }
      load() { return loaded; }
    };

    const first = ensureEmbeddedFont(doc);
    const second = ensureEmbeddedFont(doc);

    expect(added).toHaveLength(1);
    expect(first).toBe(loaded);
    expect(second).toBe(loaded);
    expect(added[0].name).toBe(FONT_FACE_NAME);
    expect(added[0].src).toContain("data:font/woff2;base64,");
    expect(added[0].opts.weight).toBe("400");
  });

  it("injects host UI CSS and applies Ace font options", () => {
    const doc = installDoc();
    doc.body.innerHTML = `<div id="editor" class="ace_editor"></div>`;
    const markers = [];
    class HostRange {
      constructor(startRow, startColumn, endRow, endColumn) {
        this.start = { row: startRow, column: startColumn };
        this.end = { row: endRow, column: endColumn };
      }
      clipRows() { return this; }
    }
    const editor = {
      container: doc.getElementById("editor"),
      session: {
        getLength: vi.fn(() => 1),
        getLine: vi.fn(() => 'hi("hello")'),
        getMarkers: vi.fn(() => ({
          9: { clazz: "ace_bracket", range: new HostRange(0, 2, 0, 3) },
        })),
        addMarker: vi.fn((range, cls, type, inFront) => {
          const id = markers.length + 1;
          markers.push({ id, range, cls, type, inFront });
          return id;
        }),
        removeMarker: vi.fn(),
      },
      getCursorPosition: vi.fn(() => ({ row: 0, column: 2 })),
      setOptions: vi.fn(),
      selection: { on: vi.fn() },
      on: vi.fn(),
      textInput: { getElement: vi.fn(() => doc.createElement("textarea")) },
      renderer: {
        setStyle: vi.fn(),
        $fontMetrics: { checkForSizeChanges: vi.fn(), setPolling: vi.fn() },
        updateFontSize: vi.fn(),
        onResize: vi.fn(),
        updateFull: vi.fn(),
      },
      resize: vi.fn(),
    };
    globalThis.ace = {
      edit: vi.fn(() => editor),
      require: vi.fn(() => null),
    };
    globalThis.vm = { $store: { state: { Editor: editor } } };

    const handle = installHostFontFix({ doc });
    handle.heal();

    const style = doc.getElementById("m3e-host-mono-font");
    expect(style.textContent).toContain(".aicg .message textarea");
    expect(style.textContent).toContain(".ace_editor");
    expect(style.textContent).toContain(".ace_text-input");
    expect(style.textContent).toContain(".ace_editor .m3e-ace-bracket");
    expect(style.textContent).toContain("rgb(192, 192, 192)");
    expect(style.textContent).toContain(".ace_editor .ace_cursor");
    expect(style.textContent).toContain("rgb(228, 228, 231)");
    expect(style.textContent).not.toContain("255, 153, 0");
    expect(style.textContent).toContain(FONT_FAMILY);
    expect(editor.setOptions).toHaveBeenCalledWith({ fontFamily: FONT_FAMILY });
    expect(editor.renderer.$fontMetrics.checkForSizeChanges).toHaveBeenCalled();
    expect(markers).toHaveLength(1);
    expect(markers.map((m) => m.cls)).toEqual(["m3e-ace-bracket"]);
    expect(markers.map((m) => m.inFront)).toEqual([true]);
    expect(markers.map((m) => m.range.start.column)).toEqual([10]);
    expect(editor.resize).toHaveBeenCalledWith(true);
  });

  it("fills whichever bracket side Ace did not mark natively", () => {
    const doc = installDoc();
    doc.body.innerHTML = `<div id="editor" class="ace_editor"></div>`;
    const markers = [];
    class HostRange {
      constructor(startRow, startColumn, endRow, endColumn) {
        this.start = { row: startRow, column: startColumn };
        this.end = { row: endRow, column: endColumn };
      }
      clipRows() { return this; }
    }
    const editor = {
      container: doc.getElementById("editor"),
      session: {
        getLength: vi.fn(() => 1),
        getLine: vi.fn(() => 'hi("hello")'),
        getMarkers: vi.fn(() => ({
          9: { clazz: "ace_bracket", range: new HostRange(0, 10, 0, 11) },
        })),
        addMarker: vi.fn((range, cls, type, inFront) => {
          const id = markers.length + 1;
          markers.push({ id, range, cls, type, inFront });
          return id;
        }),
        removeMarker: vi.fn(),
      },
      getCursorPosition: vi.fn(() => ({ row: 0, column: 2 })),
      setOptions: vi.fn(),
      selection: { on: vi.fn() },
      on: vi.fn(),
      textInput: { getElement: vi.fn(() => doc.createElement("textarea")) },
      renderer: {
        setStyle: vi.fn(),
        $fontMetrics: { checkForSizeChanges: vi.fn(), setPolling: vi.fn() },
        updateFontSize: vi.fn(),
        onResize: vi.fn(),
        updateFull: vi.fn(),
      },
      resize: vi.fn(),
    };
    globalThis.ace = { edit: vi.fn(() => editor), require: vi.fn(() => null) };
    globalThis.vm = { $store: { state: { Editor: editor } } };

    installHostFontFix({ doc });

    expect(markers).toHaveLength(1);
    expect(markers[0].cls).toBe("m3e-ace-bracket");
    expect(markers[0].range.start.column).toBe(2);
  });

  it("terminal fix covers xterm helper textarea and sets xterm options", () => {
    const doc = installDoc();
    doc.body.innerHTML = `<div id="term" style="width:160px;height:80px"></div>`;
    const term = {
      element: doc.getElementById("term"),
      options: {},
      _core: { _charSizeService: { width: 8, height: 16, measure: vi.fn() } },
      resize: vi.fn(),
      refresh: vi.fn(),
    };
    const vm = {
      $Terminal: function () {},
      $serial: { clearFn() {} },
      $store: {
        state: { term },
        commit: vi.fn(),
      },
    };

    const handle = installTerminalFix({ vm, doc });
    vi.advanceTimersByTime(250);
    handle.heal();

    const style = doc.getElementById("m3e-term-font");
    expect(style.textContent).toContain(".xterm-helper-textarea");
    expect(term.options.fontFamily).toBe(FONT_FAMILY);
    expect(term.resize).toHaveBeenCalled();
  });
});
