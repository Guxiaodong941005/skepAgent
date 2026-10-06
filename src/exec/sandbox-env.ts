import { isAbsolute } from "node:path";
import { z } from "zod";
import { AgentCliSchema } from "../core/schemas/common.js";
import { execFileChecked } from "../util/exec.js";

const EnvValueSchema = z.string().refine((value) => !value.includes("\0"));
const UserSchema = z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/i);
const DirectorySchema = EnvValueSchema.refine(isAbsolute, "expected an absolute directory");
const AgentEnvOptionsSchema = z.strictObject({
  source: z.record(z.string(), z.string().optional()).optional(),
  home: DirectorySchema,
  user: UserSchema,
  tmpDir: DirectorySchema.optional(),
  agentCli: AgentCliSchema.optional(),
  configDir: DirectorySchema.optional(),
});

export type AgentEnvOptions = z.infer<typeof AgentEnvOptionsSchema>;

const RUNTIME_VARIABLES = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM"] as const;
const CLI_CONFIG_VARIABLES = {
  codex: "CODEX_HOME",
  claude: "CLAUDE_CONFIG_DIR",
  pi: "PI_CODING_AGENT_DIR",
} as const;

export class SandboxEnvError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SandboxEnvError";
  }
}

/** PRD §11.4 / D19: only runtime variables and explicitly chosen agent-local directories. */
export function agentEnv(opts: AgentEnvOptions): Record<string, string> {
  const parsed = AgentEnvOptionsSchema.safeParse(opts);
  if (!parsed.success) throw new SandboxEnvError("Invalid agent environment options");
  const { source = {}, home, user, tmpDir, agentCli, configDir } = parsed.data;
  if (configDir !== undefined && agentCli === undefined) {
    throw new SandboxEnvError("An agent CLI is required when selecting its local config directory");
  }

  const env: Record<string, string> = {};
  for (const name of RUNTIME_VARIABLES) {
    const value = source[name];
    if (value === undefined) continue;
    if (!EnvValueSchema.safeParse(value).success) {
      throw new SandboxEnvError(`Invalid runtime environment variable ${name}`);
    }
    env[name] = value;
  }
  // Never inherit the daemon's HOME, user identity or CLI configuration directory (§16).
  Object.assign(env, { HOME: home, USER: user, LOGNAME: user });
  if (tmpDir !== undefined) env.TMPDIR = tmpDir;
  if (agentCli !== undefined && configDir !== undefined) {
    env[CLI_CONFIG_VARIABLES[agentCli]] = configDir;
  }
  return env;
}

export interface AgentUserIds {
  uid: number;
  gid: number;
}

function parseId(text: string): number {
  const value = text.trim();
  const id = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(id) || id > 4_294_967_294) {
    throw new SandboxEnvError("OS user lookup returned an invalid uid or gid");
  }
  return id;
}

/** Optional spawn identity; the executor is injectable for simulations and non-root tests. */
export async function resolveAgentUser(
  user?: string,
  deps: { exec?: typeof execFileChecked } = {},
): Promise<Partial<AgentUserIds>> {
  if (user === undefined) return {};
  if (!UserSchema.safeParse(user).success) {
    throw new SandboxEnvError("Agent user must be a valid local OS user name");
  }
  const exec = deps.exec ?? execFileChecked;
  try {
    const opts = { env: { LC_ALL: "C" } };
    const [uid, gid] = await Promise.all([
      exec("/usr/bin/id", ["-u", user], opts),
      exec("/usr/bin/id", ["-g", user], opts),
    ]);
    if (uid.code !== 0 || gid.code !== 0) {
      throw new SandboxEnvError("OS user lookup did not exit successfully");
    }
    return { uid: parseId(uid.stdout), gid: parseId(gid.stdout) };
  } catch (error) {
    throw new SandboxEnvError(
      `Cannot resolve agent user ${user}; configure an existing local user`,
      {
        cause: error,
      },
    );
  }
}
