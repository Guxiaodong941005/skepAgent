import type { LogEntry } from "../log.js";
import { GENESIS_PATH, GenesisSchema } from "../schemas/genesis.js";
import { REDUCER_VERSION, type State } from "./state.js";

export class GenesisError extends Error {
  constructor(message: string) {
    super(`Invalid blackboard genesis: ${message}`);
    this.name = "GenesisError";
  }
}

export function genesisState(entry: LogEntry): State {
  if (entry.seq !== 0 || entry.parents.length !== 0) {
    throw new GenesisError("expected seq 0 with no parents");
  }
  if (entry.signature.status !== "good" || entry.signature.principal !== "human") {
    throw new GenesisError("skep.json must be signed by the trusted human key");
  }
  if (!entry.changes.some((change) => change.status === "A" && change.path === GENESIS_PATH)) {
    throw new GenesisError("the root commit must add skep.json");
  }
  const content = entry.added[GENESIS_PATH];
  if (content == null) throw new GenesisError("skep.json is missing or unreadable");
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch (error) {
    throw new GenesisError(`skep.json is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = GenesisSchema.safeParse(raw);
  if (!parsed.success)
    throw new GenesisError(`skep.json fails its schema: ${parsed.error.message}`);
  const genesis = parsed.data;
  if (genesis.reducer_version !== REDUCER_VERSION) {
    throw new GenesisError(
      `reducer version ${genesis.reducer_version} is unsupported; expected ${REDUCER_VERSION}`,
    );
  }
  return {
    reducer_version: REDUCER_VERSION,
    protocol_version: genesis.protocol_version,
    blackboard_id: genesis.blackboard_id,
    genesis_sha: entry.sha,
    tip: entry.sha,
    seq: 0,
    agents: {},
    tasks: {},
    seen_event_ids: {},
    outcomes: [],
  };
}
