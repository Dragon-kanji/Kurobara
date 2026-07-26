import { type DomainResult, fail, succeed } from "@kurobara/kernel";
import type {
  OrchestrationPort,
  OutboxMessage,
  StartRunOutcome,
} from "@kurobara/ports";

export type DispatchRunQueuedFailure = Readonly<{
  code: "outbox-message-inconsistent";
  message: string;
}>;

export type DispatchRunQueuedDependencies = Readonly<{
  orchestration: OrchestrationPort;
}>;

export const makeDispatchRunQueued =
  (dependencies: DispatchRunQueuedDependencies) =>
  async (
    message: OutboxMessage,
    startKey: string
  ): Promise<DomainResult<StartRunOutcome, DispatchRunQueuedFailure>> => {
    if (
      message.aggregateId !== message.event.runId ||
      message.eventId !== message.event.eventId ||
      message.workspaceId !== message.event.workspaceId ||
      startKey.trim().length === 0
    ) {
      return fail({
        code: "outbox-message-inconsistent",
        message:
          "The queued-run outbox message and orchestration start key are inconsistent.",
      });
    }

    return succeed(
      await dependencies.orchestration.startRun({
        eventId: message.eventId,
        runId: message.aggregateId,
        startKey,
        workspaceId: message.workspaceId,
      })
    );
  };
