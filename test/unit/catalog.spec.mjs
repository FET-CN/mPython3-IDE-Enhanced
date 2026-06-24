import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATA = resolve(ROOT, "data");
const META = resolve(DATA, "catalog.meta.json");

const built = existsSync(META);
const d = built ? describe : describe.skip;

function loadCatalog() {
  const meta = JSON.parse(readFileSync(META, "utf8"));
  const byType = new Map();
  for (const b of JSON.parse(readFileSync(resolve(DATA, "catalog.full.json"), "utf8"))) {
    byType.set(b.type, b);
  }
  return { meta, byType };
}

d("catalog integrity (requires `npm run build:catalog`)", () => {
  const { meta, byType } = loadCatalog();

  it("has a healthy block count", () => {
    expect(byType.size).toBeGreaterThan(3000);
  });

  it("resolves the vast majority of dropdowns", () => {
    const { dropdowns, dropdownsResolved } = meta.stats;
    expect(dropdownsResolved / dropdowns).toBeGreaterThan(0.95);
  });

  it("mpython_Interrupt_AB has DO statement slot + typed dropdowns", () => {
    const b = byType.get("mpython_Interrupt_AB");
    expect(b).toBeTruthy();
    expect(b.statements).toContain("DO");
    const button = b.fields.find((f) => f.name === "button");
    expect(button.enum.map((e) => e.value)).toEqual(["button_a", "button_b"]);
  });

  it("_1956_v2_all_pin is a Number value block with a pin dropdown", () => {
    const b = byType.get("_1956_v2_all_pin");
    expect(b.output).toBe("Number");
    const pin = b.fields.find((f) => f.name === "pin");
    expect(pin.enum.length).toBeGreaterThan(5);
  });

  it("core Blockly blocks are present and correct", () => {
    const cmp = byType.get("logic_compare");
    expect(cmp.output).toBe("Boolean");
    expect(cmp.fields[0].enum.map((e) => e.value)).toContain("EQ");
    expect(byType.get("math_number").output).toBe("Number");
    expect(byType.get("controls_if").statements).toContain("DO0");
    expect(byType.get("text").output).toBe("String");
  });

  it("every dropdown field that is resolved has at least one option", () => {
    for (const b of byType.values()) {
      for (const f of b.fields) {
        if (f.kind === "field_dropdown" && f.enum) {
          expect(f.enum.length, `${b.type}.${f.name}`).toBeGreaterThan(0);
        }
      }
    }
  });
});
