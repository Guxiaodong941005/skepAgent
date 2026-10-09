import { daemonOwnsAgent, type Principal } from "../principal.js";
import type { SkepEvent } from "../schemas/events.js";
import type { State } from "./state.js";

export function authorize(principal: Principal, event: SkepEvent, state: State): boolean {
  if (
    principal.kind === "human" ? event.actor !== "human" : !daemonOwnsAgent(principal, event.actor)
  ) {
    return false;
  }
  const human = principal.kind === "human";
  const task = event.task_id === null ? undefined : state.tasks[event.task_id];
  // ARCHITECTURE §5.4: missing tasks pass only the state-dependent checks so checkPre can
  // distinguish unknown_task from unauthorized.
  switch (event.type) {
    case "task.created":
    case "task.cancelled":
    case "owner.transferred":
    case "plan.approved":
    case "plan.rejected":
    case "human.decided":
    case "lease.revoked":
      return human;
    case "plan.proposed":
    case "plan.locked":
    case "task.verified":
      return !human && (!task || event.actor === task.owner);
    case "barrier.closed":
      return human || !task || event.actor === task.owner;
    case "review.submitted":
      return (
        human ||
        !task ||
        (task.plans[String(task.current_plan_version)]?.reviewers.includes(event.actor) ?? false)
      );
    case "replan.requested":
      return (
        human ||
        !task ||
        event.actor === task.owner ||
        Object.values(task.items).some((item) => item.lease?.holder === event.actor)
      );
    case "agent.registered":
    case "lease.claimed":
    case "lease.released":
    case "checkpoint.recorded":
    case "work.delivered":
    case "work.failed":
      return !human;
    case "item.merged":
    case "work.submitted":
      return true;
  }
}
