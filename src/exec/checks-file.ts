import { parseTomlConfig } from "../config/errors.js";
import { type ChecksFile, ChecksFileSchema } from "../core/schemas/config.js";

/**
 * `.skep/checks.toml` parsed from text already read at the plan's `base_commit`
 * (ARCHITECTURE §9.6). Loading via `git show` belongs to SK-502; this stays pure so a plan can
 * never inject argv — only names from this trusted file run (PRD §11.5).
 */
export function parseChecksFile(text: string, source: string): ChecksFile {
  return parseTomlConfig(ChecksFileSchema, text, source);
}
