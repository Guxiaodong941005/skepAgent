import type { EventType, SkepEvent } from "../schemas/events.js";
import { handleLeaseClaimed, handleLeaseReleased, handleLeaseRevoked } from "./handlers/lease.js";
import { handleItemMerged, handleTaskVerified } from "./handlers/merge.js";
import {
  handlePlanApproved,
  handlePlanLocked,
  handlePlanProposed,
  handlePlanRejected,
  handleReviewSubmitted,
} from "./handlers/plan.js";
import {
  handleBarrierClosed,
  handleCheckpointRecorded,
  handleReplanRequested,
} from "./handlers/replan.js";
import {
  handleAgentRegistered,
  handleHumanDecided,
  handleOwnerTransferred,
  handleTaskCancelled,
  handleTaskCreated,
} from "./handlers/task.js";
import type { ApplyCtx, Handler } from "./handlers/types.js";
import { handleWorkDelivered, handleWorkFailed } from "./handlers/work.js";
import { checkPre } from "./preconditions.js";
import type { ApplyResult, State } from "./state.js";

const handlers: { [T in EventType]: Handler<T> } = {
  "agent.registered": handleAgentRegistered,
  "task.created": handleTaskCreated,
  "task.cancelled": handleTaskCancelled,
  "owner.transferred": handleOwnerTransferred,
  "human.decided": handleHumanDecided,
  "plan.proposed": handlePlanProposed,
  "review.submitted": handleReviewSubmitted,
  "plan.locked": handlePlanLocked,
  "plan.approved": handlePlanApproved,
  "plan.rejected": handlePlanRejected,
  "lease.claimed": handleLeaseClaimed,
  "lease.released": handleLeaseReleased,
  "lease.revoked": handleLeaseRevoked,
  "work.delivered": handleWorkDelivered,
  "work.failed": handleWorkFailed,
  "replan.requested": handleReplanRequested,
  "checkpoint.recorded": handleCheckpointRecorded,
  "barrier.closed": handleBarrierClosed,
  "item.merged": handleItemMerged,
  "task.verified": handleTaskVerified,
};

export function applyEvent(draft: State, event: SkepEvent, ctx: ApplyCtx): ApplyResult {
  const pre = checkPre(event, draft);
  if (!pre.ok) return pre;
  // The mapped table checks each payload at declaration; indexing a union loses that
  // correlation in TypeScript, but event.type always selects its matching handler.
  const handler = handlers[event.type] as Handler<EventType>;
  return handler(draft, event, ctx);
}
