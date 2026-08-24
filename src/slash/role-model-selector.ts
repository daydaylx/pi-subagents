import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  DynamicBorder,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  fuzzyFilter,
  getKeybindings,
  Input,
  SettingsList,
  Spacer,
  Text,
  type Component,
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

export interface RoleModelItem {
  value: string;
  provider: string;
  id: string;
  reasoning?: boolean;
}

/** Runtime-available models, narrowed to subagents.modelScope.allow when enforced. */
export function buildModelItems(
  ctx: Pick<ExtensionContext, "modelRegistry">,
  cwd: string,
): RoleModelItem[] {
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
      provider: m.provider,
      id: m.id,
      reasoning: m.reasoning,
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

/**
 * Mirrors the row style of the real /model screen (accent "→ " cursor,
 * muted "[provider]" badge, success "✓" on the currently active model) —
 * "current" here is the role's prior override, not a session default.
 */
function renderModelLine(
  theme: Theme,
  item: RoleModelItem,
  isSelected: boolean,
  isCurrent: boolean,
): string {
  const providerBadge = theme.fg("muted", `[${item.provider}]`);
  const checkmark = isCurrent ? theme.fg("success", " ✓") : "";
  if (isSelected) {
    const prefix = theme.fg("accent", "→ ");
    return `${prefix}${theme.fg("accent", item.id)} ${providerBadge}${checkmark}`;
  }
  return `  ${item.id} ${providerBadge}${checkmark}`;
}

/**
 * DynamicBorder's global theme singleton can be undefined for jiti-loaded
 * extensions (separate module cache) — always pass an explicit color
 * function, per dynamic-border.d.ts's own warning.
 */
function borderFor(theme: Theme): DynamicBorder {
  return new DynamicBorder((s) => theme.fg("border", s));
}

class RoleModelSubmenu extends Container implements Component {
  private readonly theme: Theme;
  private readonly items: RoleModelItem[];
  private readonly currentValue: string;
  private readonly done: (value?: string) => void;
  private readonly searchInput: Input;
  private readonly listContainer: Container;
  private filteredItems: RoleModelItem[];
  private selectedIndex = 0;

  constructor(
    theme: Theme,
    roleName: string,
    roleDescription: string,
    items: RoleModelItem[],
    currentValue: string,
    done: (value?: string) => void,
  ) {
    super();
    this.theme = theme;
    this.items = items;
    this.filteredItems = items;
    this.currentValue = currentValue;
    this.done = done;

    this.addChild(borderFor(theme));
    this.addChild(new Spacer(1));
    this.addChild(
      new Text(
        theme.fg("accent", theme.bold(`Modell für „${roleName}“`)),
        0,
        0,
      ),
    );
    if (roleDescription.trim()) {
      this.addChild(new Text(theme.fg("muted", roleDescription), 0, 0));
    }
    this.addChild(new Spacer(1));

    this.searchInput = new Input();
    this.addChild(this.searchInput);
    this.addChild(new Spacer(1));

    this.listContainer = new Container();
    this.addChild(this.listContainer);
    this.addChild(new Spacer(1));

    this.addChild(
      new Text(
        theme.fg("dim", "Enter") +
          theme.fg("muted", " wählt · ") +
          theme.fg("dim", "Esc") +
          theme.fg("muted", " bricht ab · Tippen filtert"),
        0,
        0,
      ),
    );
    this.addChild(borderFor(theme));

    const idx = items.findIndex((item) => item.value === currentValue);
    this.selectedIndex = idx !== -1 ? idx : 0;
    this.updateList();
  }

  private filterItems(query: string): void {
    this.filteredItems = query
      ? fuzzyFilter(
          this.items,
          query,
          (item) => `${item.id} ${item.provider} ${item.provider}/${item.id}`,
        )
      : this.items;
    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, this.filteredItems.length - 1),
    );
    this.updateList();
  }

  private updateList(): void {
    this.listContainer.clear();
    const maxVisible = 10;
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(maxVisible / 2),
        this.filteredItems.length - maxVisible,
      ),
    );
    const endIndex = Math.min(
      startIndex + maxVisible,
      this.filteredItems.length,
    );

    for (let i = startIndex; i < endIndex; i++) {
      const item = this.filteredItems[i];
      if (!item) continue;
      const line = renderModelLine(
        this.theme,
        item,
        i === this.selectedIndex,
        item.value === this.currentValue,
      );
      this.listContainer.addChild(new Text(line, 0, 0));
    }

    if (startIndex > 0 || endIndex < this.filteredItems.length) {
      this.listContainer.addChild(
        new Text(
          this.theme.fg(
            "muted",
            `  (${this.selectedIndex + 1}/${this.filteredItems.length})`,
          ),
          0,
          0,
        ),
      );
    }

    if (this.filteredItems.length === 0) {
      this.listContainer.addChild(
        new Text(this.theme.fg("muted", "  Keine passenden Modelle"), 0, 0),
      );
    }
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.up")) {
      if (this.filteredItems.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === 0
          ? this.filteredItems.length - 1
          : this.selectedIndex - 1;
      this.updateList();
      return;
    }
    if (kb.matches(data, "tui.select.down")) {
      if (this.filteredItems.length === 0) return;
      this.selectedIndex =
        this.selectedIndex === this.filteredItems.length - 1
          ? 0
          : this.selectedIndex + 1;
      this.updateList();
      return;
    }
    if (kb.matches(data, "tui.select.confirm")) {
      const selected = this.filteredItems[this.selectedIndex];
      this.done(selected?.value);
      return;
    }
    if (kb.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }
    this.searchInput.handleInput(data);
    this.filterItems(this.searchInput.getValue());
  }
}

export interface RoleModelPickerResult {
  changed: boolean;
}

export class RoleModelPickerComponent extends Container implements Component {
  private readonly settingsList: SettingsList;

  constructor(
    tui: TUI,
    theme: Theme,
    roles: PickableRole[],
    modelItems: RoleModelItem[],
    cwd: string,
    done: (result: RoleModelPickerResult) => void,
  ) {
    super();
    let changed = false;

    this.addChild(
      new Text(theme.fg("accent", theme.bold("Subagenten-Rollen")), 0, 0),
    );
    this.addChild(
      new Text(
        theme.fg(
          "muted",
          "Enter wählt ein neues Modell · Änderungen werden sofort gespeichert",
        ),
        0,
        0,
      ),
    );
    this.addChild(new Spacer(1));

    const items: SettingItem[] = roles.map((role) => ({
      id: role.name,
      label: role.name,
      description: role.description,
      currentValue: role.currentModel ?? "(kein Modell gesetzt)",
      submenu: (currentValue: string, submenuDone: (value?: string) => void) =>
        new RoleModelSubmenu(
          theme,
          role.name,
          role.description,
          modelItems,
          currentValue,
          submenuDone,
        ),
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
