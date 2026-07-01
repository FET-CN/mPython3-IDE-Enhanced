// src/ui/panelModern.entry.mjs — 打包入口，供 tools/build-bookmarklet.mjs 产出 dist/modern.min.js（IIFE）。
// modern 主题资产（面板 + 预编译 CSS + 内嵌字体 + Micro 图标）在此聚合。主包（main.min.js）默认 classic、
// 零 modern 负担；仅当用户选中 modern 时，才用 <script src=base/modern.min.js> 懒加载本包，加载后从
// globalThis.__m3eModern.createPanelModern 取工厂（与书签 loader 注入主包的模式一致，避免 IIFE 内动态 import）。
import { createPanelModern } from "./panelModern.mjs";

try { globalThis.__m3eModern = { createPanelModern }; } catch {}

export { createPanelModern };
