import { describe, it, expect } from "vitest";
import {
  parseSnippet,
  parseOutputType,
  discoverSlots,
  parseConnections,
} from "../../tools/lib/parseSnippet.mjs";

// Real (JSON-parsed, unescaped) snippets from the mPython block export.
const SNIP_INTERRUPT_AB =
  '["Blocks"]["mpython_Interrupt_AB"]={init:function(){this.jsonInit({inputsInline:!0,message0:Me["Msg"].mpython_Interrupt_AB_MESSAGE0,colour:"X"==Ye?ke.Event:ke.System,args0:[{options:T_,type:"field_dropdown",name:"button"},{options:[[Me["Msg"].mpython_IRQ_FALLING,"down"],[Me["Msg"].mpython_IRQ_RISING,"up"]],type:"field_dropdown",name:"action"}]}),this.appendStatementInput("DO").appendField(Me["Msg"].CONTROLS_REPEAT_INPUT_DO)}}';

const SNIP_ALL_PIN =
  '["Blocks"]["_1956_v2_all_pin"]={init:function(){this.jsonInit({inputsInline:!0,output:"Number",colour:ke.Pin,message0:Me["Msg"].ALL_PIN_MESSAGE0,args0:[{options:W_,type:"field_dropdown",name:"pin"}]})}}';

const SNIP_REPEAT_EXT =
  '["Blocks"]["controls_repeat_ext"]={init:function(){this.jsonInit({message0:Me["Msg"].CONTROLS_REPEAT_TITLE,args0:[{type:"input_value",name:"TIMES",check:"Number"}],previousStatement:null,nextStatement:null})}}';

const globalVars = new Map([
  ["T_", [{ label: "A", value: "button_a" }, { label: "B", value: "button_b" }]],
  ["W_", [{ label: "P0", value: "0" }, { label: "P1", value: "1" }]],
]);

describe("parseOutputType", () => {
  it("reads jsonInit output type", () => {
    expect(parseOutputType('x,output:"Number",y')).toBe("Number");
    expect(parseOutputType("x,output:null,y")).toBe("ANY");
  });
  it("reads imperative setOutput", () => {
    expect(parseOutputType('this.setOutput(!0,"String")')).toBe("String");
    expect(parseOutputType("this.setOutput(!0)")).toBe("ANY");
  });
  it("returns null when no output", () => {
    expect(parseOutputType("previousStatement:null")).toBeNull();
  });
});

describe("discoverSlots", () => {
  it("finds imperative appendStatementInput (missed by i18n)", () => {
    const s = discoverSlots(SNIP_INTERRUPT_AB);
    expect(s.statements).toContain("DO");
  });
  it("finds jsonInit input_value slots", () => {
    const s = discoverSlots(SNIP_REPEAT_EXT);
    expect(s.values).toContain("TIMES");
  });
});

describe("parseConnections", () => {
  it("detects previous/next from jsonInit", () => {
    expect(parseConnections(SNIP_REPEAT_EXT)).toEqual({ prev: true, next: true });
  });
  it("no connections for value block", () => {
    expect(parseConnections(SNIP_ALL_PIN)).toEqual({ prev: false, next: false });
  });
});

describe("parseSnippet end-to-end", () => {
  it("mpython_Interrupt_AB: DO slot + both dropdown enums", () => {
    const i18n = { fields: ["action", "button"], values: [], statements: [], output: false };
    const enr = parseSnippet(SNIP_INTERRUPT_AB, i18n, globalVars, null);
    expect(enr.statements).toContain("DO");
    const button = enr.fields.find((f) => f.name === "button");
    expect(button.enum.map((e) => e.value)).toEqual(["button_a", "button_b"]);
    const action = enr.fields.find((f) => f.name === "action");
    expect(action.enum.map((e) => e.value)).toEqual(["down", "up"]);
    expect(enr.outputType).toBeNull();
  });

  it("_1956_v2_all_pin: Number output + resolved var-ref pin enum", () => {
    const i18n = { fields: ["pin"], values: [], statements: [], output: true };
    const enr = parseSnippet(SNIP_ALL_PIN, i18n, globalVars, null);
    expect(enr.outputType).toBe("Number");
    const pin = enr.fields.find((f) => f.name === "pin");
    expect(pin.enum.map((e) => e.value)).toEqual(["0", "1"]);
  });

  it("controls_repeat_ext: TIMES value input with Number check", () => {
    const i18n = { fields: [], values: ["TIMES"], statements: [], output: false, previousStatement: true, nextStatement: true };
    const enr = parseSnippet(SNIP_REPEAT_EXT, i18n, globalVars, null);
    const times = enr.values.find((v) => v.name === "TIMES");
    expect(times.check).toBe("Number");
    expect(enr.prev).toBe(true);
    expect(enr.next).toBe(true);
  });
});
