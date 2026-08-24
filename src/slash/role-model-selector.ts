import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  fuzzyFilter,
  getKeybindings,
  Input,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
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

const ELLIPSIS = "…";
const COMPACT_WIDTH = 52;

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

export function roleSourceLabel(source: AgentSource): string {
  switch (source) {
    case "builtin":
      return "Integriert";
    case "package":
      return "Paket";
    case "user":
      return "Benutzer";
    case "project":
      return "Projekt";
  }
}

export interface PickerWindow {
  start: number;
  end: number;
}

/** Keeps a focused row near the center while retaining a stable list window. */
export function pickerWindow(
  count: number,
  selectedIndex: number,
  maxVisible: number,
): PickerWindow {
  if (count <= 0 || maxVisible <= 0) return { start: 0, end: 0 };
  const visible = Math.min(count, maxVisible);
  const selected = Math.max(0, Math.min(count - 1, selectedIndex));
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(visible / 2), count - visible),
  );
  return { start, end: start + visible };
}

export function movePickerIndex(
  current: number,
  delta: number,
  count: number,
): number {
  if (count <= 0) return -1;
  const start = Math.max(0, Math.min(count - 1, current));
  return (start + delta + count) % count;
}

function pad(value: string, width: number): string {
  const clipped = truncateToWidth(value, Math.max(1, width), ELLIPSIS);
  return `${clipped}${" ".repeat(
    Math.max(0, Math.max(1, width) - visibleWidth(clipped)),
  )}`;
}

function renderPanel(theme: Theme, width: number, lines: string[]): string[] {
  if (width < 4) return [truncateToWidth("Menü", Math.max(1, width), ELLIPSIS)];
  const inner = Math.max(1, width - 2);
  const border = (value: string) => theme.fg("border", value);
  const frame = (value: string) => `${border("│")}${pad(value, inner)}${border("│")}`;
  return [
    `${border("╭")}${border("─".repeat(inner))}${border("╮")}`,
    ...lines.map(frame),
    `${border("╰")}${border("─".repeat(inner))}${border("╯")}`,
  ];
}

function divider(theme: Theme, width: number): string {
  return theme.fg("borderMuted", "─".repeat(Math.max(1, width)));
}

function renderInput(input: Input, width: number): string[] {
  return input.render(Math.max(1, width)).map((line) =>
    truncateToWidth(line, Math.max(1, width), ELLIPSIS),
  );
}

function detailLines(theme: Theme, value: string, width: number): string[] {
  return wrapTextWithAnsi(
    theme.fg("muted", value),
    Math.max(1, width),
  ).slice(0, 2);
}

export function renderRoleLine(
  theme: Theme,
  role: PickableRole,
  isSelected: boolean,
): string {
  const cursor = isSelected ? theme.fg("accent", "▌ ") : "  ";
  const name = isSelected
    ? theme.fg("accent", theme.bold(role.name))
    : theme.fg("text", role.name);
  const status = role.currentModel
    ? theme.fg("success", "● MODELL")
    : theme.fg("muted", "○ STANDARD");
  return `${cursor}${name}  ${status}`;
}

/** A selected model is marked structurally and with a success mark when current. */
export function renderModelLine(
  theme: Theme,
  item: RoleModelItem,
  isSelected: boolean,
  isCurrent: boolean,
): string {
  const cursor = isSelected ? theme.fg("accent", "▌ ") : "  ";
  const label = isSelected
    ? theme.fg("accent", theme.bold(item.id))
    : theme.fg("text", item.id);
  const provider = theme.fg("muted", `[${item.provider}]`);
  const current = isCurrent ? theme.fg("success", " ● AKTUELL") : "";
  return `${cursor}${label} ${provider}${current}`;
}

function matchesRole(role: PickableRole, query: string): boolean {
  return fuzzyFilter(
    [role],
    query,
    (item) =>
      `${item.name} ${item.description} ${item.source} ${item.currentModel ?? ""}`,
  ).length > 0;
}

export class RoleModelSubmenu implements Component {
  private readonly theme: Theme;
  private readonly items: RoleModelItem[];
  private readonly currentValue: string;
  private readonly done: (value?: string) => void;
  private readonly roleName: string;
  private readonly roleDescription: string;
  private readonly searchInput = new Input();
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
    this.theme = theme;
    this.roleName = roleName;
    this.roleDescription = roleDescription;
    this.items = items;
    this.filteredItems = items;
    this.currentValue = currentValue;
    this.done = done;
    const current = items.findIndex((item) => item.value === currentValue);
    this.selectedIndex = current >= 0 ? current : 0;
  }

  invalidate(): void {}

  private filterItems(): void {
    const query = this.searchInput.getValue();
    this.filteredItems = query
      ? fuzzyFilter(
          this.items,
          query,
          (item) => `${item.id} ${item.provider} ${item.value}`,
        )
      : this.items;
    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, this.filteredItems.length - 1),
    );
  }

  render(width: number): string[] {
    const inner = Math.max(1, width - 2);
    const compact = width < COMPACT_WIDTH;
    const window = pickerWindow(
      this.filteredItems.length,
      this.selectedIndex,
      compact ? 5 : 8,
    );
    const lines = [
      this.theme.fg("accent", this.theme.bold(` MODELLE › ${this.roleName}`)),
      ...detailLines(this.theme, ` ${this.roleDescription}`, inner),
      divider(this.theme, inner),
      this.theme.fg(
        "muted",
        ` SUCHE · ${this.filteredItems.length}/${this.items.length} Modelle`,
      ),
      ...renderInput(this.searchInput, inner).map((line) => ` ${line}`),
      divider(this.theme, inner),
    ];
    if (window.start > 0)
      lines.push(this.theme.fg("dim", ` ↑ ${window.start} weitere Modelle`));
    for (let index = window.start; index < window.end; index += 1) {
      const item = this.filteredItems[index];
      if (!item) continue;
      lines.push(
        renderModelLine(
          this.theme,
          item,
          index === this.selectedIndex,
          item.value === this.currentValue,
        ),
      );
    }
    if (window.end < this.filteredItems.length)
      lines.push(
        this.theme.fg(
          "dim",
          ` ↓ ${this.filteredItems.length - window.end} weitere Modelle`,
        ),
      );
    if (this.filteredItems.length === 0)
      lines.push(this.theme.fg("muted", " Keine passenden Modelle."));
    lines.push(divider(this.theme, inner));
    lines.push(
      this.theme.fg(
        "dim",
        compact
          ? " ↑↓ wählen · Enter speichern · Esc zurück"
          : " ↑↓ auswählen · Enter speichert · Esc zurück · Tippen filtert",
      ),
    );
    return renderPanel(this.theme, width, lines);
  }

  handleInput(data: string): void {
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.up")) {
      this.selectedIndex = movePickerIndex(
        this.selectedIndex,
        -1,
        this.filteredItems.length,
      );
      return;
    }
    if (kb.matches(data, "tui.select.down")) {
      this.selectedIndex = movePickerIndex(
        this.selectedIndex,
        1,
        this.filteredItems.length,
      );
      return;
    }
    if (kb.matches(data, "tui.select.confirm")) {
      this.done(this.filteredItems[this.selectedIndex]?.value);
      return;
    }
    if (kb.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }
    this.searchInput.handleInput(data);
    this.filterItems();
  }
}

export interface RoleModelPickerResult {
  changed: boolean;
}

export class RoleModelPickerComponent implements Component {
  private readonly theme: Theme;
  private readonly modelItems: RoleModelItem[];
  private readonly cwd: string;
  private readonly done: (result: RoleModelPickerResult) => void;
  private readonly tui: TUI;
  private readonly searchInput = new Input();
  private roles: PickableRole[];
  private filteredRoles: PickableRole[];
  private selectedIndex = 0;
  private changed = false;
  private submenu?: RoleModelSubmenu;

  constructor(
    tui: TUI,
    theme: Theme,
    roles: PickableRole[],
    modelItems: RoleModelItem[],
    cwd: string,
    done: (result: RoleModelPickerResult) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.roles = roles.map((role) => ({ ...role }));
    this.filteredRoles = this.roles;
    this.modelItems = modelItems;
    this.cwd = cwd;
    this.done = done;
  }

  invalidate(): void {
    this.submenu?.invalidate();
  }

  private filterRoles(): void {
    const query = this.searchInput.getValue();
    this.filteredRoles = query
      ? this.roles.filter((role) => matchesRole(role, query))
      : this.roles;
    this.selectedIndex = Math.min(
      this.selectedIndex,
      Math.max(0, this.filteredRoles.length - 1),
    );
  }

  private openSubmenu(): void {
    const role = this.filteredRoles[this.selectedIndex];
    if (!role) return;
    this.submenu = new RoleModelSubmenu(
      this.theme,
      role.name,
      role.description,
      this.modelItems,
      role.currentModel ?? "",
      (model) => {
        this.submenu = undefined;
        if (model) {
          persistRoleModel(this.cwd, role.name, model);
          role.currentModel = model;
          this.changed = true;
        }
        this.tui.requestRender();
      },
    );
  }

  render(width: number): string[] {
    if (this.submenu) return this.submenu.render(width);
    const inner = Math.max(1, width - 2);
    const compact = width < COMPACT_WIDTH;
    const window = pickerWindow(
      this.filteredRoles.length,
      this.selectedIndex,
      compact ? 4 : 6,
    );
    const selected = this.filteredRoles[this.selectedIndex];
    const lines = [
      this.theme.fg("accent", this.theme.bold(" ROLLEN-MODELLE")),
      this.theme.fg(
        "muted",
        compact
          ? " Modell je Rolle wählen · User-Override"
          : " Modell pro Subagenten-Rolle wählen · wird als User-Override gespeichert",
      ),
      divider(this.theme, inner),
      this.theme.fg(
        "muted",
        ` SUCHE · ${this.filteredRoles.length}/${this.roles.length} Rollen`,
      ),
      ...renderInput(this.searchInput, inner).map((line) => ` ${line}`),
      divider(this.theme, inner),
    ];
    if (window.start > 0)
      lines.push(this.theme.fg("dim", ` ↑ ${window.start} weitere Rollen`));
    for (let index = window.start; index < window.end; index += 1) {
      const role = this.filteredRoles[index];
      if (!role) continue;
      lines.push(renderRoleLine(this.theme, role, index === this.selectedIndex));
      lines.push(
        this.theme.fg(
          "muted",
          `    ${role.currentModel ?? "Standardmodell"}`,
        ),
      );
    }
    if (window.end < this.filteredRoles.length)
      lines.push(
        this.theme.fg(
          "dim",
          ` ↓ ${this.filteredRoles.length - window.end} weitere Rollen`,
        ),
      );
    if (!selected)
      lines.push(this.theme.fg("muted", " Keine passenden Rollen."));
    else if (!compact) {
      lines.push(divider(this.theme, inner));
      lines.push(
        this.theme.fg("muted", ` ${selected.description || "Keine Beschreibung."}`),
      );
      lines.push(
        this.theme.fg(
          "dim",
          ` Herkunft: ${roleSourceLabel(selected.source)} · ${selected.currentModel ?? "Standardmodell"}`,
        ),
      );
    }
    lines.push(divider(this.theme, inner));
    lines.push(
      this.theme.fg(
        "dim",
        compact
          ? " ↑↓ Rolle · Enter Modell · Esc schließen"
          : " ↑↓ Rolle · Enter Modell wählen · Esc schließen · Tippen filtert",
      ),
    );
    return renderPanel(this.theme, width, lines);
  }

  handleInput(data: string): void {
    if (this.submenu) {
      this.submenu.handleInput(data);
      return;
    }
    const kb = getKeybindings();
    if (kb.matches(data, "tui.select.up")) {
      this.selectedIndex = movePickerIndex(
        this.selectedIndex,
        -1,
        this.filteredRoles.length,
      );
      return;
    }
    if (kb.matches(data, "tui.select.down")) {
      this.selectedIndex = movePickerIndex(
        this.selectedIndex,
        1,
        this.filteredRoles.length,
      );
      return;
    }
    if (kb.matches(data, "tui.select.confirm")) {
      this.openSubmenu();
      return;
    }
    if (kb.matches(data, "tui.select.cancel")) {
      this.done({ changed: this.changed });
      return;
    }
    this.searchInput.handleInput(data);
    this.filterRoles();
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
          overlayOptions: {
            anchor: "center",
            width: "80%",
            minWidth: 24,
            maxHeight: "80%",
            margin: 1,
          },
        },
      );
    },
  });
}
