import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  getSelectListTheme,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  SelectList,
  SettingsList,
  Spacer,
  Text,
  type Component,
  type SelectItem,
  type SettingItem,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  discoverAgentsAll,
  getProjectAgentSettingsPath,
  getUserAgentSettingsPath,
  mergeBuiltinAgentOverride,
  readSubagentSettings,
  type AgentConfig,
  type AgentSource,
} from "../agents/agents.ts";
import type { ModelScopeConfig } from "../runs/shared/model-scope.ts";
import { matchesScopePattern } from "../runs/shared/model-scope.ts";
import { toModelInfo, type ModelInfo } from "../shared/model-info.ts";
import { SLASH_TEXT_RESULT_TYPE } from "../shared/types.ts";

export interface PickableRole {
  name: string;
  description: string;
  source: AgentSource;
  currentModel?: string;
}

const AGENT_SOURCE_PRECEDENCE: Record<AgentSource, number> = {
  builtin: 0,
  package: 1,
  user: 2,
  project: 3,
};

/**
 * Dedupe across all four discovery sources by name (project > user > package >
 * builtin, matching pickEffectiveAgent's precedence), then drop disabled roles
 * (discoverAgentsAll does not filter those itself, unlike discoverAgents).
 */
export function listPickableRoles(cwd: string): PickableRole[] {
  const d = discoverAgentsAll(cwd);
  const all: AgentConfig[] = [
    ...d.builtin,
    ...d.package,
    ...d.user,
    ...d.project,
  ];
  const byName = new Map<string, AgentConfig>();
  for (const agent of all) {
    const existing = byName.get(agent.name);
    if (
      !existing ||
      AGENT_SOURCE_PRECEDENCE[agent.source] >
        AGENT_SOURCE_PRECEDENCE[existing.source]
    ) {
      byName.set(agent.name, agent);
    }
  }
  return [...byName.values()]
    .filter((a) => a.disabled !== true)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((a) => ({
      name: a.name,
      description: a.description,
      source: a.source,
      currentModel: a.model,
    }));
}

function resolveModelScope(cwd: string): ModelScopeConfig | undefined {
  const userSettings = readSubagentSettings(getUserAgentSettingsPath());
  const projectSettings = readSubagentSettings(
    getProjectAgentSettingsPath(cwd),
  );
  return projectSettings.modelScope ?? userSettings.modelScope;
}

/** Runtime-available models, narrowed to subagents.modelScope.allow when enforced. */
export function buildModelItems(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  cwd: string,
): SelectItem[] {
  const scope = resolveModelScope(cwd);
  const models: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
  const filtered =
    scope?.enforce && scope.allow?.length
      ? models.filter((m) =>
          scope.allow!.some((pattern) =>
            matchesScopePattern(m.fullId, pattern),
          ),
        )
      : models;
  return filtered
    .sort((a, b) => a.fullId.localeCompare(b.fullId))
    .map((m) => ({
      value: m.fullId,
      label: m.fullId,
      description: m.reasoning ? "reasoning" : undefined,
    }));
}

/**
 * Persists only the model field for one role, always as a user-scope override.
 * mergeBuiltinAgentOverride merges fields additively, so thinking/fallbackModels
 * on an existing entry are left untouched. Project scope is intentionally not
 * offered here: it would write a separate settings file whose overrides take
 * precedence over the user-scope entries this picker displays.
 */
export function persistRoleModel(
  cwd: string,
  roleName: string,
  model: string,
): string {
  return mergeBuiltinAgentOverride(cwd, roleName, "user", { model });
}

function sendRoleModelText(pi: ExtensionAPI, text: string): void {
  pi.sendMessage({
    customType: SLASH_TEXT_RESULT_TYPE,
    content: text,
    display: true,
  });
}

class RoleModelSubmenu extends Container implements Component {
  private readonly selectList: SelectList;

  constructor(
    roleName: string,
    currentValue: string,
    items: SelectItem[],
    done: (value?: string) => void,
  ) {
    super();
    this.addChild(new Text(`Modell für „${roleName}"`, 0, 0));
    this.addChild(new Spacer(1));
    this.selectList = new SelectList(
      items,
      Math.min(items.length, 12),
      getSelectListTheme(),
    );
    const idx = items.findIndex((item) => item.value === currentValue);
    if (idx !== -1) this.selectList.setSelectedIndex(idx);
    this.selectList.onSelect = (item) => done(item.value);
    this.selectList.onCancel = () => done(undefined);
    this.addChild(this.selectList);
  }

  handleInput(data: string): void {
    this.selectList.handleInput(data);
  }
}

export interface RoleModelPickerResult {
  changed: boolean;
}

export class RoleModelPickerComponent extends Container implements Component {
  private readonly settingsList: SettingsList;

  constructor(
    tui: TUI,
    _theme: Theme,
    roles: PickableRole[],
    modelItems: SelectItem[],
    cwd: string,
    done: (result: RoleModelPickerResult) => void,
  ) {
    super();
    let changed = false;
    const items: SettingItem[] = roles.map((role) => ({
      id: role.name,
      label: role.name,
      description: role.description,
      currentValue: role.currentModel ?? "(kein Modell gesetzt)",
      submenu: (currentValue: string, submenuDone: (value?: string) => void) =>
        new RoleModelSubmenu(role.name, currentValue, modelItems, submenuDone),
    }));
    this.settingsList = new SettingsList(
      items,
      Math.min(items.length, 10),
      getSettingsListTheme(),
      (id, newValue) => {
        persistRoleModel(cwd, id, newValue);
        changed = true;
        this.settingsList.updateValue(id, newValue);
        tui.requestRender();
      },
      () => done({ changed }),
      { enableSearch: true },
    );
    this.addChild(this.settingsList);
  }

  handleInput(data: string): void {
    this.settingsList.handleInput(data);
  }
}

export function registerRoleModelCommand(pi: ExtensionAPI): void {
  pi.registerCommand("subagents-set-model", {
    description:
      "Modell pro Subagenten-Rolle auswählen und dauerhaft speichern (User-Scope-Override)",
    handler: async (args: string, ctx: ExtensionContext) => {
      const trimmed = args.trim();
      if (trimmed) {
        const [role, ...rest] = trimmed.split(/\s+/);
        const model = rest.join(" ");
        if (!role || !model) {
          ctx.ui.notify(
            "Usage: /subagents-set-model <role> <provider/model>",
            "error",
          );
          return;
        }
        const path = persistRoleModel(ctx.cwd, role, model);
        ctx.ui.notify(`'${role}' → ${model} gespeichert in ${path}`, "info");
        return;
      }

      const roles = listPickableRoles(ctx.cwd);
      if (roles.length === 0) {
        ctx.ui.notify("Keine Subagenten-Rollen gefunden.", "info");
        return;
      }
      if (!ctx.hasUI) {
        sendRoleModelText(
          pi,
          roles
            .map(
              (r) =>
                `- ${r.name}: ${r.currentModel ?? "(kein Modell gesetzt)"}`,
            )
            .join("\n"),
        );
        return;
      }

      const modelItems = buildModelItems(ctx, ctx.cwd);
      await ctx.ui.custom<RoleModelPickerResult>(
        (tui, theme, _kb, done) =>
          new RoleModelPickerComponent(
            tui,
            theme,
            roles,
            modelItems,
            ctx.cwd,
            done,
          ),
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" },
        },
      );
    },
  });
}
