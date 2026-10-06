import type { Principal } from "../../principal.js";
import type { EventOf, EventType } from "../../schemas/events.js";
import type { ApplyResult, State } from "../state.js";

export interface ApplyCtx {
  seq: number;
  sha: string;
  principal: Principal;
}

export type Handler<T extends EventType> = (
  draft: State,
  event: EventOf<T>,
  ctx: ApplyCtx,
) => ApplyResult;
