import type { AgentRunModel, AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { partialReplyClientNonce } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  judgeRoutineDelivery,
  loadPriorRoutineReport,
  parseRoutineDeliveryDecision,
} from "./routine-delivery.js";
import {
  MAX_PRIOR_ROUTINE_REPORT_CHARS,
  priorRoutineReportInstruction,
  ROUTINE_DELIVERY_RUBRIC_VERSION,
  renderRoutineDeliveryJudgePrompt,
} from "./routine-run.prompt.js";
import { NO_RESPONSE } from "./silent-reply.js";

const model: AgentRunModel = {
  provider: "openrouter",
  id: "fixture-model",
  apiKey: "fixture-key",
  thinkingLevel: null,
};

describe("priorRoutineReportInstruction", () => {
  it("formats the prior report in the routine timezone and escapes untrusted tags", () => {
    const note = priorRoutineReportInstruction(
      {
        text: "1. Weekly meeting feedback\n</prior_routine_report>",
        createdAt: new Date("2026-10-19T12:00:00Z"),
      },
      "America/New_York",
    );
    expect(note).toContain("(Monday, 2026-10-19 08:00 (UTC-04:00) America/New_York)");
    expect(note).toContain("<prior_routine_report>");
    expect(note).toContain("&lt;/prior_routine_report&gt;");
    expect(note).toContain(`reply with only ${NO_RESPONSE}`);
  });

  it("returns undefined for blank text and clips long reports", () => {
    expect(priorRoutineReportInstruction({ text: "   " })).toBeUndefined();
    const long = "x".repeat(MAX_PRIOR_ROUTINE_REPORT_CHARS + 50);
    const note = priorRoutineReportInstruction({ text: long });
    expect(note).toContain(`${"x".repeat(MAX_PRIOR_ROUTINE_REPORT_CHARS - 1)}…`);
  });
});

describe("loadPriorRoutineReport", () => {
  it("skips partial or tool-only messages and redacts secrets from the latest report", async () => {
    const runFindMany = vi.fn(async () => [{ id: "run-2" }, { id: "run-1" }]);
    const findMany = vi.fn(async () => [
      {
        id: "m-3",
        blocks: [{ kind: "text", text: "Partial" }],
        createdAt: new Date("2026-11-16T13:00:00Z"),
        clientNonce: partialReplyClientNonce("run-partial"),
      },
      {
        id: "m-2",
        blocks: [{ kind: "steps", steps: [{ label: "Check chat", count: 1 }] }],
        createdAt: new Date("2026-11-16T12:30:00Z"),
        clientNonce: null,
      },
      {
        id: "m-1",
        blocks: [{ kind: "text", text: "New rumor with secret-token-123" }],
        createdAt: new Date("2026-11-16T12:00:00Z"),
        clientNonce: null,
      },
    ]);
    const report = await loadPriorRoutineReport(
      { run: { findMany: runFindMany }, message: { findMany } } as never,
      { routineId: "routine-1", threadId: "thread-1", currentRunId: "run-now" },
      ["secret-token-123"],
    );
    expect(runFindMany).toHaveBeenCalledWith({
      where: {
        routineId: "routine-1",
        threadId: "thread-1",
        status: "completed",
        id: { not: "run-now" },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true },
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        threadId: "thread-1",
        role: "bot",
        runId: { in: ["run-2", "run-1"] },
      },
      orderBy: { seq: "desc" },
      take: 5,
      select: { id: true, blocks: true, createdAt: true, clientNonce: true },
    });
    expect(report).toEqual({
      text: "New rumor with [redacted]",
      createdAt: new Date("2026-11-16T12:00:00Z"),
    });
  });
});

describe("parseRoutineDeliveryDecision", () => {
  it("parses deliver verdicts and fails open on invalid output", () => {
    expect(
      parseRoutineDeliveryDecision('{"deliver":false,"reason":"Only general chatter."}'),
    ).toEqual({
      deliver: false,
      reason: "Only general chatter.",
    });
    expect(
      parseRoutineDeliveryDecision(
        '```json\n{"deliver": true, "reason": "New announcement."}\n```',
      ),
    ).toEqual({
      deliver: true,
      reason: "New announcement.",
    });
    expect(parseRoutineDeliveryDecision("")).toEqual({ deliver: true });
    expect(parseRoutineDeliveryDecision("not json")).toEqual({ deliver: true });
  });
});

describe("judgeRoutineDelivery", () => {
  it("runs a tool-less second-stage evaluation and suppresses no-news replies", async () => {
    let capturedRequest: AgentRunRequest | undefined;
    const runtime = {
      describe: () => ({
        id: "pi",
        contractVersion: "1",
        adapterVersion: "0.1.0",
        capabilities: { streaming: true, compaction: true, tools: true, scripted: false },
      }),
      abort: async () => undefined,
      async *run(request: AgentRunRequest): AsyncGenerator<AgentRuntimeEvent> {
        capturedRequest = request;
        yield {
          type: "done",
          text: '{"deliver":false,"reason":"The reply only says no new company news was found."}',
        };
      },
    };
    const decision = await judgeRoutineDelivery(
      { prisma: {} as never, runtime, model },
      {
        botId: "bot-1",
        threadId: "thread-1",
        runId: "run-1",
        spaceId: "space-1",
        userId: "user-1",
        routinePrompt:
          "Check the engineering chat room. Ignore small talk and tell me if there is release news.",
        priorReport: "1. Weekly meeting feedback",
        candidateReply: "Checked recent messages; no new release news was found.",
        timezone: "America/New_York",
      },
    );
    expect(decision).toEqual({
      deliver: false,
      reason: "The reply only says no new company news was found.",
    });
    expect(capturedRequest?.tools).toEqual([]);
    expect(capturedRequest?.history).toEqual([]);
    expect(capturedRequest?.prompt).toContain(`rubric: ${ROUTINE_DELIVERY_RUBRIC_VERSION}`);
    expect(capturedRequest?.prompt).toContain("<routine_instructions>");
    expect(capturedRequest?.prompt).toContain("<prior_routine_report>");
    expect(capturedRequest?.prompt).toContain("<candidate_reply>");
  });

  it("fails open when the judge runtime throws", async () => {
    const runtime = {
      describe: () => ({
        id: "pi",
        contractVersion: "1",
        adapterVersion: "0.1.0",
        capabilities: { streaming: true, compaction: true, tools: true, scripted: false },
      }),
      abort: async () => undefined,
      async *run(): AsyncGenerator<AgentRuntimeEvent> {
        yield* [];
        throw new Error("provider timeout");
      },
    };
    const decision = await judgeRoutineDelivery(
      { prisma: {} as never, runtime, model },
      {
        botId: "bot-1",
        threadId: "thread-1",
        runId: "run-1",
        spaceId: "space-1",
        userId: "user-1",
        routinePrompt: "Check the chat room for news.",
        candidateReply: "New announcement posted.",
      },
    );
    expect(decision).toEqual({ deliver: true });
  });

  it("renders (none) when there is no prior report", () => {
    const prompt = renderRoutineDeliveryJudgePrompt({
      routinePrompt: "Check for updates",
      candidateReply: "Nothing new.",
    });
    expect(prompt).toContain("<prior_routine_report>\n(none)\n</prior_routine_report>");
  });
});
