// eval/run-eval.mjs — T3 LLM eval. Runs the full generation pipeline over a set
// of Chinese NL tasks and reports a pass rate (validator-clean + compiles).
// Requires a real OpenAI-compatible endpoint:
//   M3E_API_KEY=... [M3E_BASE_URL=https://api.deepseek.com/v1] [M3E_MODEL=deepseek-chat] bun eval/run-eval.mjs
//
// This measures LLM output quality; the deterministic layers are covered by unit
// tests, and live injection by e2e/inject.e2e.mjs.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogFromArray } from "../src/xml/validate.mjs";
import { makeClient } from "../src/llm/client.mjs";
import { generateProgram } from "../src/pipeline.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const D = (p) => JSON.parse(readFileSync(resolve(ROOT, "dist", p), "utf8"));

const cfg = {
  baseURL: process.env.M3E_BASE_URL || "https://api.deepseek.com/v1",
  apiKey: process.env.M3E_API_KEY,
  model: process.env.M3E_MODEL || "deepseek-chat",
};
if (!cfg.apiKey) {
  console.error("需要 M3E_API_KEY 环境变量 (OpenAI 兼容端点)。");
  process.exit(2);
}

const data = {
  index: D("catalog.index.json"),
  catalog: catalogFromArray(D("catalog.full.json")),
  seeds: D("fewshot-seeds.json").seeds,
  knowledge: {
    core: D("knowledge/core.json"),
    antipatterns: D("knowledge/antipatterns.json"),
    triggers: D("knowledge/triggers.json"),
    loadDoc: (name) => { try { return readFileSync(resolve(ROOT, "dist/knowledge", name), "utf8"); } catch { return ""; } },
  },
};
const tasks = JSON.parse(readFileSync(resolve(ROOT, "eval/tasks.json"), "utf8")).tasks;
const client = makeClient(cfg);

const main = async () => {
  const rows = [];
  let pass = 0;
  for (const t of tasks) {
    process.stderr.write(`[eval] ${t.id}… `);
    try {
      const res = await generateProgram({
        request: t.request, mode: "replace",
        index: data.index, catalog: data.catalog, seeds: data.seeds,
        knowledge: data.knowledge, currentProgram: [], client, maxRepairs: 2,
      });
      const ok = res.ok;
      if (ok) pass++;
      rows.push({ id: t.id, ok, attempts: res.attempts, errors: (res.report?.errors || []).length });
      console.error(ok ? `PASS (${res.attempts} 次)` : `FAIL (${res.report?.errors?.length} 处)`);
    } catch (e) {
      rows.push({ id: t.id, ok: false, error: e.message });
      console.error("ERROR " + e.message);
    }
  }
  const rate = ((pass / tasks.length) * 100).toFixed(0);
  const md = [
    `# T3 Eval 报告`,
    `模型: ${cfg.model} @ ${cfg.baseURL}`,
    `通过率: **${pass}/${tasks.length} (${rate}%)**`,
    ``,
    `| 任务 | 通过 | 尝试次数 | 残留错误 |`,
    `|---|---|---|---|`,
    ...rows.map((r) => `| ${r.id} | ${r.ok ? "✅" : "❌"} | ${r.attempts ?? "-"} | ${r.errors ?? r.error ?? "-"} |`),
  ].join("\n");
  writeFileSync(resolve(ROOT, "eval/report.md"), md);
  console.error(`\n[eval] 通过率 ${pass}/${tasks.length} (${rate}%) → eval/report.md`);
};

main();
