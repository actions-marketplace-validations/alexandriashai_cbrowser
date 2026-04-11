/**
 * CBrowser - Goal Decomposition Types
 * Types for autonomous goal decomposition and execution.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 * @since v18.35.0
 */

// Re-export GoalType from site-model where it is canonically defined.
// This avoids duplication while keeping cognitive imports self-contained.
export type { GoalType } from "../site-model/types.js";
import type { GoalType } from "../site-model/types.js";

/**
 * Classification of what kind of information the user is seeking.
 * Only relevant when GoalType is "find_information".
 */
export type InformationType =
  | "temporal"
  | "spatial"
  | "procedural"
  | "factual"
  | "comparative";

/**
 * A natural language goal parsed into structured form.
 * The parser classifies the goal type, extracts keywords, and assigns confidence.
 */
export interface ParsedGoal {
  /** The original user-provided goal text */
  originalText: string;
  /** Classified goal type based on keyword matching */
  type: GoalType;
  /** Sub-classification for information-seeking goals */
  informationType?: InformationType;
  /** Extracted meaningful keywords (stop words removed) */
  keywords: string[];
  /** Parser confidence: 0.9 strong match, 0.7 partial, 0.5 fallback guess */
  confidence: number;
}

/**
 * A complete execution plan for achieving a goal.
 * Contains ordered sub-goals, each with multiple fallback strategies.
 */
export interface GoalPlan {
  /** The parsed goal this plan addresses */
  goal: ParsedGoal;
  /** Ordered sub-goals forming the execution path */
  subGoals: SubGoal[];
  /** Estimated total action count across all sub-goals */
  estimatedSteps: number;
  /** Overall plan confidence (product of sub-goal confidences) */
  confidence: number;
  /** How this plan was generated */
  source: "site-model" | "claude-api" | "heuristic";
}

/**
 * A discrete step in the goal plan.
 * Each sub-goal has multiple strategies tried in confidence-descending order.
 */
export interface SubGoal {
  /** Human-readable description of what this sub-goal achieves */
  description: string;
  /** Strategies to try, ordered by confidence (highest first) */
  strategies: Strategy[];
  /** Indices of prerequisite sub-goals that must complete first */
  dependencies: number[];
  /** How to verify this sub-goal succeeded */
  verificationCriteria: string;
  /** Whether this sub-goal has been completed during execution */
  completed: boolean;
}

/**
 * A specific approach to achieving a sub-goal.
 * Multiple strategies provide fallback paths when the primary approach fails.
 */
export interface Strategy {
  /** Human-readable strategy name (e.g., "navigation-based", "url-pattern") */
  name: string;
  /** Ordered sequence of browser actions to execute */
  actions: PlannedAction[];
  /** Confidence this strategy will succeed (0.0 - 1.0) */
  confidence: number;
  /** How this strategy was derived */
  source: "site-model" | "heuristic" | "claude-api";
}

/**
 * A single browser action within a strategy.
 * Maps directly to CBrowser automation primitives.
 */
export interface PlannedAction {
  /** The type of browser interaction */
  type:
    | "navigate"
    | "click"
    | "fill"
    | "select"
    | "scroll"
    | "wait"
    | "extract";
  /** CSS selector, URL, or descriptive target for the action */
  target: string;
  /** Value for fill/select actions, or data extraction key */
  value?: string;
  /** What we expect to see after this action succeeds */
  expectedOutcome: string;
  /** Maximum time to wait for this action to complete (ms) */
  timeout: number;
}

/**
 * The result of executing a goal plan.
 * Captures success/failure, evidence, and execution statistics.
 */
export interface GoalResult {
  /** Whether the overall goal was achieved */
  achieved: boolean;
  /** Evidence supporting the achievement (or lack thereof) */
  evidence: string[];
  /** Total number of individual actions executed */
  stepsExecuted: number;
  /** Number of distinct strategies attempted across all sub-goals */
  strategiesAttempted: number;
  /** How many sub-goals were completed */
  subGoalsCompleted: number;
  /** Total number of sub-goals in the plan */
  subGoalsTotal: number;
  /** Reason for failure, if goal was not achieved */
  failureReason?: string;
  /** The plan that was executed */
  plan: GoalPlan;
}

/**
 * Configuration options for goal execution.
 */
export interface ExecutionOptions {
  /** Maximum total actions before giving up (default: 15) */
  maxSteps: number;
  /** Maximum retries per sub-goal before moving to next strategy (default: 3) */
  maxRetries: number;
  /** Total timeout in milliseconds (default: 120000) */
  timeout: number;
  /** Optional persona for persona-aware path selection */
  persona?: string;
}

// ============================================================================
// Goal Classification Patterns
// ============================================================================

/**
 * Keyword patterns used to classify a natural language goal into a GoalType.
 * Matching is case-insensitive. Multiple matches are resolved by
 * longest-match-wins, with tie-breaking by pattern order.
 */
export const GOAL_PATTERNS: Record<GoalType, string[]> = {
  find_information: [
    "find",
    "what is",
    "where is",
    "when",
    "how much",
    "look up",
    "search for",
    "check",
    "get info",
    "learn about",
  ],
  complete_action: [
    "buy",
    "purchase",
    "sign up",
    "register",
    "subscribe",
    "book",
    "order",
    "apply",
    "submit",
    "enroll",
  ],
  navigate_to: [
    "go to",
    "open",
    "visit",
    "navigate to",
    "show me",
    "take me to",
  ],
  fill_form: [
    "fill",
    "complete the form",
    "enter",
    "type in",
    "input",
  ],
  compare: [
    "compare",
    "difference between",
    "which is better",
    "vs",
    "versus",
    "contrast",
  ],
  explore: [
    "explore",
    "browse",
    "look around",
    "discover",
    "see what",
  ],
  extract_data: [
    "extract",
    "scrape",
    "get all",
    "list all",
    "download",
    "export",
    "collect",
  ],
};

/**
 * Sub-patterns for classifying what kind of information a "find_information"
 * goal is seeking. Only applied when the primary GoalType is find_information.
 */
export const INFORMATION_PATTERNS: Record<InformationType, string[]> = {
  temporal: [
    "deadline",
    "date",
    "when",
    "schedule",
    "time",
    "hours",
    "calendar",
    "due",
    "expires",
  ],
  spatial: [
    "where",
    "location",
    "address",
    "map",
    "directions",
    "near",
    "closest",
  ],
  procedural: [
    "how to",
    "steps",
    "process",
    "procedure",
    "instructions",
    "guide",
    "tutorial",
  ],
  factual: [
    "what is",
    "who",
    "price",
    "cost",
    "phone",
    "email",
    "contact",
    "name",
  ],
  comparative: [
    "compare",
    "difference",
    "better",
    "best",
    "vs",
    "pros and cons",
    "review",
  ],
};
