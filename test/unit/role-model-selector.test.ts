import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { visibleWidth } from "@earendil-works/pi-tui";
import {
  movePickerIndex,
  pickerWindow,
  renderModelLine,
  renderRoleLine,
  roleSourceLabel,
  RoleModelPickerComponent,
  RoleModelSubmenu,
  type PickableRole,
  type RoleModelItem,
} from "../../src/slash/role-model-selector.ts";

const theme = {
  fg(_name: string, text: string): string {
    return text;
  },
  bold(text: string): string {
    return text;
  },
};

const roles: PickableRole[] = [
  {
    name: "investigator",
    description: "Untersucht einen unbekannten Repository-Bereich.",
    source: "project",
    currentModel: "openai/gpt-5",
  },
  {
    name: "verifier",
    description: "Prüft eine risikoreiche Umsetzung unabhängig.",
    source: "builtin",
  },
];

const models: RoleModelItem[] = [
  { value: "openai/gpt-5", provider: "openai", id: "gpt-5" },
  { value: "anthropic/sonnet", provider: "anthropic", id: "sonnet" },
];

describe("role model selector rendering", () => {
  it("uses readable labels for every role source", () => {
    assert.equal(roleSourceLabel("builtin"), "Integriert");
    assert.equal(roleSourceLabel("package"), "Paket");
    assert.equal(roleSourceLabel("user"), "Benutzer");
    assert.equal(roleSourceLabel("project"), "Projekt");
  });

  it("keeps the focused item inside a bounded list window", () => {
    assert.deepEqual(pickerWindow(12, 9, 5), { start: 7, end: 12 });
    assert.deepEqual(pickerWindow(3, 1, 8), { start: 0, end: 3 });
    assert.deepEqual(pickerWindow(0, 0, 5), { start: 0, end: 0 });
  });

  it("wraps keyboard movement and rejects empty lists", () => {
    assert.equal(movePickerIndex(0, -1, 3), 2);
    assert.equal(movePickerIndex(2, 1, 3), 0);
    assert.equal(movePickerIndex(0, 1, 0), -1);
  });

  it("marks selection and existing models without relying on color", () => {
    assert.match(renderRoleLine(theme as any, roles[0]!, true), /▌.*● MODELL/);
    assert.match(renderRoleLine(theme as any, roles[1]!, false), /○ STANDARD/);
    assert.match(
      renderModelLine(theme as any, models[0]!, true, true),
      /▌.*\[openai\].*● AKTUELL/,
    );
  });

  it("uses arrow, Enter and Escape in the model submenu", () => {
    let selected: string | undefined = "not-called";
    const submenu = new RoleModelSubmenu(
      theme as any,
      roles[0]!.name,
      roles[0]!.description,
      models,
      roles[0]!.currentModel ?? "",
      (value) => {
        selected = value;
      },
    );
    submenu.handleInput("\u001b[B");
    submenu.handleInput("\r");
    assert.equal(selected, "anthropic/sonnet");

    const cancelled = new RoleModelSubmenu(
      theme as any,
      roles[0]!.name,
      roles[0]!.description,
      models,
      roles[0]!.currentModel ?? "",
      (value) => {
        selected = value;
      },
    );
    cancelled.handleInput("\u001b");
    assert.equal(selected, undefined);
  });

  it("renders both picker levels within narrow and wide overlays", () => {
    const picker = new RoleModelPickerComponent(
      { requestRender() {} } as any,
      theme as any,
      roles,
      models,
      "/workspace",
      () => {},
    );
    const submenu = new RoleModelSubmenu(
      theme as any,
      roles[0]!.name,
      roles[0]!.description,
      models,
      roles[0]!.currentModel ?? "",
      () => {},
    );

    for (const width of [30, 52, 90]) {
      for (const lines of [picker.render(width), submenu.render(width)]) {
        assert(lines.every((line) => visibleWidth(line) <= width));
      }
    }
    assert.match(picker.render(90).join("\n"), /ROLLEN-MODELLE/);
    assert.match(submenu.render(90).join("\n"), /MODELLE › investigator/);
  });
});
