// test/helpers/microFs.mjs — 内存版 MicroPython 文件系统 + REPL 命令求值器（测试替身）。
//
// filePanel.mjs 经串口代理 exec 向板子发**单行** REPL 命令（chr(2)/chr(3) 哨兵框定 print 输出）。
// 这里用纯 JS 在内存里模拟 os.ilistdir/open/read/write/mkdir/remove/rmdir/rename 的语义，
// 并按 filePanel 生成的命令文本求值、返回**哨兵之间**那段 payload 字符串（exec 的返回值）。
//
// 共用于：① T0 单测（exec 字符串层 mock）；② e2e 假设备（WS 字节层 server，见 e2e/helpers/fakeDevice.mjs）。
// 二者跑的是**同一套命令协议**，故假设备仿真过的就是真板要跑的。

const FILE = 0x8000; // MicroPython os.stat type：普通文件
const DIR = 0x4000; //  目录

function norm(p) { return !p ? "/" : (p.startsWith("/") ? p : "/" + p).replace(/\/+/g, "/").replace(/(.)\/$/, "$1"); }
function parent(p) { const i = p.lastIndexOf("/"); return i <= 0 ? "/" : p.slice(0, i); }
function base(p) { return p.slice(p.lastIndexOf("/") + 1); }
/** Python repr 风格的单引号字符串转义。 */
function pyRepr(s) { return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'"; }

export function makeMicroFs(seed = {}) {
  const dirs = new Set(["/"]);
  const files = new Map(); // 完整路径 → Uint8Array
  // 播种：{ "/main.py": "print(1)", "/lib": null(目录) }
  for (const [p, v] of Object.entries(seed)) {
    const np = norm(p);
    if (v === null) dirs.add(np);
    else files.set(np, v instanceof Uint8Array ? v : new TextEncoder().encode(String(v)));
  }

  const isDir = (p) => dirs.has(norm(p));
  const exists = (p) => dirs.has(norm(p)) || files.has(norm(p));

  function ilistdir(p) {
    const dir = norm(p);
    const out = [];
    const seen = new Set();
    const add = (full, type) => { const n = base(full); if (parent(full) === dir && !seen.has(n)) { seen.add(n); out.push([n, type]); } };
    for (const f of files.keys()) add(f, FILE);
    for (const d of dirs) if (d !== "/") add(d, DIR);
    return out;
  }

  // 求值一条 filePanel 命令文本 → payload 字符串；非本协议命令返回 null（假设备据此忽略站点其它流量）。
  function exec(text) {
    let m;
    // 列目录
    if ((m = text.match(/ilistdir\('((?:[^'\\]|\\.)*)'\)/))) {
      const entries = ilistdir(unescPy(m[1]));
      return "[" + entries.map(([n, t]) => "(" + pyRepr(n) + ", " + t + ")").join(", ") + "]";
    }
    // 读文件（b2a_base64(open(...,'rb').read())）
    if ((m = text.match(/open\('((?:[^'\\]|\\.)*)','rb'\)/))) {
      const p = norm(unescPy(m[1]));
      const bytes = files.get(p);
      if (!bytes) throw new Error("ENOENT " + p);
      return Buffer.from(bytes).toString("base64") + "\n"; // b2a_base64 末尾带换行
    }
    // 写一块
    if ((m = text.match(/open\('((?:[^'\\]|\\.)*)',('wb'|'ab')\);f\.write\(.*?a2b_base64\('([^']*)'\)\)/))) {
      const p = norm(unescPy(m[1]));
      const append = m[2] === "'ab'";
      const chunk = new Uint8Array(Buffer.from(m[3], "base64"));
      const prev = append && files.get(p) ? files.get(p) : new Uint8Array(0);
      const merged = new Uint8Array(prev.length + chunk.length);
      merged.set(prev, 0); merged.set(chunk, prev.length);
      files.set(p, merged);
      return "OK";
    }
    if ((m = text.match(/\.mkdir\('((?:[^'\\]|\\.)*)'\)/))) { dirs.add(norm(unescPy(m[1]))); return "OK"; }
    if ((m = text.match(/\.remove\('((?:[^'\\]|\\.)*)'\)/))) {
      const p = norm(unescPy(m[1])); if (!files.delete(p)) throw new Error("ENOENT " + p); return "OK";
    }
    if ((m = text.match(/\.rmdir\('((?:[^'\\]|\\.)*)'\)/))) {
      const p = norm(unescPy(m[1])); if (!dirs.delete(p)) throw new Error("ENOTDIR " + p); return "OK";
    }
    if ((m = text.match(/\.rename\('((?:[^'\\]|\\.)*)','((?:[^'\\]|\\.)*)'\)/))) {
      const a = norm(unescPy(m[1])), b = norm(unescPy(m[2]));
      if (files.has(a)) { files.set(b, files.get(a)); files.delete(a); }
      else if (dirs.has(a)) { dirs.delete(a); dirs.add(b); }
      else throw new Error("ENOENT " + a);
      return "OK";
    }
    return null; // 非本协议
  }

  return { exec, isDir, exists, files, dirs, ilistdir,
    readText: (p) => new TextDecoder().decode(files.get(norm(p)) || new Uint8Array(0)) };
}

function unescPy(s) { return s.replace(/\\(.)/g, "$1"); }
