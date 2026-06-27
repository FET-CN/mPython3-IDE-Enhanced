// src/host/lock.mjs — Hard-lock the workspace during AI edits. Since Blockly's
// readOnly can't be toggled live, we overlay an event-swallowing scrim over the
// workspace, swallow keyboard shortcuts, and run a small state machine. Auto
// unlocks on timeout as a safety net.

const SCRIM_ID = "m3e-workspace-lock";

export function createLock(caps, opts = {}) {
  const doc = caps.doc;
  const win = caps.win;
  let state = "idle"; // idle | locked
  let scrim = null;
  let tagEl = null;
  let frozen = false;
  let ro = null;
  let timer = null;
  let keyHandler = null;

  function place() {
    if (!scrim) return;
    const el = caps.workspaceEl();
    const r = el.getBoundingClientRect();
    Object.assign(scrim.style, {
      top: `${r.top + win.scrollY}px`,
      left: `${r.left + win.scrollX}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
  }

  function lock(label = "AI 正在修改积木…请勿编辑") {
    if (state === "locked") return;
    state = "locked";
    scrim = doc.createElement("div");
    scrim.id = SCRIM_ID;
    Object.assign(scrim.style, {
      position: "absolute",
      zIndex: "2147483000",
      background: "rgba(20,28,40,0.35)",
      backdropFilter: "blur(0.5px)",
      cursor: "progress",
      display: "flex",
      alignItems: "flex-start",
      justifyContent: "center",
    });
    const tag = doc.createElement("div");
    tag.textContent = label;
    tagEl = tag;
    Object.assign(tag.style, {
      marginTop: "12px",
      padding: "6px 14px",
      borderRadius: "16px",
      background: "rgba(0,0,0,0.7)",
      color: "#fff",
      font: "13px/1.4 system-ui, sans-serif",
      pointerEvents: "none",
    });
    scrim.appendChild(tag);
    // swallow all pointer events on the scrim
    for (const ev of ["click", "mousedown", "mouseup", "wheel", "touchstart", "contextmenu"]) {
      scrim.addEventListener(ev, (e) => { e.stopPropagation(); e.preventDefault(); }, { passive: false });
    }
    doc.body.appendChild(scrim);
    place();
    if (win.ResizeObserver) {
      ro = new win.ResizeObserver(place);
      ro.observe(caps.workspaceEl());
    }
    win.addEventListener("resize", place);
    // swallow Blockly keyboard shortcuts (delete/undo/etc) while locked
    keyHandler = (e) => {
      const t = e.target;
      const inPanel = t && t.closest && t.closest("#m3e-panel-host");
      if (!inPanel) { e.stopPropagation(); }
    };
    doc.addEventListener("keydown", keyHandler, true);

    timer = win.setTimeout(() => unlock(), opts.timeoutMs || 120000);
  }

  // Temporarily make the (already-present) scrim fully opaque so the workspace
  // behind it can be mutated invisibly — used by the edit preview, which injects
  // the post-edit XML to screenshot the real Blockly SVG, then restores it. The
  // scrim swallows the flicker; without it the user would see the workspace flash
  // to the edited state and back. No-op if the lock isn't currently held.
  function freeze() {
    if (state !== "locked" || !scrim || frozen) return false;
    frozen = true;
    scrim.style.background = win.getComputedStyle?.(doc.body)?.backgroundColor || "#1b2330";
    scrim.style.backdropFilter = "blur(6px)";
    if (tagEl) tagEl.style.visibility = "hidden";
    return true;
  }
  function unfreeze() {
    if (!scrim || !frozen) { frozen = false; return; }
    frozen = false;
    scrim.style.background = "rgba(20,28,40,0.35)";
    scrim.style.backdropFilter = "blur(0.5px)";
    if (tagEl) tagEl.style.visibility = "";
  }

  function unlock() {
    if (state === "idle") return;
    state = "idle";
    frozen = false;
    tagEl = null;
    if (timer) { win.clearTimeout(timer); timer = null; }
    if (ro) { ro.disconnect(); ro = null; }
    win.removeEventListener("resize", place);
    if (keyHandler) { doc.removeEventListener("keydown", keyHandler, true); keyHandler = null; }
    if (scrim && scrim.parentNode) scrim.parentNode.removeChild(scrim);
    scrim = null;
  }

  return { lock, unlock, freeze, unfreeze, get state() { return state; }, get isLocked() { return state === "locked"; } };
}
