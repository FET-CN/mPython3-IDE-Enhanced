// src/host/run.mjs — Run the current program on the board and capture its serial/
// REPL output. All host access is confined here (anti-corruption layer).
//
// e2e probe (bun e2e/probe.mjs) confirmed the live site exposes Vuex mutations
// termWrite / terminalWrite / writePIP_Term (terminal output) and setPyRunState /
// setHasError (run state). Output capture is done by subscribing to the store;
// the run trigger is resolved against the IDE's run action / globals.
//
// NOTE: full implementation lands in Phase 5. This module currently provides the
// capability probe and a guarded runner so the run_code tool degrades gracefully.

/** True when a board is connected and a run entry is available. */
export function canRun(caps) {
  try {
    const st = caps?.state?.() || {};
    const ports = st.portList || st.devices || null;
    const connected = !!(st.connectName || (Array.isArray(ports) && ports.length));
    return connected && !!findRunTrigger(caps);
  } catch {
    return false;
  }
}

/**
 * Run the current program, collecting terminal output via store.subscribe.
 * @returns { ok, output, error }
 */
export async function runCurrent(caps, { timeout = 8000, signal, onOutput } = {}) {
  const trigger = findRunTrigger(caps);
  if (!trigger) return { ok: false, output: "", error: "未找到运行入口" };

  const store = caps.store;
  let output = "";
  let errored = false;
  let unsub = () => {};
  const OUT_MUTATIONS = new Set(["termWrite", "terminalWrite", "writePIP_Term"]);

  const done = new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; unsub(); resolve(); } };
    try {
      unsub = store.subscribe((mutation) => {
        if (OUT_MUTATIONS.has(mutation.type)) {
          const chunk = textOf(mutation.payload);
          if (chunk) { output += chunk; onOutput?.(chunk); }
        } else if (mutation.type === "setHasError" && mutation.payload) {
          errored = true;
        } else if (mutation.type === "setPyRunState" && !mutation.payload) {
          finish(); // run stopped
        }
      });
    } catch { /* subscribe unavailable */ }
    const t = setTimeout(finish, timeout);
    signal?.addEventListener?.("abort", finish, { once: true });
    if (t?.unref) t.unref();
  });

  try { trigger(); } catch (e) { unsub(); return { ok: false, output, error: String(e?.message || e) }; }
  await done;
  return { ok: !errored, output, error: errored ? "程序运行报错（详见输出）" : null };
}

/** Best-effort resolution of the IDE's "run" entry. Refined in Phase 5. */
function findRunTrigger(caps) {
  const win = caps?.win;
  if (win && typeof win.write === "function") return () => win.write();
  return null;
}

function textOf(payload) {
  if (payload == null) return "";
  if (typeof payload === "string") return payload;
  if (typeof payload === "object") return String(payload.text ?? payload.data ?? payload.msg ?? "");
  return String(payload);
}
