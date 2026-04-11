/**
 * CBrowser - Site Model Types
 * Persistent knowledge graph per site.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 * @since v18.35.0
 */

export interface SiteModel {
  domain: string;
  version: number; // schema version, start at 1
  created: string; // ISO timestamp
  lastUpdated: string;
  navigation: NavigationGraph;
  elements: Record<string, ElementReliability>; // selectorKey -> reliability
  goalPaths: GoalPath[];
  failures: FailurePattern[];
  fingerprints: Record<string, PageFingerprint>; // urlPattern -> fingerprint
}

export interface NavigationGraph {
  nodes: Record<string, NavigationNode>; // URL path -> node
  edges: NavigationEdge[];
}

export interface NavigationNode {
  url: string;
  pageType?: string; // from PageUnderstanding
  lastVisited: number;
  visitCount: number;
}

export interface NavigationEdge {
  fromUrl: string;
  toUrl: string;
  elementSelector: string;
  elementText: string;
  successCount: number;
  failureCount: number;
  lastUsed: number;
  reliability: number; // derived: success / (success + failure)
}

export interface ElementReliability {
  selector: string;
  domain: string;
  pageUrlPattern: string;
  successRate: number;
  totalAttempts: number;
  alternatives: string[];
  lastVerified: number;
  decayFactor: number; // starts at 1.0, reduced over time
}

export interface GoalPath {
  goalDescription: string;
  goalType: GoalType;
  actionSequence: GoalAction[];
  successRate: number;
  attemptCount: number;
  averageSteps: number;
  personaPerformance: Record<string, { success: boolean; steps: number }>;
  lastUsed: number;
}

export type GoalType =
  | "find_information"
  | "complete_action"
  | "navigate_to"
  | "fill_form"
  | "compare"
  | "explore"
  | "extract_data";

export interface GoalAction {
  type: "navigate" | "click" | "fill" | "select" | "scroll" | "wait";
  target: string;
  value?: string;
  expectedOutcome: string;
}

export interface FailurePattern {
  pageUrlPattern: string;
  elementSelector?: string;
  failureType: FailureType;
  frequency: number;
  conditions: string[];
  workaround?: string;
  lastSeen: number;
}

export type FailureType =
  | "element_not_found"
  | "timeout"
  | "navigation_error"
  | "blocked_by_overlay"
  | "auth_required"
  | "captcha"
  | "rate_limited";

export interface PageFingerprint {
  urlPattern: string;
  headingStructureHash: string;
  formCount: number;
  navLinkCount: number;
  ctaCount: number;
  pageType?: string;
  lastSeen: number;
}

export interface SiteModelStats {
  domain: string;
  navigationNodes: number;
  navigationEdges: number;
  trackedElements: number;
  goalPaths: number;
  failurePatterns: number;
  pageFingerprints: number;
  modelSizeBytes: number;
  lastUpdated: string;
  oldestData: string;
}

export interface PruneResult {
  edgesRemoved: number;
  elementsRemoved: number;
  pathsRemoved: number;
  failuresRemoved: number;
  fingerprintsRemoved: number;
}
