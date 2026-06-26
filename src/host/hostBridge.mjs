// src/host/hostBridge.mjs — Anti-corruption layer over the online.mpython.cn
// Vue/Vuex host. Detects the live surface (confirmed via e2e/probe.mjs):
//   window.vm.$store, mutations loadXMLCode/changeXmlCode/setTeachPyCode,
//   window.Blockly, store.state.{workspace,xmlCode,pyCode,modeSate}.
// Degrades gracefully if names shift after a bundle upgrade.

const WORKSPACE_SELECTORS = [".blocklyDiv", ".injectionDiv", ".codeArea", ".area-code"];

export function detectHost(win = globalThis.window, doc = globalThis.document) {
  const vm = win.vm;
  const store = vm && vm.$store;
  if (!store) {
    throw new Error("m3e: 未找到 window.vm.$store —— 站点结构可能已变。");
  }
  const muts = store._mutations || {};
  const has = (n) => !!muts[n];

  const caps = {
    win, doc, vm, store,
    Blockly: win.Blockly || null,
    mutations: {
      loadXMLCode: has("loadXMLCode"),
      changeXmlCode: has("changeXmlCode"),
      setTeachPyCode: has("setTeachPyCode"),
    },
    commit(name, payload) {
      return store.commit(name, payload);
    },
    state() {
      return store.state || {};
    },
    workspace() {
      return store.state && store.state.workspace;
    },
    workspaceEl() {
      for (const sel of WORKSPACE_SELECTORS) {
        const el = doc.querySelector(sel);
        if (el) return el;
      }
      return doc.getElementById("app") || doc.body;
    },
  };
  if (!caps.mutations.loadXMLCode) {
    caps.degraded = "缺少 loadXMLCode mutation，将降级直写 localStorage。";
  }
  return caps;
}

/** True if the workspace is in Python mode (modeSate truthy). */
export function isPythonMode(caps) {
  return !!(caps.state().modeSate);
}

/** True when the host site is in dark/night theme. The site stores this in the
 *  Vuex `state.nightSwitch` flag (mutation `changeNight`), confirmed via
 *  e2e/probe.mjs. Tolerates the flag being absent (older bundles) → light. */
export function isNight(caps) {
  return !!(caps.state().nightSwitch);
}

/** Subscribe to host theme changes. Calls `cb(isDark)` once immediately, then on
 *  every change. Primary signal is the Vuex store subscription (fires on the
 *  `changeNight` mutation); a slow poll backs it up in case the flag is mutated
 *  outside the store. Returns an unsubscribe function. */
export function watchNight(caps, cb) {
  let last = isNight(caps);
  const emit = () => { const now = isNight(caps); if (now !== last) { last = now; cb(now); } };
  let unsub = () => {};
  try { unsub = caps.store.subscribe(() => emit()) || (() => {}); } catch {}
  const timer = setInterval(emit, 1500);
  try { cb(last); } catch {}
  return () => { try { unsub(); } catch {} clearInterval(timer); };
}
