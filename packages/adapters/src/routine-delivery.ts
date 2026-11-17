import type { AgentRunModel, AgentRuntime } from "@rakazo/adapter-kit";
import { redactSecrets } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { isPartialReplyClientNonce, recordUsage, storedMessageBlocks } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { z } from "zod";
import { parseModelJson } from "./model-json.js";
import {
  renderRoutineDeliveryJudgePrompt,
  routineDeliveryJudgeInstructions,
} from "./routine-run.prompt.js";
import type { RunContext } from "./run-context.js";
import { messageBlocksText } from "./run-replies.prompt.js";

const DEFAULT_ROUTINE_DELIVERY_TIMEOUT_MS = 15_000;
const MAX_REASON_CHARS = 160;

export interface PriorRoutineReport {
  text: string;
  createdAt: Date | null;
}

export interface RoutineDeliveryDecision {
  deliver: boolean;
  reason?: string;
}

export interface RoutineDeliveryJudgeInput {
  botId: string;
  threadId: string;
  runId: string;
  spaceId: string;
  userId: string;
  routinePrompt: string;
  priorReport?: string | null;
  candidateReply: string;
  timezone?: string | null;
  now?: Date;
}

export type RoutineDeliveryJudge = (
  input: RoutineDeliveryJudgeInput,
) => Promise<RoutineDeliveryDecision>;

const RoutineDeliveryVerdictSchema = z.object({
  deliver: z.boolean(),
  reason: z.string().optional().catch(undefined),
});

function sanitizeReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const cleaned = reason.replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length <= MAX_REASON_CHARS
    ? cleaned
    : `${cleaned.slice(0, MAX_REASON_CHARS - 1).trimEnd()}…`;
}

/**
 * Parses the delivery verdict from a model response. Fails open (`deliver: true`) when
 * the output cannot be parsed so a real routine notification is never dropped on error.
 */
export function parseRoutineDeliveryDecision(raw: string | undefined): RoutineDeliveryDecision {
  if (!raw?.trim()) return { deliver: true };
  const parsed = parseModelJson(raw, RoutineDeliveryVerdictSchema);
  if (!parsed) return { deliver: true };
  const reason = sanitizeReason(parsed.reason);
  return {
    deliver: parsed.deliver,
    ...(reason ? { reason } : {}),
  };
}

/**
 * Loads the most recent non-empty bot message delivered by a completed earlier run
 * of the same routine in this thread.
 */
export async function loadPriorRoutineReport(
  prisma: PrismaClient,
  input: { routineId: string; threadId: string; currentRunId: string },
  secrets: readonly string[] = [],
): Promise<PriorRoutineReport | undefined> {
  const completedRuns = await prisma.run.findMany({
    where: {
      routineId: input.routineId,
      threadId: input.threadId,
      status: "completed",
      id: { not: input.currentRunId },
    },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: { id: true },
  });
  const runIds = completedRuns.map((run) => run.id);
  if (runIds.length === 0) return undefined;
  const rows = await prisma.message.findMany({
    where: {
      threadId: input.threadId,
      role: "bot",
      runId: { in: runIds },
    },
    orderBy: { seq: "desc" },
    take: 5,
    select: { id: true, blocks: true, createdAt: true, clientNonce: true },
  });
  for (const row of rows) {
    if (isPartialReplyClientNonce(row.clientNonce)) continue;
    const text = redactSecrets(messageBlocksText(storedMessageBlocks(row)).trim(), secrets);
    if (text) {
      return { text, createdAt: row.createdAt ?? null };
    }
  }
  return undefined;
}

export async function judgeRoutineDelivery(
  deps: {
    prisma: PrismaClient;
    runtime: AgentRuntime;
    model: AgentRunModel;
    secrets?: readonly string[];
    signal?: AbortSignal;
    timeoutMs?: number;
  },
  input: RoutineDeliveryJudgeInput,
): Promise<RoutineDeliveryDecision> {
  const judgeId = `${input.runId}:routine-delivery`;
  const timeoutSignal = AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_ROUTINE_DELIVERY_TIMEOUT_MS);
  const signal = deps.signal ? AbortSignal.any([deps.signal, timeoutSignal]) : timeoutSignal;
  let streamed = "";
  let doneText: string | undefined;
  try {
    for await (const event of deps.runtime.run(
      {
        botId: input.botId,
        threadId: input.threadId,
        runId: judgeId,
        usageOperationKind: "setup",
        onUsage: async (usageEvent) => {
          await recordUsage(deps.prisma, usageEvent, {
            spaceId: input.spaceId,
            botId: input.botId,
            userId: input.userId,
            runId: input.runId,
            parentRunId: input.runId,
            operationId: judgeId,
            operationKind: "setup",
          });
        },
        prompt: renderRoutineDeliveryJudgePrompt({
          routinePrompt: input.routinePrompt,
          priorReport: input.priorReport,
          candidateReply: input.candidateReply,
        }),
        instructions: routineDeliveryJudgeInstructions(input.timezone, input.now),
        history: [],
        tools: [],
        model: deps.model,
      },
      {
        operationId: judgeId,
        traceId: judgeId,
        spaceId: input.spaceId,
        userId: input.userId,
        botId: input.botId,
        signal,
      },
    )) {
      if (event.type === "usage" && !event.accounted) {
        await recordUsage(deps.prisma, event, {
          spaceId: input.spaceId,
          botId: input.botId,
          userId: input.userId,
          runId: input.runId,
          parentRunId: input.runId,
          operationId: judgeId,
          operationKind: "setup",
        });
      }
      if (event.type === "text" && event.text) streamed += event.text;
      if (event.type === "done" && event.text) doneText = event.text;
    }
    return parseRoutineDeliveryDecision(doneText ?? streamed);
  } catch (error) {
    getLogger().warn("routine.delivery_judge_failed", {
      "run.id": input.runId,
      error: redactSecrets(
        error instanceof Error ? error.message : String(error),
        deps.secrets ?? [],
      ),
    });
    return { deliver: true };
  }
}

export async function shouldDeliverRoutineReply(
  ctx: RunContext,
  candidateReply: string,
): Promise<RoutineDeliveryDecision> {
  const { deps, run, runId, bot, thread } = ctx;
  const delivery = ctx.routineDelivery;
  if (!delivery || !run.routineId) return { deliver: true };
  const judgeInput: RoutineDeliveryJudgeInput = {
    botId: bot.id,
    threadId: thread.id,
    runId,
    spaceId: run.spaceId,
    userId: run.userId,
    routinePrompt: delivery.routinePrompt,
    priorReport: delivery.priorReport,
    candidateReply: redactSecrets(candidateReply, ctx.secrets),
    timezone: delivery.timezone,
    now: deps.now?.() ?? new Date(),
  };
  if (deps.routineDeliveryJudge) {
    try {
      return await deps.routineDeliveryJudge(judgeInput);
    } catch (error) {
      getLogger().warn("routine.delivery_judge_failed", {
        "run.id": runId,
        error: redactSecrets(error instanceof Error ? error.message : String(error), ctx.secrets),
      });
      return { deliver: true };
    }
  }
  return judgeRoutineDelivery(
    {
      prisma: deps.prisma,
      runtime: deps.runtime,
      model: delivery.model,
      secrets: ctx.secrets,
      signal: ctx.context.signal,
    },
    judgeInput,
  );
}
