/**
 * Attention Quality — bridges cognitive effort and visual saliency.
 *
 * Measures not just WHERE a persona looks, but whether they see
 * the things that matter: CTAs, value props, and primary actions.
 *
 * Four components:
 * 1. CTA Capture Rate — do top saliency zones overlap with CTAs?
 * 2. Value Prop Salience — is the headline/message in top attention?
 * 3. Distractor Ratio — how much attention goes to non-actionable elements?
 * 4. Value Relevance Score — does the persona see what THEIR values care about?
 *
 * @since v18.39.0 (base), v18.46.0 (value-driven semantic classification)
 */

import type { PageUnderstanding, Affordance, CTAElement } from "../analysis/page-understanding.js";

// ── Semantic Element Types (value-relevant) ──

export type SemanticType =
  | "trust-signal"    // Security badges, locks, "verified", guarantees, certifications
  | "social-proof"    // Star ratings, review counts, "trusted by X", testimonials
  | "novelty"         // "New", "Beta", "Updated", recent dates, feature badges
  | "metrics"         // Numbers, percentages, stats, ROI, performance data
  | "urgency"         // "Limited time", "Only X left", countdowns, scarcity
  | "community"       // "Join", forums, team, "community", user counts
  | "authority"       // Expert endorsements, "Fortune 500", logos, awards
  | "none";

const TRUST_PATTERNS = /secur|trust|verif|certif|guarant|money.?back|refund|privacy|encrypt|ssl|badge|shield|lock|safe|protect|complian/i;
const SOCIAL_PROOF_PATTERNS = /review|rating|star|trusted.?by|users|customers|clients|testimonial|recommend|\d+[kKmM]?\+?\s*(users|customers|downloads|installs|companies)|4\.\d|5\.0/i;
const NOVELTY_PATTERNS = /\bnew\b|beta|launch|updat|just.?added|fresh|latest|coming.?soon|early.?access|preview/i;
const METRICS_PATTERNS = /\d+%|\d+x\s|roi|\bsave\b.*\d|faster|reduc|improv|increase|decrease|performance|benchmark|\$\d/i;
const URGENCY_PATTERNS = /limited|only\s*\d|hurry|expire|countdown|last.?chance|ending|left.?in.?stock|act.?now|don.?t.?miss/i;
const COMMUNITY_PATTERNS = /community|join|forum|together|team|family|fellow|member|belong|contrib|open.?source/i;
const AUTHORITY_PATTERNS = /fortune|forbes|techcrunch|award|winner|leader|expert|partner|enterprise|government|university/i;

/** Classify an element's semantic type from its text content */
export function classifySemanticType(text: string, classList?: string): SemanticType {
  if (!text && !classList) return "none";
  const combined = `${text || ""} ${classList || ""}`;
  if (TRUST_PATTERNS.test(combined)) return "trust-signal";
  if (SOCIAL_PROOF_PATTERNS.test(combined)) return "social-proof";
  if (NOVELTY_PATTERNS.test(combined)) return "novelty";
  if (METRICS_PATTERNS.test(combined)) return "metrics";
  if (URGENCY_PATTERNS.test(combined)) return "urgency";
  if (COMMUNITY_PATTERNS.test(combined)) return "community";
  if (AUTHORITY_PATTERNS.test(combined)) return "authority";
  return "none";
}

/** Schwartz value weights for each semantic type (which values care about which elements) */
const VALUE_SEMANTIC_WEIGHTS: Record<SemanticType, Record<string, number>> = {
  "trust-signal":  { security: 1.0, conformity: 0.5, tradition: 0.3 },
  "social-proof":  { conformity: 1.0, security: 0.6, tradition: 0.3 },
  "novelty":       { stimulation: 1.0, selfDirection: 0.5 },
  "metrics":       { achievement: 1.0, power: 0.4 },
  "urgency":       { stimulation: 0.5, achievement: 0.4 },
  "community":     { benevolence: 0.8, universalism: 0.6, conformity: 0.3 },
  "authority":     { security: 0.5, conformity: 0.6, tradition: 0.4, power: 0.3 },
  "none":          {},
};

/** Compute how relevant an element is to a persona's values (0-1) */
export function computeValueRelevance(
  semanticType: SemanticType,
  values: Partial<Record<string, number>>,
): number {
  const weights = VALUE_SEMANTIC_WEIGHTS[semanticType];
  if (!weights || Object.keys(weights).length === 0) return 0;

  let weightedSum = 0;
  let totalWeight = 0;
  for (const [valueName, weight] of Object.entries(weights)) {
    const personaValue = values[valueName] ?? 0.5;
    weightedSum += personaValue * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}

export interface AttentionQualityResult {
  /** CTA capture rate: fraction of top saliency in CTA zones (0-1) */
  ctaCaptureRate: number;
  /** Value prop salience: is the primary heading in top attention? (0-1) */
  valuePropSalience: number;
  /** Distractor ratio: fraction of top attention on non-actionable elements (0-1) */
  distractorRatio: number;
  /** Combined attention quality score (0-100) */
  qualityScore: number;
  /** Value relevance score: how much attention hits elements this persona's values care about (0-1). Only present when values provided. */
  valueRelevanceScore?: number;
  /** What the top attention zones are hitting */
  topAttentionTargets: Array<{
    type: "cta" | "heading" | "navigation" | "content" | "decorative" | "unknown";
    element: string;
    saliency: number;
    semanticType?: SemanticType;
    valueRelevance?: number;
  }>;
  /** Interpretation */
  interpretation: string;
}

interface SaliencyHotspot {
  x: number;
  y: number;
  saliency: number;
  row: number;
  col: number;
}

interface ElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Compute attention quality by cross-referencing saliency hotspots
 * with page structure (CTAs, headings, navigation, content).
 *
 * @param hotspots - Top saliency hotspots from attention_analysis
 * @param pageElements - Interactive elements with bounding boxes from the page
 * @param pageUnderstanding - Page structure from page_understand
 * @param cellSize - Saliency grid cell size
 */
export function computeAttentionQuality(
  hotspots: SaliencyHotspot[],
  pageElements: Array<{
    selector: string;
    text: string;
    type: string;
    x: number;
    y: number;
    width: number;
    height: number;
    isHeading?: boolean;
    isCTA?: boolean;
    isNav?: boolean;
    isDecorative?: boolean;
    semanticType?: SemanticType;
  }>,
  cellSize: number = 4,
  personaValues?: Partial<Record<string, number>>,
): AttentionQualityResult {
  const topN = Math.min(20, hotspots.length);
  const topHotspots = hotspots.slice(0, topN);

  if (topHotspots.length === 0) {
    return {
      ctaCaptureRate: 0,
      valuePropSalience: 0,
      distractorRatio: 1,
      qualityScore: 0,
      topAttentionTargets: [],
      interpretation: "No saliency data available.",
    };
  }

  const totalTopSaliency = topHotspots.reduce((s, h) => s + h.saliency, 0) || 1;

  let ctaSaliency = 0;
  let headingSaliency = 0;
  let navSaliency = 0;
  let contentSaliency = 0;
  let decorativeSaliency = 0;
  let unknownSaliency = 0;

  const targets: AttentionQualityResult["topAttentionTargets"] = [];

  for (const hotspot of topHotspots) {
    const hx = hotspot.x;
    const hy = hotspot.y;
    const halfCell = cellSize;

    // Find which element this hotspot overlaps with
    let matched = false;
    for (const el of pageElements) {
      // Check if hotspot center is within element bounds (with padding)
      const pad = 20; // pixels of tolerance
      if (
        hx >= el.x - pad && hx <= el.x + el.width + pad &&
        hy >= el.y - pad && hy <= el.y + el.height + pad
      ) {
        let type: "cta" | "heading" | "navigation" | "content" | "decorative" = "content";

        if (el.isCTA) {
          type = "cta";
          ctaSaliency += hotspot.saliency;
        } else if (el.isHeading) {
          type = "heading";
          headingSaliency += hotspot.saliency;
        } else if (el.isNav) {
          type = "navigation";
          navSaliency += hotspot.saliency;
        } else if (el.isDecorative) {
          type = "decorative";
          decorativeSaliency += hotspot.saliency;
        } else {
          contentSaliency += hotspot.saliency;
        }

        // Semantic classification + value relevance
        const semType = el.semanticType || classifySemanticType(el.text || "", el.selector);
        const valRel = personaValues ? computeValueRelevance(semType, personaValues) : undefined;

        targets.push({
          type,
          element: el.text?.slice(0, 50) || el.selector,
          saliency: Math.round(hotspot.saliency * 1000) / 1000,
          semanticType: semType !== "none" ? semType : undefined,
          valueRelevance: valRel !== undefined ? Math.round(valRel * 1000) / 1000 : undefined,
        });
        matched = true;
        break;
      }
    }

    if (!matched) {
      unknownSaliency += hotspot.saliency;
      targets.push({
        type: "unknown",
        element: `(${hx}, ${hy})`,
        saliency: Math.round(hotspot.saliency * 1000) / 1000,
      });
    }
  }

  // Compute rates
  const ctaCaptureRate = ctaSaliency / totalTopSaliency;
  const valuePropSalience = (headingSaliency + ctaSaliency) / totalTopSaliency;
  const distractorRatio = (decorativeSaliency + unknownSaliency + navSaliency) / totalTopSaliency;

  // Value relevance score (only when persona values provided)
  let valueRelevanceScore: number | undefined;
  if (personaValues) {
    let valRelSum = 0;
    let valRelCount = 0;
    for (const t of targets) {
      if (t.valueRelevance !== undefined && t.valueRelevance > 0) {
        valRelSum += t.saliency * t.valueRelevance;
        valRelCount++;
      }
    }
    valueRelevanceScore = valRelCount > 0
      ? Math.round((valRelSum / totalTopSaliency) * 1000) / 1000
      : 0;
  }

  // Quality score: rewards CTA capture, value prop, low distraction, and value relevance
  const valueBonus = valueRelevanceScore !== undefined ? valueRelevanceScore * 10 : 0;
  const qualityScore = Math.max(0, Math.min(100, Math.round(
    ctaCaptureRate * 35 +          // 35 points for CTA capture
    valuePropSalience * 25 +       // 25 points for value prop visibility
    (1 - distractorRatio) * 25 +   // 25 points for low distraction
    valueBonus +                   // up to 10 points for value-relevant attention
    5                              // 5 base points
  )));

  // Interpretation
  let interpretation: string;
  if (ctaCaptureRate > 0.3 && valuePropSalience > 0.5) {
    interpretation = "Strong attention quality — the persona sees the value prop and CTAs. Design intent is working.";
  } else if (ctaCaptureRate > 0.1 && valuePropSalience > 0.3) {
    interpretation = "Moderate attention quality — the persona partially sees key elements but attention is split with other content.";
  } else if (distractorRatio > 0.5) {
    interpretation = "Poor attention quality — more than half of top attention goes to non-actionable elements. CTAs and value prop are not capturing attention.";
  } else if (ctaCaptureRate < 0.05) {
    interpretation = "CTAs are invisible to this persona — none of the top saliency zones overlap with calls to action. Consider making CTAs larger, higher-contrast, or more prominently positioned.";
  } else {
    interpretation = "Mixed attention quality — attention is distributed across the page without strong focus on conversion elements.";
  }

  return {
    ctaCaptureRate: Math.round(ctaCaptureRate * 1000) / 1000,
    valuePropSalience: Math.round(valuePropSalience * 1000) / 1000,
    distractorRatio: Math.round(distractorRatio * 1000) / 1000,
    qualityScore,
    valueRelevanceScore,
    topAttentionTargets: targets.slice(0, 10),
    interpretation,
  };
}

/**
 * Extract element metadata from a Playwright page for attention quality analysis.
 * Returns elements with bounding boxes and type classifications.
 */
export async function extractPageElementsForAttention(page: unknown): Promise<Array<{
  selector: string;
  text: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isHeading: boolean;
  isCTA: boolean;
  isNav: boolean;
  isDecorative: boolean;
  classList: string;
}>> {
  const p = page as { evaluate: (fn: () => unknown) => Promise<unknown> };
  return p.evaluate(() => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Only include elements whose bounding box intersects the viewport
    const inViewport = (rect: DOMRect): boolean =>
      rect.width > 0 && rect.height > 0 &&
      rect.bottom > 0 && rect.top < vh &&
      rect.right > 0 && rect.left < vw;

    const elements: Array<{
      selector: string;
      text: string;
      type: string;
      x: number;
      y: number;
      width: number;
      height: number;
      isHeading: boolean;
      isCTA: boolean;
      isNav: boolean;
      isDecorative: boolean;
      classList: string;
    }> = [];

    // CTAs: buttons with action text, prominent links
    const ctaPatterns = /apply|sign.?up|register|get.?started|buy|order|subscribe|enroll|join|donate|download|try|start|begin|contact|request|book/i;

    // Headings — viewport only
    document.querySelectorAll("h1, h2, h3").forEach(el => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (!inViewport(rect)) return;
      const text = (el as HTMLElement).innerText?.trim() || "";
      elements.push({
        selector: el.tagName.toLowerCase(),
        text,
        type: "heading",
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        isHeading: true,
        isCTA: false,
        isNav: false,
        isDecorative: false,
        classList: (el as HTMLElement).className || "",
      });
    });

    // Buttons and links — viewport only
    document.querySelectorAll('a, button, [role="button"], input[type="submit"]').forEach(el => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (!inViewport(rect)) return;
      const text = (el as HTMLElement).innerText?.trim() || (el as HTMLInputElement).value || "";
      const isNav = !!(el.closest("nav") || el.closest('[role="navigation"]'));
      const isCTA = !isNav && (
        ctaPatterns.test(text) ||
        (el as HTMLElement).classList.toString().match(/cta|primary|action|hero/i) !== null ||
        (rect.width > 120 && rect.height > 36 && !isNav) // large standalone button
      );

      elements.push({
        selector: el.tagName.toLowerCase() + (text ? `[${text.slice(0, 20)}]` : ""),
        text,
        type: isCTA ? "cta" : isNav ? "navigation" : "link",
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        isHeading: false,
        isCTA: !!isCTA,
        isNav,
        isDecorative: false,
        classList: (el as HTMLElement).className || "",
      });
    });

    // Images (decorative) — viewport only
    document.querySelectorAll("img, svg, video").forEach(el => {
      const rect = (el as HTMLElement).getBoundingClientRect();
      if (!inViewport(rect)) return;
      if (rect.width < 50 || rect.height < 50) return; // skip tiny icons
      const alt = (el as HTMLImageElement).alt || "";
      const isDecorative = !alt || alt === "" || (el as HTMLElement).getAttribute("role") === "presentation";
      elements.push({
        selector: el.tagName.toLowerCase(),
        text: alt.slice(0, 50),
        type: "image",
        x: rect.x, y: rect.y, width: rect.width, height: rect.height,
        isHeading: false,
        isCTA: false,
        isNav: false,
        isDecorative,
        classList: (el as HTMLElement).className || "",
      });
    });

    return elements;
  }) as Promise<Array<{
    selector: string; text: string; type: string;
    x: number; y: number; width: number; height: number;
    isHeading: boolean; isCTA: boolean; isNav: boolean; isDecorative: boolean;
    classList: string;
  }>>;
}
