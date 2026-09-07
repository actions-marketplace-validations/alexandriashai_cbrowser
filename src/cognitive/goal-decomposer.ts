/**
 * CBrowser - Goal Decomposer
 * Transforms user goals into executable sub-goal trees with fallback strategies.
 * Uses site model for informed planning, Claude API for novel goals.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 * @since v18.35.0
 */

import type {
  GoalType,
  InformationType,
  ParsedGoal,
  GoalPlan,
  GoalResult,
  SubGoal,
  Strategy,
  PlannedAction,
} from "./goal-types.js";
import {
  GOAL_PATTERNS,
  INFORMATION_PATTERNS,
} from "./goal-types.js";
import type { GoalPath } from "../site-model/types.js";
import { getAnthropicApiKey, isApiKeyConfigured } from "./index.js";

// ============================================================================
// Site Model Manager Interface
// ============================================================================

/**
 * The site model's failure vocabulary. Mirrored here rather than imported, for
 * the same circular-import reason the rest of this interface exists. Note this
 * is NOT the identically-named `FailureType` in src/testing — that one has
 * `selector_not_found` where this has `element_not_found`.
 */
export type SiteModelFailureType =
  | "element_not_found"
  | "timeout"
  | "navigation_error"
  | "blocked_by_overlay"
  | "auth_required"
  | "captcha"
  | "rate_limited";

/**
 * The action shape the site model actually stores. Narrower than
 * `PlannedAction`: no "extract" (the model records browser interactions, not
 * data reads) and no `timeout` (an execution detail, not a learned fact).
 */
export interface RecordableAction {
  type: "navigate" | "click" | "fill" | "select" | "scroll" | "wait";
  target: string;
  value?: string;
  expectedOutcome: string;
}

/**
 * Minimal interface for the SiteModelManager dependency.
 * Defined here to avoid circular imports -- the concrete class lives in
 * src/site-model/manager.ts.
 *
 * This header used to read "(not yet implemented). When the real manager ships,
 * it must satisfy this contract." The manager shipped and did NOT satisfy it:
 * `recordGoalPath` grew `success` and `steps` parameters and narrowed its action
 * type, and nothing caught it, because `GoalDecomposer` was never constructed
 * anywhere in src/ -- so the two sides were never type-checked against each
 * other. The drift surfaced the instant the class was wired to a tool.
 *
 * Which is the argument for wiring it rather than deleting it: an interface with
 * no implementor is not a contract, it is a comment. (2026-08-05)
 */
export interface SiteModelManagerLike {
  /** Query for the best known path matching a goal type on a domain */
  queryBestPath(domain: string, goalType: GoalType): GoalPath | null;
  /** Record a goal execution path. Failures count too -- successRate needs both. */
  recordGoalPath(
    domain: string,
    goalDescription: string,
    goalType: GoalType,
    actions: RecordableAction[],
    success: boolean,
    steps: number,
    persona?: string,
  ): void;
  /**
   * Record a failure pattern for future avoidance.
   *
   * `selector` sits THIRD. The stale version of this interface omitted it, so
   * the only call site passed its failure type into the selector slot and its
   * conditions array into the failure-type slot — silently, because nothing
   * type-checked the two sides against each other. See the note above.
   */
  recordFailure(
    domain: string,
    pageUrl: string,
    selector: string | undefined,
    failureType: SiteModelFailureType,
    conditions: string[],
  ): void;
}

// ============================================================================
// Constants
// ============================================================================

/** Common URL patterns mapped from semantic intent to likely paths */
const URL_PATTERNS: Record<string, string[]> = {
  pricing: ["/pricing", "/plans", "/packages"],
  contact: ["/contact", "/contact-us", "/about"],
  about: ["/about", "/about-us", "/company"],
  help: ["/help", "/support", "/faq"],
  login: ["/login", "/signin", "/auth"],
  signup: ["/signup", "/register", "/join"],
  admissions: ["/admissions", "/apply", "/enrollment"],
  careers: ["/careers", "/jobs", "/hiring"],
  docs: ["/docs", "/documentation", "/api"],
  blog: ["/blog", "/news", "/articles"],
  search: ["/search", "/find", "/results"],
  settings: ["/settings", "/account", "/profile"],
  privacy: ["/privacy", "/privacy-policy"],
  terms: ["/terms", "/terms-of-service", "/tos"],
};

/**
 * English stop words to strip when extracting meaningful keywords from goals.
 * Kept deliberately minimal -- we want to be aggressive about retaining
 * domain-relevant words even if they look like common words.
 */
const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "all", "each", "every", "both", "few",
  "more", "most", "other", "some", "such", "no", "nor", "not", "only",
  "own", "same", "so", "than", "too", "very", "just", "because",
  "but", "and", "or", "if", "while", "although", "that", "this",
  "these", "those", "i", "me", "my", "we", "our", "you", "your",
  "it", "its", "they", "them", "their", "what", "which", "who",
  "whom", "whose", "when", "where", "why", "how", "any",
]);

/** Default action timeout in ms */
const DEFAULT_ACTION_TIMEOUT = 10_000;

/** Minimum site model success rate to trust a known path */
const SITE_MODEL_MIN_SUCCESS_RATE = 0.6;

// ============================================================================
// GoalDecomposer Class
// ============================================================================

/**
 * Transforms natural-language user goals into structured, executable plans.
 *
 * Planning priority:
 * 1. Site model -- if we have seen this domain before and have a path with
 *    >60% success rate, we reuse it.
 * 2. Heuristic -- keyword-driven strategy generation using common web patterns.
 * 3. Claude API -- future enhancement for truly novel goals (TODO).
 */
export class GoalDecomposer {
  private siteModelManager: SiteModelManagerLike;

  constructor(siteModelManager: SiteModelManagerLike) {
    this.siteModelManager = siteModelManager;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Parse a natural language goal into a structured ParsedGoal.
   *
   * Classification pipeline:
   * 1. Lowercase and normalize the goal text.
   * 2. Match against GOAL_PATTERNS to determine GoalType.
   *    - Longest matching phrase wins.
   *    - Ties broken by declaration order in the patterns object.
   * 3. If GoalType is "find_information", sub-classify via INFORMATION_PATTERNS.
   * 4. Extract keywords by stripping stop words from the original text.
   * 5. Assign confidence based on match strength.
   */
  parseGoal(goal: string): ParsedGoal {
    const normalized = goal.toLowerCase().trim();

    // Classify the goal type
    const { type, confidence: typeConfidence } =
      this.classifyGoalType(normalized);

    // Sub-classify information type if applicable
    let informationType: InformationType | undefined;
    if (type === "find_information") {
      informationType = this.classifyInformationType(normalized);
    }

    // Extract meaningful keywords
    const keywords = this.extractKeywords(normalized);

    return {
      originalText: goal,
      type,
      informationType,
      keywords,
      confidence: typeConfidence,
    };
  }

  /**
   * Generate a complete execution plan for a goal on a specific domain.
   *
   * Strategy:
   * 1. Parse the goal.
   * 2. Check site model for known successful paths.
   * 3. If no site model coverage, generate heuristic strategies.
   * 4. Future: fall back to Claude API for truly novel goals.
   */
  async decompose(goal: string, domain: string): Promise<GoalPlan> {
    const parsedGoal = this.parseGoal(goal);

    // Attempt 1: Site model -- reuse known successful paths
    const knownPath = this.siteModelManager.queryBestPath(
      domain,
      parsedGoal.type,
    );

    if (knownPath && knownPath.successRate >= SITE_MODEL_MIN_SUCCESS_RATE) {
      return this.buildSiteModelPlan(parsedGoal, knownPath, domain);
    }

    // Attempt 2: Heuristic -- generate strategies from patterns
    const heuristicPlan = this.buildHeuristicPlan(parsedGoal, domain);

    // TODO: Attempt 3 -- Claude API for novel goals.
    // When implemented, this would call the Anthropic API to generate
    // a custom plan for goals that don't match any heuristic pattern.
    // Gated behind isApiKeyConfigured() check.
    // For now, the heuristic plan is always returned.

    return heuristicPlan;
  }

  /**
   * Record the outcome of a goal execution back to the site model.
   * This closes the learning loop: successful paths get reinforced,
   * failures get cataloged for future avoidance.
   */
  async recordOutcome(domain: string, result: GoalResult): Promise<void> {
    if (result.achieved) {
      // Extract the actions from the first successfully used strategy
      // across all completed sub-goals
      const successfulActions = this.extractSuccessfulActions(result);

      this.siteModelManager.recordGoalPath(
        domain,
        result.plan.goal.originalText,
        result.plan.goal.type,
        // "extract" is a data read, not a browser interaction the model can
        // replay, so it is dropped rather than coerced into a type the store
        // does not have. `timeout` is an execution detail, not a learned fact.
        successfulActions
          .filter((a): a is PlannedAction & { type: RecordableAction["type"] } => a.type !== "extract")
          .map(({ type, target, value, expectedOutcome }) => ({ type, target, value, expectedOutcome })),
        // These two were simply missing. The manager needs them to maintain
        // successRate and averageSteps; omitting them left both undefined at the
        // call site, which TypeScript never flagged because the interface this
        // call checked against was itself stale.
        true,
        result.stepsExecuted,
      );
    } else {
      // Record failure patterns so future plans can avoid them
      const failureConditions = [
        `goal_type:${result.plan.goal.type}`,
        `steps_executed:${result.stepsExecuted}`,
        `strategies_attempted:${result.strategiesAttempted}`,
        `sub_goals_completed:${result.subGoalsCompleted}/${result.subGoalsTotal}`,
      ];

      if (result.failureReason) {
        failureConditions.push(`reason:${result.failureReason}`);
      }

      this.siteModelManager.recordFailure(
        domain,
        domain, // page URL defaults to domain root for goal-level failures
        // No selector: this is a goal-level failure, not an element-level one.
        // Previously "goal_execution_failed" was passed here, into the SELECTOR
        // slot, and the conditions array landed in failureType.
        undefined,
        // "goal_execution_failed" is not a member of the site model's failure
        // vocabulary, so it moves into `conditions` where free-form detail
        // belongs. navigation_error is the honest closest fit: the persona could
        // not traverse to the goal.
        "navigation_error",
        ["reason:goal_execution_failed", ...failureConditions],
      );
    }
  }

  // --------------------------------------------------------------------------
  // Goal Classification (Private)
  // --------------------------------------------------------------------------

  /**
   * Classify goal text against GOAL_PATTERNS.
   * Uses longest-match-wins to resolve ambiguity.
   */
  private classifyGoalType(normalizedGoal: string): {
    type: GoalType;
    confidence: number;
  } {
    let bestType: GoalType = "find_information"; // safe default
    let bestMatchLength = 0;
    let matchFound = false;

    const goalTypes = Object.keys(GOAL_PATTERNS) as GoalType[];

    for (const goalType of goalTypes) {
      const patterns = GOAL_PATTERNS[goalType];
      for (const pattern of patterns) {
        if (normalizedGoal.includes(pattern)) {
          if (pattern.length > bestMatchLength) {
            bestMatchLength = pattern.length;
            bestType = goalType;
            matchFound = true;
          }
        }
      }
    }

    // Assign confidence based on match quality
    let confidence: number;
    if (matchFound && bestMatchLength >= 6) {
      // Strong match: multi-word pattern like "sign up", "navigate to"
      confidence = 0.9;
    } else if (matchFound) {
      // Partial match: short keyword like "find", "buy", "open"
      confidence = 0.7;
    } else {
      // No keyword match at all -- guessing find_information as safest default
      confidence = 0.5;
    }

    return { type: bestType, confidence };
  }

  /**
   * Sub-classify an information-seeking goal by the kind of information sought.
   */
  private classifyInformationType(
    normalizedGoal: string,
  ): InformationType | undefined {
    let bestType: InformationType | undefined;
    let bestMatchLength = 0;

    const infoTypes = Object.keys(
      INFORMATION_PATTERNS,
    ) as InformationType[];

    for (const infoType of infoTypes) {
      const patterns = INFORMATION_PATTERNS[infoType];
      for (const pattern of patterns) {
        if (normalizedGoal.includes(pattern)) {
          if (pattern.length > bestMatchLength) {
            bestMatchLength = pattern.length;
            bestType = infoType;
          }
        }
      }
    }

    return bestType;
  }

  /**
   * Extract meaningful keywords from goal text.
   * Strips stop words, punctuation, and deduplicates.
   */
  private extractKeywords(normalizedGoal: string): string[] {
    const words = normalizedGoal
      .replace(/[^\w\s-]/g, " ") // strip punctuation except hyphens
      .split(/\s+/)
      .filter((w) => w.length > 1) // drop single characters
      .filter((w) => !STOP_WORDS.has(w)); // drop stop words

    // Deduplicate while preserving order
    return [...new Set(words)];
  }

  // --------------------------------------------------------------------------
  // Plan Builders (Private)
  // --------------------------------------------------------------------------

  /**
   * Build a plan from a known site model path.
   * The site model path represents a previously successful execution,
   * so we wrap it as a high-confidence strategy.
   */
  private buildSiteModelPlan(
    parsedGoal: ParsedGoal,
    knownPath: GoalPath,
    domain: string,
  ): GoalPlan {
    const siteModelActions: PlannedAction[] = knownPath.actionSequence.map(
      (action) => ({
        type: action.type === "wait" ? "wait" : action.type,
        target: action.target,
        value: action.value,
        expectedOutcome: action.expectedOutcome,
        timeout: DEFAULT_ACTION_TIMEOUT,
      }),
    );

    const siteModelStrategy: Strategy = {
      name: "site-model-known-path",
      actions: siteModelActions,
      confidence: knownPath.successRate,
      source: "site-model",
    };

    // Still generate heuristic fallbacks in case the known path has degraded
    const fallbackStrategies = this.generateAllStrategies(parsedGoal, domain);

    const subGoal: SubGoal = {
      description: `Execute known path: ${knownPath.goalDescription}`,
      strategies: [siteModelStrategy, ...fallbackStrategies],
      dependencies: [],
      verificationCriteria: `Goal "${parsedGoal.originalText}" achieved with evidence`,
      completed: false,
    };

    const estimatedSteps = siteModelActions.length;

    return {
      goal: parsedGoal,
      subGoals: [subGoal],
      estimatedSteps,
      confidence: knownPath.successRate * parsedGoal.confidence,
      source: "site-model",
    };
  }

  /**
   * Build a heuristic plan based on goal type.
   * Each goal type gets a structured set of sub-goals with
   * navigation, URL-pattern, and search fallback strategies.
   */
  private buildHeuristicPlan(
    parsedGoal: ParsedGoal,
    domain: string,
  ): GoalPlan {
    let subGoals: SubGoal[];

    switch (parsedGoal.type) {
      case "find_information":
        subGoals = this.buildFindInformationSubGoals(parsedGoal, domain);
        break;
      case "complete_action":
        subGoals = this.buildCompleteActionSubGoals(parsedGoal, domain);
        break;
      case "navigate_to":
        subGoals = this.buildNavigateToSubGoals(parsedGoal, domain);
        break;
      case "fill_form":
        subGoals = this.buildFillFormSubGoals(parsedGoal, domain);
        break;
      case "compare":
        subGoals = this.buildCompareSubGoals(parsedGoal, domain);
        break;
      case "explore":
        subGoals = this.buildExploreSubGoals(parsedGoal, domain);
        break;
      case "extract_data":
        subGoals = this.buildExtractDataSubGoals(parsedGoal, domain);
        break;
      default: {
        // Exhaustiveness check -- should never happen
        const _exhaustive: never = parsedGoal.type;
        subGoals = this.buildFindInformationSubGoals(parsedGoal, domain);
      }
    }

    const estimatedSteps = subGoals.reduce(
      (sum, sg) =>
        sum +
        Math.max(
          ...sg.strategies.map((s) => s.actions.length),
          1,
        ),
      0,
    );

    // Overall confidence is the product of sub-goal max strategy confidences
    const confidence = subGoals.reduce((product, sg) => {
      const maxStrategyConfidence = Math.max(
        ...sg.strategies.map((s) => s.confidence),
        0.1,
      );
      return product * maxStrategyConfidence;
    }, parsedGoal.confidence);

    return {
      goal: parsedGoal,
      subGoals,
      estimatedSteps,
      confidence: Math.round(confidence * 100) / 100,
      source: "heuristic",
    };
  }

  // --------------------------------------------------------------------------
  // Sub-Goal Builders by GoalType (Private)
  // --------------------------------------------------------------------------

  private buildFindInformationSubGoals(
    parsedGoal: ParsedGoal,
    domain: string,
  ): SubGoal[] {
    return [
      {
        description: "Navigate to the page most likely containing the information",
        strategies: this.generateAllStrategies(parsedGoal, domain),
        dependencies: [],
        verificationCriteria:
          "Landed on a page whose content relates to the goal keywords",
        completed: false,
      },
      {
        description: "Scan page content for relevant information",
        strategies: [
          {
            name: "keyword-scan",
            actions: [
              {
                type: "extract",
                target: "body",
                value: parsedGoal.keywords.join(", "),
                expectedOutcome:
                  "Found text matching one or more goal keywords",
                timeout: DEFAULT_ACTION_TIMEOUT,
              },
            ],
            confidence: 0.7,
            source: "heuristic",
          },
          {
            name: "scroll-and-scan",
            actions: [
              {
                type: "scroll",
                target: "down",
                expectedOutcome: "More content visible",
                timeout: 5_000,
              },
              {
                type: "extract",
                target: "body",
                value: parsedGoal.keywords.join(", "),
                expectedOutcome:
                  "Found text matching goal keywords after scrolling",
                timeout: DEFAULT_ACTION_TIMEOUT,
              },
            ],
            confidence: 0.5,
            source: "heuristic",
          },
        ],
        dependencies: [0], // depends on navigation sub-goal
        verificationCriteria:
          "Extracted text that answers the user's question",
        completed: false,
      },
      {
        description: "Extract and return the found information",
        strategies: [
          {
            name: "extract-answer",
            actions: [
              {
                type: "extract",
                target: "main, article, .content, #content, body",
                value: "answer",
                expectedOutcome:
                  "Structured extraction of the answer to the goal",
                timeout: DEFAULT_ACTION_TIMEOUT,
              },
            ],
            confidence: 0.8,
            source: "heuristic",
          },
        ],
        dependencies: [1], // depends on scan sub-goal
        verificationCriteria:
          "Goal information captured in evidence array",
        completed: false,
      },
    ];
  }

  private buildCompleteActionSubGoals(
    parsedGoal: ParsedGoal,
    domain: string,
  ): SubGoal[] {
    return [
      {
        description: "Navigate to the action page (e.g., signup, checkout, booking)",
        strategies: this.generateAllStrategies(parsedGoal, domain),
        dependencies: [],
        verificationCriteria:
          "On a page with a form or CTA matching the intended action",
        completed: false,
      },
      {
        description: "Fill in required fields on the action form",
        strategies: [
          {
            name: "form-fill",
            actions: [
              {
                type: "fill",
                target: "form input:not([type=hidden]):not([type=submit])",
                value: "auto-detect",
                expectedOutcome: "Required form fields populated",
                timeout: DEFAULT_ACTION_TIMEOUT,
              },
            ],
            confidence: 0.6,
            source: "heuristic",
          },
        ],
        dependencies: [0],
        verificationCriteria: "Form fields are filled and valid",
        completed: false,
      },
      {
        description: "Submit the action",
        strategies: [
          {
            name: "click-submit",
            actions: [
              {
                type: "click",
                target:
                  'button[type="submit"], input[type="submit"], .btn-primary, [data-action="submit"]',
                expectedOutcome:
                  "Form submitted, confirmation or next step shown",
                timeout: DEFAULT_ACTION_TIMEOUT,
              },
            ],
            confidence: 0.7,
            source: "heuristic",
          },
          {
            name: "click-cta",
            actions: [
              {
                type: "click",
                target:
                  "a.cta, button.cta, .btn-action, [role=button]",
                expectedOutcome: "Action completed or progressed",
                timeout: DEFAULT_ACTION_TIMEOUT,
              },
            ],
            confidence: 0.5,
            source: "heuristic",
          },
        ],
        dependencies: [1],
        verificationCriteria:
          "Success message, confirmation page, or next step in flow",
        completed: false,
      },
    ];
  }

  private buildNavigateToSubGoals(
    parsedGoal: ParsedGoal,
    domain: string,
  ): SubGoal[] {
    return [
      {
        description: `Navigate to the target: ${parsedGoal.keywords.join(" ")}`,
        strategies: this.generateAllStrategies(parsedGoal, domain),
        dependencies: [],
        verificationCriteria:
          "Current URL or page title matches the navigation target",
        completed: false,
      },
    ];
  }

  private buildFillFormSubGoals(
    parsedGoal: ParsedGoal,
    domain: string,
  ): SubGoal[] {
    return [
      {
        description: "Navigate to the page containing the form",
        strategies: this.generateAllStrategies(parsedGoal, domain),
        dependencies: [],
        verificationCriteria: "Page with a visible form loaded",
        completed: false,
      },
      {
        description: "Identify and fill form fields",
        strategies: [
          {
            name: "sequential-fill",
            actions: [
              {
                type: "fill",
                target: "form",
                value: "auto-detect-from-labels",
                expectedOutcome: "All visible form fields populated",
                timeout: DEFAULT_ACTION_TIMEOUT * 2,
              },
            ],
            confidence: 0.6,
            source: "heuristic",
          },
        ],
        dependencies: [0],
        verificationCriteria: "Form fields populated, no validation errors",
        completed: false,
      },
    ];
  }

  private buildCompareSubGoals(
    parsedGoal: ParsedGoal,
    domain: string,
  ): SubGoal[] {
    return [
      {
        description: "Navigate to comparison or product listing page",
        strategies: this.generateAllStrategies(parsedGoal, domain),
        dependencies: [],
        verificationCriteria: "On a page with multiple items to compare",
        completed: false,
      },
      {
        description: "Extract comparison data points",
        strategies: [
          {
            name: "table-extract",
            actions: [
              {
                type: "extract",
                target: "table, .comparison, .pricing-table, [class*=compare]",
                value: "comparison-data",
                expectedOutcome: "Structured comparison data extracted",
                timeout: DEFAULT_ACTION_TIMEOUT,
              },
            ],
            confidence: 0.6,
            source: "heuristic",
          },
          {
            name: "card-extract",
            actions: [
              {
                type: "extract",
                target: ".card, .plan, .product, .feature-list",
                value: "comparison-data",
                expectedOutcome: "Product/plan details extracted from cards",
                timeout: DEFAULT_ACTION_TIMEOUT,
              },
            ],
            confidence: 0.5,
            source: "heuristic",
          },
        ],
        dependencies: [0],
        verificationCriteria: "At least 2 items extracted for comparison",
        completed: false,
      },
    ];
  }

  private buildExploreSubGoals(
    parsedGoal: ParsedGoal,
    domain: string,
  ): SubGoal[] {
    return [
      {
        description: "Start from the site homepage or main listing",
        strategies: [
          {
            name: "go-home",
            actions: [
              {
                type: "navigate",
                target: `https://${domain}`,
                expectedOutcome: "Homepage loaded",
                timeout: DEFAULT_ACTION_TIMEOUT,
              },
            ],
            confidence: 0.9,
            source: "heuristic",
          },
        ],
        dependencies: [],
        verificationCriteria: "Homepage or main page loaded",
        completed: false,
      },
      {
        description: "Explore navigation and key sections",
        strategies: [
          {
            name: "nav-crawl",
            actions: [
              {
                type: "extract",
                target: "nav a, header a, .menu a, [role=navigation] a",
                value: "navigation-links",
                expectedOutcome: "Site navigation structure mapped",
                timeout: DEFAULT_ACTION_TIMEOUT,
              },
              {
                type: "click",
                target: "nav a",
                expectedOutcome: "Navigated to a section of interest",
                timeout: DEFAULT_ACTION_TIMEOUT,
              },
            ],
            confidence: 0.7,
            source: "heuristic",
          },
        ],
        dependencies: [0],
        verificationCriteria: "Visited at least 2 distinct pages",
        completed: false,
      },
    ];
  }

  private buildExtractDataSubGoals(
    parsedGoal: ParsedGoal,
    domain: string,
  ): SubGoal[] {
    return [
      {
        description: "Navigate to the data source page",
        strategies: this.generateAllStrategies(parsedGoal, domain),
        dependencies: [],
        verificationCriteria:
          "On a page containing the target data (table, list, grid)",
        completed: false,
      },
      {
        description: "Extract structured data from the page",
        strategies: [
          {
            name: "table-extract",
            actions: [
              {
                type: "extract",
                target: "table, .data-table, [role=grid]",
                value: "structured-data",
                expectedOutcome: "Tabular data extracted",
                timeout: DEFAULT_ACTION_TIMEOUT,
              },
            ],
            confidence: 0.7,
            source: "heuristic",
          },
          {
            name: "list-extract",
            actions: [
              {
                type: "extract",
                target: "ul, ol, .list, .results, [role=list]",
                value: "list-data",
                expectedOutcome: "List data extracted",
                timeout: DEFAULT_ACTION_TIMEOUT,
              },
            ],
            confidence: 0.6,
            source: "heuristic",
          },
          {
            name: "paginated-extract",
            actions: [
              {
                type: "extract",
                target: "table, .results, [role=grid]",
                value: "page-1-data",
                expectedOutcome: "First page of data extracted",
                timeout: DEFAULT_ACTION_TIMEOUT,
              },
              {
                type: "click",
                target:
                  '.next, .pagination a:last-child, [aria-label="Next"], a[rel="next"]',
                expectedOutcome: "Navigated to next page of results",
                timeout: DEFAULT_ACTION_TIMEOUT,
              },
              {
                type: "extract",
                target: "table, .results, [role=grid]",
                value: "page-2-data",
                expectedOutcome: "Second page of data extracted",
                timeout: DEFAULT_ACTION_TIMEOUT,
              },
            ],
            confidence: 0.4,
            source: "heuristic",
          },
        ],
        dependencies: [0],
        verificationCriteria:
          "Data extracted with at least 1 row or item",
        completed: false,
      },
    ];
  }

  // --------------------------------------------------------------------------
  // Strategy Generators (Private)
  // --------------------------------------------------------------------------

  /**
   * Generate all three heuristic strategies for a goal:
   * navigation-based, URL-pattern-based, and search-based.
   * Returned in confidence-descending order.
   */
  private generateAllStrategies(
    parsedGoal: ParsedGoal,
    domain: string,
  ): Strategy[] {
    return [
      this.generateNavStrategy(parsedGoal),
      this.generateUrlStrategy(parsedGoal, domain),
      this.generateSearchStrategy(parsedGoal),
    ].sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Generate a navigation-based strategy.
   * Clicks on nav links whose text matches the goal keywords.
   */
  private generateNavStrategy(parsedGoal: ParsedGoal): Strategy {
    const keywords = parsedGoal.keywords;

    // Build CSS selectors that match nav links containing goal keywords.
    // We try exact text matches first, then broader link text searches.
    const navSelectors = keywords.flatMap((keyword) => [
      `nav a:has-text("${keyword}")`,
      `header a:has-text("${keyword}")`,
      `a[href*="${keyword}"]`,
    ]);

    const actions: PlannedAction[] = [];

    // First: try clicking a nav link that matches the best keyword
    if (navSelectors.length > 0) {
      actions.push({
        type: "click",
        target: navSelectors[0],
        expectedOutcome: `Navigated to a page related to "${keywords[0]}"`,
        timeout: DEFAULT_ACTION_TIMEOUT,
      });
    }

    // Fallback: click any visible link containing the first keyword
    if (keywords.length > 0) {
      actions.push({
        type: "click",
        target: `a:has-text("${keywords[0]}")`,
        expectedOutcome: `Clicked a link containing "${keywords[0]}"`,
        timeout: DEFAULT_ACTION_TIMEOUT,
      });
    }

    return {
      name: "navigation-based",
      actions:
        actions.length > 0
          ? actions
          : [
              {
                type: "click",
                target: "nav a",
                expectedOutcome: "Clicked first nav link as blind guess",
                timeout: DEFAULT_ACTION_TIMEOUT,
              },
            ],
      confidence: keywords.length > 0 ? 0.7 : 0.3,
      source: "heuristic",
    };
  }

  /**
   * Generate a URL-pattern strategy.
   * Tries direct navigation to common URL patterns matching the goal keywords.
   */
  private generateUrlStrategy(
    parsedGoal: ParsedGoal,
    domain: string,
  ): Strategy {
    const keywords = parsedGoal.keywords;
    const actions: PlannedAction[] = [];

    // Look for keywords that match known URL pattern categories
    for (const keyword of keywords) {
      const normalizedKeyword = keyword.toLowerCase();

      // Check exact match against URL_PATTERNS keys
      if (URL_PATTERNS[normalizedKeyword]) {
        for (const path of URL_PATTERNS[normalizedKeyword]) {
          actions.push({
            type: "navigate",
            target: `https://${domain}${path}`,
            expectedOutcome: `Loaded the ${normalizedKeyword} page at ${path}`,
            timeout: DEFAULT_ACTION_TIMEOUT,
          });
        }
        break; // Use the first matching pattern category
      }

      // Check partial match: "pricing info" matches "pricing"
      for (const [category, paths] of Object.entries(URL_PATTERNS)) {
        if (
          normalizedKeyword.includes(category) ||
          category.includes(normalizedKeyword)
        ) {
          for (const path of paths) {
            actions.push({
              type: "navigate",
              target: `https://${domain}${path}`,
              expectedOutcome: `Loaded ${category} page at ${path}`,
              timeout: DEFAULT_ACTION_TIMEOUT,
            });
          }
          break;
        }
      }

      if (actions.length > 0) break;
    }

    // Fallback: construct a URL from the first keyword directly
    if (actions.length === 0 && keywords.length > 0) {
      const slug = keywords.slice(0, 2).join("-");
      actions.push({
        type: "navigate",
        target: `https://${domain}/${slug}`,
        expectedOutcome: `Loaded page at /${slug}`,
        timeout: DEFAULT_ACTION_TIMEOUT,
      });
    }

    return {
      name: "url-pattern-based",
      actions:
        actions.length > 0
          ? actions
          : [
              {
                type: "navigate",
                target: `https://${domain}`,
                expectedOutcome: "Loaded homepage as fallback",
                timeout: DEFAULT_ACTION_TIMEOUT,
              },
            ],
      confidence: actions.length > 0 ? 0.6 : 0.2,
      source: "heuristic",
    };
  }

  /**
   * Generate a search-based strategy.
   * Finds a search input on the page, enters goal keywords, and browses results.
   */
  private generateSearchStrategy(parsedGoal: ParsedGoal): Strategy {
    const searchQuery = parsedGoal.keywords.join(" ");

    const actions: PlannedAction[] = [
      {
        type: "click",
        target: [
          'input[type="search"]',
          'input[name="q"]',
          'input[name="query"]',
          'input[name="search"]',
          'input[placeholder*="earch"]',
          '[role="search"] input',
          "#search",
          ".search-input",
        ].join(", "),
        expectedOutcome: "Search input focused",
        timeout: DEFAULT_ACTION_TIMEOUT,
      },
      {
        type: "fill",
        target: [
          'input[type="search"]',
          'input[name="q"]',
          'input[name="query"]',
          'input[name="search"]',
          'input[placeholder*="earch"]',
          '[role="search"] input',
          "#search",
          ".search-input",
        ].join(", "),
        value: searchQuery,
        expectedOutcome: `Search field filled with "${searchQuery}"`,
        timeout: DEFAULT_ACTION_TIMEOUT,
      },
      {
        type: "click",
        target: [
          '[role="search"] button',
          'button[type="submit"]',
          ".search-button",
          ".search-submit",
          'button[aria-label*="earch"]',
        ].join(", "),
        expectedOutcome: "Search submitted",
        timeout: DEFAULT_ACTION_TIMEOUT,
      },
      {
        type: "click",
        target: ".search-results a, .results a, main a",
        expectedOutcome: "Clicked the first search result",
        timeout: DEFAULT_ACTION_TIMEOUT,
      },
    ];

    return {
      name: "search-based",
      actions,
      // Search is a reliable fallback on sites that have it, but we can't
      // know in advance whether the site has search, so moderate confidence.
      confidence: 0.5,
      source: "heuristic",
    };
  }

  // --------------------------------------------------------------------------
  // Helpers (Private)
  // --------------------------------------------------------------------------

  /**
   * Extract the set of actions from the first successful strategy path
   * across completed sub-goals. Used to record winning paths in the site model.
   */
  private extractSuccessfulActions(result: GoalResult): PlannedAction[] {
    const actions: PlannedAction[] = [];

    for (const subGoal of result.plan.subGoals) {
      if (!subGoal.completed) continue;

      // Take the first strategy's actions as the "winning" path.
      // In a real execution engine, we would track which strategy
      // actually succeeded; for now, we assume ordered execution.
      const bestStrategy = subGoal.strategies[0];
      if (bestStrategy) {
        actions.push(...bestStrategy.actions);
      }
    }

    return actions;
  }
}
