// src/host/read.mjs — Read the current workspace as XML/IR and the generated
// Python. Prefers live Blockly serialization (window.Blockly is available),
// falling back to Vuex state then localStorage.

import { decompile } from "../xml/decompile.mjs";

/** Serialize the current workspace to Blockly XML text. */
export function readWorkspaceXml(caps) {
  const B = caps.Blockly;
  const ws = caps.workspace();
  if (B && ws && B.Xml) {
    try {
      return B.Xml.domToText(B.Xml.workspaceToDom(ws));
    } catch (e) {
      /* fall through */
    }
  }
  const st = caps.state();
  if (typeof st.xmlCode === "string" && st.xmlCode.length) return st.xmlCode;
  const ls = caps.win.localStorage;
  // localStorage.blocklys is a JSON array of {…, xml?}; best-effort.
  return ls.mPyXml || ls.pyXml || "";
}

/** Current workspace as IR (Program). Empty array if unreadable. */
export function readWorkspaceIR(caps) {
  const xml = readWorkspaceXml(caps);
  if (!xml || !/<block/i.test(xml)) return [];
  try {
    return decompile(xml, { DOMParser: caps.win.DOMParser });
  } catch {
    return [];
  }
}

/** Generated Python text, if any. */
export function readPyCode(caps) {
  const st = caps.state();
  if (typeof st.pyCode === "string" && st.pyCode.length) return st.pyCode;
  return caps.win.localStorage.pyCode || "";
}
