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
