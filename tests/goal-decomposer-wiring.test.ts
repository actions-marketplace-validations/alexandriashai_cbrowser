/**
 * GoalDecomposer must stay wired to the real SiteModelManager.
 *
 * It was exported from src/cognitive/index.ts and constructed NOWHERE in src/,
 * so `decompose()` -- the half that reads learned goalPaths and reuses any above
 * SITE_MODEL_MIN_SUCCESS_RATE -- could never run. goalPaths were write-only:
 * recorded by the autonomous-journey path, consulted by nothing. A learning loop
 * with no reader is a log.
 *
 * Wiring it immediately surfaced two contract drifts that had been invisible for
 * as long as the class was dead, because the two sides were never type-checked
 * against each other:
 *
 *   recordGoalPath  interface said 5 args; manager takes 7 (success, steps added)
 *   recordFailure   interface omitted `selector`, which sits THIRD -- so the one
 *                   call site passed its failureType into the selector slot and
 *                   its conditions array into the failureType slot, with
 *                   "goal_execution_failed" not even being a member of the
 *                   manager's FailureType union
 *
 * The structural test at the bottom is the one that matters most: it asserts the
 * real manager still satisfies the interface, so the next drift fails here
 * instead of lying dormant.
 */
import { describe, test, expect } from "bun:test";
import { GoalDecomposer, type SiteModelManagerLike } from "../src/cognitive/goal-decomposer.js";
import type { GoalPath } from "../src/site-model/types.js";

type Call = { method: string; args: unknown[] };

function spyManager(bestPath: GoalPath | null = null) {
  const calls: Call[] = [];
  const mgr: SiteModelManagerLike = {
    queryBestPath: (...args) => { calls.push({ method: "queryBestPath", args }); return bestPath; },
    recordGoalPath: (...args) => { calls.push({ method: "recordGoalPath", args }); },
    recordFailure: (...args) => { calls.push({ method: "recordFailure", args }); },
  };
  return { mgr, calls };
}

describe("GoalDecomposer parses natural language into a goal type", () => {
  test("a signup goal classifies, so callers need not know the enum", () => {
    const { mgr } = spyManager();
    const parsed = new GoalDecomposer(mgr).parseGoal("sign up for an account");
    expect(parsed.type).toBeTruthy();
    expect(parsed.originalText).toBe("sign up for an account");
    expect(Array.isArray(parsed.keywords)).toBe(true);
  });

  test("decompose consults the site model before falling back to heuristics", async () => {
    const { mgr, calls } = spyManager(null);
    const plan = await new GoalDecomposer(mgr).decompose("find the pricing page", "example.com");
    // The read side firing at all is the thing that was impossible before.
    expect(calls.some((c) => c.method === "queryBestPath")).toBe(true);
    expect(plan.source).toBe("heuristic");
    expect(plan.subGoals.length).toBeGreaterThan(0);
  });

  test("a learned path above the success floor is reused instead of re-planned", async () => {
    const learned = {
      goalDescription: "find the pricing page",
      goalType: "find_information",
      successRate: 0.9,
      attemptCount: 10,
      averageSteps: 3,
      lastUsed: Date.now(),
      actionSequence: [
        { type: "navigate", target: "/pricing", expectedOutcome: "pricing visible" },
      ],
      personaPerformance: {},
    } as unknown as GoalPath;
    const { mgr } = spyManager(learned);
    const plan = await new GoalDecomposer(mgr).decompose("find the pricing page", "example.com");
    expect(plan.source).toBe("site-model");
  });
});

describe("recordOutcome passes the arguments the manager actually takes", () => {
  const planStub = {
    goal: { originalText: "sign up", type: "complete_action", keywords: [], confidence: 1 },
    subGoals: [], estimatedSteps: 2, confidence: 1, source: "heuristic",
  };

  test("success records a goal path WITH success and steps", async () => {
    const { mgr, calls } = spyManager();
    await new GoalDecomposer(mgr).recordOutcome("example.com", {
      achieved: true, evidence: [], stepsExecuted: 4, strategiesAttempted: 1,
      subGoalsCompleted: 1, subGoalsTotal: 1, plan: planStub,
    } as never);

    const rec = calls.find((c) => c.method === "recordGoalPath");
    expect(rec).toBeDefined();
    // 7-arg shape: domain, description, type, actions, success, steps, persona?
    expect(rec!.args[4]).toBe(true);      // success — was missing entirely
    expect(rec!.args[5]).toBe(4);         // steps  — was missing entirely
  });

  test("failure records with selector THIRD and a valid failure type", async () => {
    const { mgr, calls } = spyManager();
    await new GoalDecomposer(mgr).recordOutcome("example.com", {
      achieved: false, evidence: [], stepsExecuted: 2, strategiesAttempted: 3,
      subGoalsCompleted: 0, subGoalsTotal: 2, failureReason: "no such element",
      plan: planStub,
    } as never);

    const rec = calls.find((c) => c.method === "recordFailure");
    expect(rec).toBeDefined();
    // The bug: "goal_execution_failed" used to land in args[2], the selector.
    expect(rec!.args[2]).toBeUndefined();
    // And it is not a member of the manager's FailureType union, so it moved
    // into conditions where free-form detail belongs.
    expect(rec!.args[3]).toBe("navigation_error");
    expect(rec!.args[4]).toContain("reason:goal_execution_failed");
  });

  test("extract actions are dropped, not coerced into a type the store lacks", async () => {
    const { mgr, calls } = spyManager();
    await new GoalDecomposer(mgr).recordOutcome("example.com", {
      achieved: true, evidence: [], stepsExecuted: 1, strategiesAttempted: 1,
      subGoalsCompleted: 1, subGoalsTotal: 1,
      plan: {
        ...planStub,
        subGoals: [{
          description: "grab it", completed: true,
          strategies: [{
            confidence: 1, used: true, succeeded: true,
            actions: [
              { type: "click", target: "#go", expectedOutcome: "ok", timeout: 1000 },
              { type: "extract", target: "price", expectedOutcome: "value", timeout: 1000 },
            ],
          }],
        }],
      },
    } as never);

    const rec = calls.find((c) => c.method === "recordGoalPath");
    const actions = rec!.args[3] as Array<{ type: string; timeout?: number }>;
    expect(actions.every((a) => a.type !== "extract")).toBe(true);
    // `timeout` is an execution detail, not a learned fact.
    expect(actions.every((a) => a.timeout === undefined)).toBe(true);
  });
});

describe("the interface still matches the real manager", () => {
  test("SiteModelManager satisfies SiteModelManagerLike", async () => {
    // This is the test that would have caught both drifts. Assigning the real
    // class to the interface is a compile-time check, so it is expressed as a
    // runtime shape check plus the tsc gate the suite already runs.
    const { SiteModelManager } = await import("../src/site-model/manager.js");
    const real = SiteModelManager.getInstance();
    const asInterface: SiteModelManagerLike = real;
    expect(typeof asInterface.queryBestPath).toBe("function");
    expect(typeof asInterface.recordGoalPath).toBe("function");
    expect(typeof asInterface.recordFailure).toBe("function");
    // Arity is the thing that drifted, and it is observable at runtime.
    expect(real.recordGoalPath.length).toBe(7);
    expect(real.recordFailure.length).toBe(5);
  });
});
