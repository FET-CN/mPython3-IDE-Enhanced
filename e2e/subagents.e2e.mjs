// e2e/subagents.e2e.mjs — Local, deterministic SubAgent manager + modern UI smoke.
// It serves the real source modules into Chromium and uses a scripted child
// runner, so this test needs neither online.mpython.cn nor an LLM API key.

import { chromium } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "http://m3e.local";

const mime = (path) => {
  if (path.endsWith(".mjs") || path.endsWith(".js")) return "text/javascript";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".json")) return "application/json";
  return "text/plain";
};

const HARNESS = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>SubAgent E2E</title></head>
<body>
<script type="module">
import { createSubagentManager } from "/src/agent/subagents.mjs";
import { createPanelModern } from "/src/ui/panelModern.mjs";

const waitUntil = async (predicate, timeout = 2000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("harness condition timed out");
};

let manager;
const panel = createPanelModern({
  onStopAgent: (id) => manager.stop(id),
});

const runner = async ({ messages, signal }) => {
  const prompt = messages.filter((message) => message.role === "user").at(-1)?.content || "";
  if (prompt.includes("保持运行")) {
    await new Promise((resolve) => {
      const finish = () => resolve();
      window.__releaseRunningAgent = finish;
      if (signal.aborted) finish();
      else signal.addEventListener("abort", finish, { once: true });
    });
    if (signal.aborted) return { stopped: "aborted", final: "", steps: 1 };
  }
  if (prompt.includes("故意失败")) throw new Error("脚本化预期失败");
  const final = prompt.includes("立即完成") ? "脚本化完成报告" : "脚本化运行报告";
  messages.push({ role: "assistant", content: final });
  return { stopped: "done", final, steps: 1 };
};

manager = createSubagentManager({
  client: { id: "scripted-client" },
  runner,
  onChange: (tasks) => panel.setAgents(tasks),
});

const completed = await manager.spawn({
  name: "completed-agent",
  description: "已完成任务",
  prompt: "立即完成",
  agent_type: "explore",
  run_in_background: true,
});
await waitUntil(() => manager.get(completed.id).status === "completed");

const failed = await manager.spawn({
  name: "failed-agent",
  description: "失败任务",
  prompt: "故意失败",
  agent_type: "review",
  run_in_background: true,
});
await waitUntil(() => manager.get(failed.id).status === "failed");

const running = await manager.spawn({
  name: "running-agent",
  description: "运行中任务",
  prompt: "保持运行",
  agent_type: "plan",
  run_in_background: true,
});
await waitUntil(() => typeof window.__releaseRunningAgent === "function");
panel.openAgents("running-agent");

window.__subagentHarness = { manager, panel, ids: { completed: completed.id, failed: failed.id, running: running.id } };
window.__subagentReady = true;
</script>
</body>
</html>`;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function snapshot(page) {
  return page.evaluate(() => {
    const root = document.getElementById("m3e-panel-host")?.shadowRoot;
    const section = root?.querySelector("[data-agents]");
    const head = root?.querySelector("[data-agents-head]");
    const list = root?.querySelector("[data-agents-list]");
    return {
      mounted: !!root,
      sectionHidden: section?.classList.contains("hidden") ?? true,
      expanded: head?.getAttribute("aria-expanded"),
      listHidden: list?.classList.contains("hidden") ?? true,
      summary: root?.querySelector("[data-agents-summary]")?.textContent || "",
      rows: [...(root?.querySelectorAll("[data-agent-task]") || [])].map((row) => ({
        id: row.dataset.agentId,
        name: row.dataset.agentName,
        status: row.dataset.agentStatus,
        active: row.dataset.agentActive === "true",
        text: row.textContent.replace(/\s+/g, " ").trim(),
        hasStop: !!row.querySelector("[data-agent-stop]"),
        duration: row.querySelector("[data-agent-duration]")?.textContent || "",
      })),
    };
  });
}

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 960, height: 760 } });
const errors = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push("pageerror: " + error.message));

await page.route(`${BASE}/**`, async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname === "/") {
    await route.fulfill({ status: 200, contentType: "text/html", body: HARNESS });
    return;
  }
  const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const file = resolve(ROOT, relative);
  if (!file.startsWith(ROOT + "/") || !existsSync(file)) {
    await route.fulfill({ status: 404, body: "not found" });
    return;
  }
  await route.fulfill({ status: 200, contentType: mime(file), body: readFileSync(file) });
});

try {
  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 15000 });
  await page.waitForFunction(() => window.__subagentReady === true, null, { timeout: 15000 });

  const before = await snapshot(page);
  const completed = before.rows.find((row) => row.name === "completed-agent");
  const failed = before.rows.find((row) => row.name === "failed-agent");
  const running = before.rows.find((row) => row.name === "running-agent");
  assert(before.mounted && !before.sectionHidden, "SubAgent task bar did not mount");
  assert(before.expanded === "true" && !before.listHidden, "/agents-style expansion did not open the task list");
  assert(before.summary.includes("1 个运行中") && before.summary.includes("共 3 个"), "task summary is incorrect");
  assert(completed?.status === "completed" && completed.text.includes("脚本化完成报告"), "completed result was not rendered");
  assert(failed?.status === "failed" && failed.text.includes("脚本化预期失败"), "failure detail was not rendered");
  assert(running?.status === "running" && running.hasStop && running.active, "running task controls or selection are missing");
  assert(/秒|分|时/.test(running.duration), "running duration was not rendered");

  const unknownTarget = await page.evaluate(() => window.__subagentHarness.panel.openAgents("missing-agent"));
  assert(unknownTarget === false, "openAgents should reject an unknown task target");
  await page.evaluate(() => window.__subagentHarness.panel.openAgents("running-agent"));
  await page.evaluate(() => {
    const root = document.getElementById("m3e-panel-host").shadowRoot;
    root.querySelector("[data-agent-name='running-agent'] [data-agent-stop]")?.click();
  });
  await page.waitForFunction(() => window.__subagentHarness.manager.get("running-agent").status === "killed");

  const stopped = await snapshot(page);
  const killed = stopped.rows.find((row) => row.name === "running-agent");
  assert(stopped.summary.includes("0 个运行中"), "summary did not update after stop");
  assert(killed?.status === "killed" && !killed.hasStop && killed.text.includes("已停止"), "stop control did not update the row");

  await page.evaluate(() => {
    const root = document.getElementById("m3e-panel-host").shadowRoot;
    root.querySelector("[data-agents-head]")?.click();
  });
  const collapsed = await snapshot(page);
  assert(collapsed.expanded === "false" && collapsed.listHidden, "task list did not collapse");

  await page.evaluate(() => window.__subagentHarness.manager.clear());
  const cleared = await snapshot(page);
  assert(cleared.sectionHidden && cleared.rows.length === 0, "clear did not remove the task bar state");
  assert(errors.length === 0, `browser errors: ${errors.join(" | ")}`);

  console.log("RESULT:", JSON.stringify({ before, stopped, collapsed, cleared }, null, 2));
  console.log("[subagents] PASS — local manager + modern task bar smoke completed");
} catch (error) {
  console.error("[subagents] ERROR:", error.message);
  if (errors.length) console.log("BROWSER ERRORS:", errors);
  process.exitCode = 1;
} finally {
  await browser.close();
}
