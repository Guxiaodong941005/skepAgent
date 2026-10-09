import { z } from "zod";
import { DEVICE_RE } from "../ids.js";
import {
  AgentCliSchema,
  PositiveIntSchema,
  RelPathSchema,
  RepoRefSchema,
  RoleSchema,
} from "./common.js";

/**
 * Local, trusted configuration. None of these are ever read from an agent
 * worktree.
 */

/** `~/.skep/device.toml` (PRD §7.2, §11.5). */
export const DeviceSubmitSchema = z
  .strictObject({
    method: z.enum(["pr", "mr", "push", "none", "ask"]).default("pr"),
    host: z.enum(["github", "gitlab", "git"]).default("github"),
  })
  .default({ method: "pr", host: "github" });

export const DeviceConfigSchema = z.strictObject({
  schema: z.literal("skep.device/v1"),
  device: z.string().regex(DEVICE_RE),
  submit: DeviceSubmitSchema,
  /** @deprecated Removed with skepd; ignored if present in old device.toml files. */
  blackboard: z
    .strictObject({
      url: z.string().min(1),
      clone_path: z.string().optional(),
    })
    .optional(),
  /** Repo allowlist; tasks referencing other repos are refused (PRD §11.5). */
  repos: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
        url: RepoRefSchema,
      }),
    )
    .max(64),
  /** @deprecated Removed with skepd. */
  signing_key: z.string().min(1).optional(),
  /** Optional path to the human key / ssh-agent identity (Mac only). */
  human_signing_key: z.string().min(1).optional(),
  poll: z
    .strictObject({
      active_sec: PositiveIntSchema.default(20),
      idle_sec: PositiveIntSchema.default(90),
    })
    .default({ active_sec: 20, idle_sec: 90 }),
  notify: z.strictObject({ ntfy_topic_url: z.url() }).optional(),
  /**
   * Controller only (D26). Workers the controller tells to fetch after it publishes.
   * The message is a wake-up, never state: each worker still verifies signed git.
   */
  workers: z
    .array(
      z.strictObject({
        /** Device name, for logs only. */
        device: z.string().regex(DEVICE_RE),
        /** `user@host` or an SSH config alias. No shell metacharacters. */
        ssh: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._@:-]{0,200}$/),
        /** Absolute path of that device's skep checkout or install root. Optional. */
        skep_bin: z
          .string()
          .regex(/^\/[A-Za-z0-9._/-]{0,240}$/)
          .optional(),
        /** That device's SKEP_HOME, if not the default. Optional. */
        home: z
          .string()
          .regex(/^\/[A-Za-z0-9._/-]{0,240}$/)
          .optional(),
      }),
    )
    .max(16)
    .optional(),
});
export type DeviceConfig = z.infer<typeof DeviceConfigSchema>;

/** YAML front-matter of AGENT.md (PRD §7.3). */
export const AgentMdFrontMatterSchema = z.strictObject({
  schema: z.literal("skep.agent/v1"),
  role: RoleSchema,
  agent_cli: AgentCliSchema,
  cli_version: z.string().min(1).max(64),
  repos: z.array(RepoRefSchema).min(1).max(64),
  capabilities: z.array(z.string().min(1).max(64)).max(64),
  requires_local: z.array(z.string().min(1).max(64)).max(16).default([]),
  max_parallel_items: PositiveIntSchema.max(8).default(1),
  budgets: z
    .strictObject({ max_invocation_minutes: PositiveIntSchema.max(24 * 60).default(45) })
    .default({ max_invocation_minutes: 45 }),
});
export type AgentMdFrontMatter = z.infer<typeof AgentMdFrontMatterSchema>;

/**
 * `.skep/checks.toml` in the code repo, read only at the plan's `base_commit` (PRD §9.2, §11.5).
 *
 * ```toml
 * schema = "skep.checks/v1"
 * [checks.unit]
 * argv = ["npm", "test"]
 * timeout_sec = 600
 * ```
 */
export const CheckDefSchema = z.strictObject({
  argv: z.array(z.string().min(1).max(4096)).min(1).max(64),
  timeout_sec: PositiveIntSchema.max(6 * 3600).default(600),
  /** Working directory relative to the worktree root. */
  cwd: RelPathSchema.optional(),
  /** Extra env (non-secret). The daemon still strips credentials. */
  env: z.record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/), z.string().max(4096)).optional(),
  /** Optional parser for passed/failed counts. */
  parser: z.enum(["none", "tap", "junit", "vitest-json"]).default("none"),
});
export type CheckDef = z.infer<typeof CheckDefSchema>;

export const ChecksFileSchema = z.strictObject({
  schema: z.literal("skep.checks/v1"),
  checks: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), CheckDefSchema),
});
export type ChecksFile = z.infer<typeof ChecksFileSchema>;

export const CHECKS_FILE_PATH = ".skep/checks.toml";
