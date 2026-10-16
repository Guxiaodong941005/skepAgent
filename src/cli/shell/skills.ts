import {
  bind,
  bindingTable,
  type ManualBindings,
  type SkillContext,
  type SkillPeer,
} from "../../core/skills/compose.js";
import { SkillError } from "../../core/skills/schemas.js";
import type { SkillLoader } from "../../skills/loader.js";
import { loadSkillDefault, requireSkillFile, saveSkillDefault } from "../../skills/settings.js";
import type { SkillTrustStore } from "../../skills/trust.js";
import { parseFlags } from "./flags.js";

/** Shell-local selection and manual overrides; every request revalidates the disk digest. */
export class ShellSkills {
  selection = "generic";
  persistedDefault: string | null = null;
  private manual: ManualBindings = {};
  private tipped = false;
  constructor(
    readonly loader: SkillLoader,
    private readonly trust: SkillTrustStore | null,
    private readonly file: string | undefined,
    private readonly peers: () => SkillPeer[],
  ) {}

  async initialize(): Promise<void> {
    this.persistedDefault = this.file ? await loadSkillDefault(this.file) : null;
    this.selection = this.persistedDefault ?? "generic";
  }
  async use(selection: string): Promise<void> {
    const skill = await this.loader.get(selection === "generic" ? "packaged:generic" : selection);
    this.selection = skill.manifest.id === "generic" ? "generic" : selection;
    this.manual = {};
  }
  async context(requireTrust = true): Promise<SkillContext | undefined> {
    if (this.selection === "generic" || this.selection === "packaged:generic") return undefined;
    const skill = await this.loader.get(this.selection, requireTrust);
    return {
      skill,
      bindings: bind(skill.manifest.roles, this.peers(), this.manual),
      manual: { ...this.manual },
    };
  }
  async tip(): Promise<string> {
    if (this.tipped) return "";
    this.tipped = true;
    if (
      this.persistedDefault ||
      !(await this.loader.list()).some((e) => e.skill && e.id !== "generic")
    )
      return "";
    return "tip: /skills — e.g. /skill use iot-ble-feature for device + server + app features";
  }
  async list(): Promise<string> {
    const entries = await this.loader.list();
    return entries
      .map(
        (e) =>
          `${e.id} ${e.skill?.manifest.version ?? "?"} (${e.scope})` +
          ` roles: ${e.skill?.manifest.roles.map((r) => r.id).join(", ") || "—"}` +
          ((this.selection === e.id && !e.shadowed) ||
          this.selection === `${e.scope}:${e.id}` ||
          (this.selection === "generic" && e.id === "generic" && e.scope === "packaged")
            ? " active"
            : "") +
          (e.reason ? ` invalid: ${e.reason}` : e.trusted ? "" : " untrusted") +
          (e.shadowed
            ? " shadowed by a higher scope"
            : entries.some((other) => other.id === e.id && other.shadowed)
              ? ` shadows ${entries
                  .filter((other) => other.id === e.id && other.shadowed)
                  .map((other) => `${other.scope} ${other.skill?.manifest.version ?? "invalid"}`)
                  .join(", ")}`
              : ""),
      )
      .join("\n");
  }
  async command(args: string, mode: string, master: boolean): Promise<string> {
    const flags = parseFlags(args, [], ["default"]);
    const [action, first, second, ...extra] = flags.positional;
    if (extra.length) throw new SkillError("too many /skill arguments");
    if (!master && action !== "show")
      throw new SkillError("/skill requires a master shell; /skills and /skill show work anywhere");
    if (flags.switches.has("default") && action !== "use" && action !== "off")
      throw new SkillError("--default applies to /skill use or off");
    if (!action) {
      const context = await this.context();
      return context ? bindingTable(context) : "skill generic (default workflow)";
    }
    if (action === "show" && first && !second) {
      const skill = await this.loader.get(first, false);
      return (
        `${skill.manifest.id} ${skill.manifest.version} (${skill.scope})\n${skill.manifest.description}\ndigest: ${skill.digest}\n${JSON.stringify(skill.manifest, null, 2)}\n` +
        Object.entries(skill.files)
          .map(([name, text]) => `${name}: ${text.length} chars\n${text}`)
          .join("\n\n")
      );
    }
    if (action === "trust" && first && !second) {
      if (!this.trust) throw new SkillError("configure SKEP_HOME before trusting project skills");
      const skill = await this.loader.get(first, false);
      await this.trust.trust(skill);
      return `trusted ${skill.manifest.id} ${skill.digest}`;
    }
    if ((action === "use" && first && !second) || (action === "off" && !first)) {
      await this.use(action === "off" ? "generic" : (first ?? "generic"));
      if (flags.switches.has("default")) {
        const selection = action === "off" ? null : this.selection;
        await saveSkillDefault(requireSkillFile(this.file), selection);
        this.persistedDefault = selection;
      }
      const context = await this.context();
      return context
        ? bindingTable(context) +
            (context.skill.manifest.mode_hint && context.skill.manifest.mode_hint !== mode
              ? `\nthis skill suggests /orchestrate ${context.skill.manifest.mode_hint} for review before dispatch`
              : "") +
            (mode === "off"
              ? `\nskill ${context.skill.manifest.id} is inactive while /orchestrate is off`
              : "")
        : "skill generic (default workflow)";
    }
    if ((action === "bind" && first && second) || (action === "unbind" && first && !second)) {
      const context = await this.context();
      if (!context?.skill.manifest.roles.some((r) => r.id === first))
        throw new SkillError(`unknown active skill role ${first}`);
      if (action === "bind" && !this.peers().some((p) => p.peerId === second || p.repo === second))
        throw new SkillError(`no connected peer or repo ${second}`);
      this.manual[first] = action === "bind" ? (second ?? null) : null;
      return bindingTable({
        ...context,
        bindings: bind(context.skill.manifest.roles, this.peers(), this.manual),
      });
    }
    throw new SkillError(
      "usage: /skill [use <id> [--default]|off [--default]|bind <role> <peer|repo>|unbind <role>|show <id>|trust <id>]",
    );
  }
}
