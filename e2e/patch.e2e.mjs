// e2e/patch.e2e.mjs — Real-host regression gate for the surgical patch fix.
//
// Proves on the LIVE online.mpython.cn Blockly that an unrelated edit no longer
// wipes 内置图像 (mpython_pbm_image) shadows on untouched blocks:
//   1. seed a workspace that contains a `mpython_pbm_image` shadow (as the live
//      toolbox does: inside mpython_get_pbm_data's file_path input)
//   2. read the workspace back via REAL Blockly serialization → `base`
//   3. OLD path  = compile(decompile(base))   → loses the shadow   (the bug)
//      NEW path  = patchOps(base, [insert …]) → keeps the shadow   (the fix)
//   4. load the patched XML back into real Blockly and assert the shadow + its
//      pbm `path` survived AND the inserted block is present, no unknown blocks.
//
// Run: bun e2e/patch.e2e.mjs   (authorized headless visit, read-only, no account)

import { chromium } from "playwright";
import { DOMParser } from "linkedom";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../src/xml/compile.mjs";
import { decompile } from "../src/xml/decompile.mjs";
import { patchOps } from "../src/xml/patch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, "out");
mkdirSync(OUT, { recursive: true });
const URL = process.env.M3E_URL || "https://online.mpython.cn/";

const catalog = new Map(
  JSON.parse(readFileSync(resolve(HERE, "../data/catalog.full.json"), "utf8")).map((b) => [b.type, b]),
);

const NS = "https://developers.google.com/blockly/xml";
// Seed: a pbm-image shadow inside mpython_get_pbm_data (the toolbox's own pairing,
// guaranteed accepted by the live Blockly), plus an unrelated text_print stack.
const SEED_XML =
  `<xml xmlns="${NS}">` +
  `<block type="mpython_get_pbm_data" x="40" y="40">` +
  `<value name="file_path"><shadow type="mpython_pbm_image"><field name="path">face/3.pbm</field></shadow></value>` +
  `</block>` +
  `<block type="text_print" x="40" y="220"><value name="TEXT"><shadow type="text"><field name="TEXT">hi</field></shadow></value></block>` +
  `</xml>`;

// The "unrelated edit": add a brand-new top-level stack. Must NOT disturb the
// existing image shadow.
const OPS = [{ op: "insert", anchor: { at: "new" }, blocks: [{ type: "mpython_display_Show" }] }];

const assert = (cond, msg) => { if (!cond) throw new Error("ASSERT FAILED: " + msg); };
const hasImg = (xml) => /<shadow type="mpython_pbm_image"/.test(xml);
const hasPath = (xml) => /face\/3\.pbm/.test(xml);

const main = async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 200)); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message.slice(0, 200)));

  const report = {};
  try {
    await page.goto(URL, { waitUntil: "commit", timeout: 90000 });
    await page.waitForFunction(() => !!(window.vm && window.vm.$store), null, { timeout: 90000 });
    await page.waitForTimeout(5000);

    const surface = await page.evaluate(() => ({
      hasLoadXMLCode: !!(window.vm.$store._mutations && window.vm.$store._mutations.loadXMLCode),
      hasWorkspace: !!(window.vm.$store.state && window.vm.$store.state.workspace),
    }));
    assert(surface.hasLoadXMLCode && surface.hasWorkspace, "host surface present");

    // 1+2. seed, then read the workspace back the SAME way production does
    //      (read.mjs falls back to store.state.xmlCode — the live page exposes no
    //      window.Blockly.Xml). This field is a real re-serialization of the live
    //      workspace, and it preserves the image shadow.
    const seeded = await page.evaluate((xml) => {
      const store = window.vm.$store;
      store.commit("loadXMLCode", { title: "m3e-seed", xmlCode: xml, notClear: false });
      const ws = store.state.workspace;
      return { back: store.state.xmlCode || "", types: ws.getAllBlocks(false).map((b) => b.type) };
    }, SEED_XML);
    report.base = seeded.back;
    assert(hasImg(seeded.back), "seed: live re-serialized workspace contains the pbm_image shadow");

    // 3. compute OLD vs NEW transformations of the real base in Node
    const oldXml = compile(decompile(seeded.back, { DOMParser }), { catalog });
    const patched = patchOps(seeded.back, OPS, { catalog, DOMParser });
    report.oldHadImage = hasImg(oldXml);
    report.patchOk = patched.ok;
    report.patchErrors = patched.errors;
    assert(patched.ok, "patchOps applied cleanly: " + JSON.stringify(patched.errors));
    // the regression contrast: the legacy round-trip drops the shadow…
    assert(!hasImg(oldXml), "OLD compile(decompile(base)) DROPS the pbm_image shadow (the bug)");
    // …our surgical patch keeps it.
    assert(hasImg(patched.xml) && hasPath(patched.xml), "NEW patchOps KEEPS the shadow + pbm path");

    // 4. load the patched XML into the real app and verify it survives the reload
    const final = await page.evaluate((xml) => {
      const store = window.vm.$store;
      store.commit("loadXMLCode", { title: "m3e-patched", xmlCode: xml, notClear: false });
      const ws = store.state.workspace;
      const blocks = ws.getAllBlocks(false);
      return {
        types: blocks.map((b) => b.type),
        unknown: blocks.filter((b) => !b.type || b.type === "unknown").map((b) => b.type),
        xmlBack: store.state.xmlCode || "",
      };
    }, patched.xml);
    report.finalTypes = [...new Set(final.types)];

    await page.waitForTimeout(600);
    await page.screenshot({ path: resolve(OUT, "patch-e2e.png") });

    assert(hasImg(final.xmlBack) && hasPath(final.xmlBack), "after reload: live workspace still has shadow + pbm path");
    assert(final.types.includes("mpython_display_Show"), "after reload: the inserted block is present");
    assert(final.types.includes("mpython_get_pbm_data"), "after reload: the image-bearing block survived");
    assert(final.types.includes("text_print"), "after reload: the other untouched stack survived");
    assert(final.unknown.length === 0, "after reload: no unknown blocks (got " + final.unknown.join(",") + ")");

    console.log("[patch-e2e] PASS — image shadow preserved through real Blockly round-trip.");
    console.log("           OLD path had image:", report.oldHadImage, "| NEW path ok:", report.patchOk);
    console.log("           final blocks:", report.finalTypes.join(", "));
    writeFileSync(resolve(OUT, "patch-e2e.json"), JSON.stringify({ ok: true, surface, report, errors }, null, 2));
    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error("[patch-e2e] FAIL —", e.message);
    writeFileSync(resolve(OUT, "patch-e2e.json"), JSON.stringify({ ok: false, error: e.message, report, errors }, null, 2));
    await browser.close().catch(() => {});
    process.exit(1);
  }
};

main();
