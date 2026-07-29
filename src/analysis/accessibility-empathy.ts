/**
 * CBrowser - Cognitive Browser Automation
 * Copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com
 * Learn more at https://cbrowser.ai - MIT License
 */


/**
 * Accessibility Empathy Audit Module
 *
 * Simulate how people with disabilities EXPERIENCE a site — motor impairments,
 * cognitive differences, sensory limitations — not just WCAG compliance checking.
 *
 * METHODOLOGY DISCLAIMER:
 *
 * Empathy scores are HEURISTIC estimates based on barrier detection and
 * persona simulation, not actual user testing with disabled individuals.
 *
 * Research-backed thresholds:
 * - Touch targets: 44x44px minimum (WCAG 2.5.5 AAA, 2.5.8 AA)
 * - Contrast ratios: 4.5:1 normal text, 3:1 large text (WCAG 1.4.3)
 * - Form complexity: 7-8 fields optimal before cognitive overload (Baymard)
 * - Screen reader success: ~55.6% task completion rate (WebAIM 2024)
 *
 * Heuristic components (interpret as directional, not precise):
 * - Barrier detection: Identifies patterns known to cause difficulties
 * - Friction points: Simulated based on persona traits, not actual user data
 * - Empathy score: Composite for comparison, letter grades recommended
 *
 * For actual accessibility validation, combine with:
 * - Automated WCAG checkers (axe, WAVE)
 * - Manual testing with assistive technologies
 * - User testing with people who have disabilities
 */

import { type Page } from "playwright";
import { CBrowser } from "../browser.js";
import type {
  EmpathyAuditResult,
  EmpathyAuditOptions,
  AccessibilityEmpathyResult,
  AccessibilityBarrier,
  AccessibilityBarrierType,
  AccessibilityBarrierSeverity,
  AccessibilityFrictionPoint,
  RemediationItem,
  AccessibilityPersona,
  AgentReadyEffort,
} from "../types.js";
import { getAccessibilityPersona } from "../personas.js";
import {
  runCognitiveJourney,
  isApiKeyConfigured,
} from "../cognitive/index.js";
import {
  calculatePerceptualScore,
  getPerceptualProfile,
  analyzePerceptualTransport,
  type PerceptualAnalysis,
} from "../visual/perceptual-transport.js";
import {
  buildOTCognitiveProfile,
  estimateCognitiveLoad,
  extractPageMetrics,
} from "../visual/cognitive-transport.js";
import {
  analyzeAttention,
} from "../visual/attention-transport.js";
import {
  getEmotionVisualizationStyles,
  generateEmotionVisualizationSection,
} from "../utils.js";

// ============================================================================
// WCAG Mapping
// ============================================================================

const WCAG_CRITERIA: Record<string, { level: "A" | "AA" | "AAA"; description: string }> = {
  "1.1.1": { level: "A", description: "Non-text Content" },
  "1.3.1": { level: "A", description: "Info and Relationships" },
  "1.4.1": { level: "A", description: "Use of Color" },
  "1.4.3": { level: "AA", description: "Contrast (Minimum)" },
  "1.4.4": { level: "AA", description: "Resize Text" },
  "1.4.6": { level: "AAA", description: "Contrast (Enhanced)" },
  "1.4.10": { level: "AA", description: "Reflow" },
  "2.1.1": { level: "A", description: "Keyboard" },
  "2.1.2": { level: "A", description: "No Keyboard Trap" },
  "2.2.1": { level: "A", description: "Timing Adjustable" },
  "2.2.2": { level: "A", description: "Pause, Stop, Hide" },
  "2.3.1": { level: "A", description: "Three Flashes or Below" },
  "2.4.1": { level: "A", description: "Bypass Blocks" },
  "2.4.3": { level: "A", description: "Focus Order" },
  "2.4.4": { level: "A", description: "Link Purpose" },
  "2.4.6": { level: "AA", description: "Headings and Labels" },
  "2.4.7": { level: "AA", description: "Focus Visible" },
  "2.5.5": { level: "AAA", description: "Target Size" },
  "2.5.8": { level: "AA", description: "Target Size (Minimum)" },
  "3.1.1": { level: "A", description: "Language of Page" },
  "3.2.1": { level: "A", description: "On Focus" },
  "3.2.2": { level: "A", description: "On Input" },
  "3.3.1": { level: "A", description: "Error Identification" },
  "3.3.2": { level: "A", description: "Labels or Instructions" },
  "4.1.1": { level: "A", description: "Parsing" },
  "4.1.2": { level: "A", description: "Name, Role, Value" },
};

function _getWcagCriteriaForBarrier(barrierType: AccessibilityBarrierType): string[] {
  switch (barrierType) {
    case "motor_precision":
      return ["2.5.5", "2.5.8"];
    case "visual_clarity":
      return ["1.4.3", "1.4.6", "1.4.4"];
    case "cognitive_load":
      return ["2.4.6", "3.3.2"];
    case "temporal":
      return ["2.2.1", "2.2.2"];
    case "sensory":
      return ["1.1.1", "1.4.1"];
    case "contrast":
      return ["1.4.3", "1.4.6"];
    case "touch_target":
      return ["2.5.5", "2.5.8"];
    case "timing":
      return ["2.2.1", "2.2.2"];
    default:
      return [];
  }
}

/** Get the LOWEST (most stringent) WCAG level of a barrier's criteria.
 * A barrier that violates both 2.5.8 (AA) and 2.5.5 (AAA) should use AA
 * because it fails the stricter standard. */
function getBarrierWcagLevel(wcagCriteria: string[]): "A" | "AA" | "AAA" {
  if (!wcagCriteria.length) return "AAA"; // no criteria = treat as advisory
  let lowest: "A" | "AA" | "AAA" = "AAA";
  const levelOrder: Record<string, number> = { A: 1, AA: 2, AAA: 3 };
  for (const code of wcagCriteria) {
    const criteria = WCAG_CRITERIA[code];
    if (criteria && levelOrder[criteria.level] < levelOrder[lowest]) {
      lowest = criteria.level;
    }
  }
  return lowest;
}

/**
 * Adjust barrier severity based on WCAG level context.
 * AAA-only issues should not be "critical" when auditing at AA level.
 */
function adjustSeverityForLevel(
  severity: AccessibilityBarrierSeverity,
  barrierWcagLevel: "A" | "AA" | "AAA",
  auditLevel: "A" | "AA" | "AAA"
): AccessibilityBarrierSeverity {
  const levelOrder: Record<string, number> = { A: 1, AA: 2, AAA: 3 };
  // If the barrier is from a higher WCAG level than the audit target, downgrade severity
  if (levelOrder[barrierWcagLevel] > levelOrder[auditLevel]) {
    if (severity === "critical") return "minor"; // AAA issue at AA audit → minor
    if (severity === "major") return "minor";
    return severity;
  }
  return severity;
}

// ============================================================================
// Barrier Detection Functions
// ============================================================================

interface BarrierContext {
  page: Page;
  persona: AccessibilityPersona;
  barriers: AccessibilityBarrier[];
  frictionPoints: AccessibilityFrictionPoint[];
  wcagViolations: Set<string>;
  stepCount: number;
  /** When true, barrier detectors only count elements in the initial viewport */
  viewportOnly: boolean;
  /** WCAG conformance level for this audit */
  wcagLevel: "A" | "AA" | "AAA";
}

/**
 * Detect small touch targets that are hard for motor-impaired users
 * v10.10.0: Always detect touch target issues regardless of persona
 * (issues exist on the page whether or not this persona would encounter them)
 */
async function detectSmallTouchTargets(ctx: BarrierContext): Promise<void> {
  const { page, persona, barriers, viewportOnly } = ctx;

  // v10.10.0: Removed trait-based skipping - always detect issues
  const _motorControl = persona.accessibilityTraits.motorControl ?? 0.5;

  const smallTargets = await page.$$eval(
    'button, a, input[type="checkbox"], input[type="radio"], [role="button"], [onclick]',
    (elements, vpOnly) => {
      const vh = window.innerHeight;
      return elements.map(el => {
        const rect = el.getBoundingClientRect();
        const text = el.textContent?.trim().slice(0, 50) || '';
        const href = (el as HTMLAnchorElement).href || el.getAttribute('href') || '';
        const style = window.getComputedStyle(el);

        // Skip link detection: anchor with # href + skip-related text
        const isSkipLink = el.tagName === 'A' && (
          (href.startsWith('#') && /skip|jump|main.content|nav.*content/i.test(text)) ||
          el.classList.contains('skip-link') || el.classList.contains('skip-nav') ||
          el.classList.contains('skiplink') || el.id?.includes('skip')
        );

        // WCAG 2.5.8 exempts inline text links: "the target is in a sentence
        // or its size is otherwise constrained by the line-height of non-target text."
        // Detect: <a> whose parent contains other text content (not a button-styled element).
        // Example: a 110×18 text link inside a paragraph is fine — the line-height bounds it.
        const isInlineTextLink = el.tagName === 'A' && (() => {
          const parent = el.parentElement;
          if (!parent) return false;
          // Parent has non-link text → this link is part of a sentence
          const parentText = parent.textContent || '';
          const linkText = el.textContent || '';
          const otherText = parentText.replace(linkText, '').trim();
          if (otherText.length < 10) return false;
          // Must not be styled as a button (rough heuristic via display/padding)
          const elStyle = window.getComputedStyle(el);
          if (elStyle.display === 'inline-block' || elStyle.display === 'block' || elStyle.display === 'flex') return false;
          if (parseInt(elStyle.padding) > 4) return false;
          return true;
        })();

        // Tiny elements (1x1, 0x0) are tracking pixels or hidden inputs, not real touch targets
        const isTiny = rect.width <= 2 || rect.height <= 2;

        // Visually hidden / sr-only detection (intentionally offscreen, visible on focus)
        const isVisuallyHidden = isTiny ||
          style.position === 'absolute' && (
            parseInt(style.left) < -100 || parseInt(style.top) < -100 ||
            style.clip === 'rect(0px, 0px, 0px, 0px)' || style.clip === 'rect(1px, 1px, 1px, 1px)' ||
            style.clipPath === 'inset(50%)' ||
            (rect.width <= 1 && rect.height <= 1 && parseInt(style.overflow) === 0)
          ) ||
          el.classList.contains('sr-only') || el.classList.contains('visually-hidden') ||
          el.classList.contains('screen-reader-text');

        return {
          selector: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : ''),
          width: rect.width,
          height: rect.height,
          // DOCUMENT coordinates. getBoundingClientRect is viewport-relative, and
          // in scope:"full_page" the audit scrolls, so rects captured at different
          // scroll positions landed in one list with no common frame: a single
          // response held y:-274 and y:3951 while claiming a 393x852 viewport
          // space, which no scroll position can satisfy. (2026-07-29)
          x: rect.left + window.scrollX,
          y: rect.top + window.scrollY,
          text,
          area: rect.width * rect.height,
          inViewport: rect.bottom > 0 && rect.top < vh,
          exempt: isSkipLink || isVisuallyHidden || isInlineTextLink,
        };
      }).filter(el => {
        if (el.area <= 0 || el.exempt) return false;
        if (vpOnly && !el.inViewport) return false;
        // Only flag if the SMALLEST dimension is under the threshold
        // A 1280x36px element is perfectly tappable — the 36px height is fine
        // WCAG 2.5.8 AA: 24x24px minimum for the target area
        const minDim = Math.min(el.width, el.height);
        const maxDim = Math.max(el.width, el.height);
        // Skip if the element is wide/tall enough to be easily tappable
        // (one dimension >= 44px AND the other >= 24px = AA compliant)
        if (minDim >= 24 && maxDim >= 44) return false;
        // Flag if both dimensions are small
        return minDim < 44;
      });
    }, viewportOnly
  );

  // WCAG 2.5.8 (AA) minimum: 24x24px
  // WCAG 2.5.5 (AAA) target: 44x44px
  const aaMinimum = 24;
  const aaaTarget = 44;

  for (const target of smallTargets.slice(0, 10)) {
    const w = Math.round(target.width);
    const h = Math.round(target.height);

    // Determine which WCAG criteria are violated
    const wcagCriteria: string[] = [];
    let description: string;
    let rawSeverity: AccessibilityBarrierSeverity;

    if (w < aaMinimum || h < aaMinimum) {
      // Fails WCAG 2.5.8 AA (24x24px minimum)
      wcagCriteria.push("2.5.8", "2.5.5");
      description = `Touch target too small (${w}x${h}px) — fails WCAG 2.5.8 AA minimum (24x24px)`;
      rawSeverity = w < 16 || h < 16 ? "critical" : "major";
      ctx.wcagViolations.add("2.5.8");
    } else {
      // Passes AA but fails AAA (24-44px range)
      wcagCriteria.push("2.5.5");
      description = `Touch target below AAA target (${w}x${h}px) — passes AA (24px) but below AAA target (44px)`;
      rawSeverity = "minor";
      ctx.wcagViolations.add("2.5.5");
    }

    // Adjust severity based on audit level — AAA-only issues are minor at AA
    const barrierLevel = getBarrierWcagLevel(wcagCriteria);
    const severity = adjustSeverityForLevel(rawSeverity, barrierLevel, ctx.wcagLevel);

    barriers.push({
      type: "touch_target",
      element: target.selector,
      description,
      affectedPersonas: ["motor-impairment-tremor", "elderly-low-vision"],
      wcagCriteria,
      severity,
      remediation: w < aaMinimum || h < aaMinimum
        ? `Increase clickable area to at least 24x24px (AA) — 44x44px recommended (AAA)`
        : `Consider increasing to 44x44px for AAA compliance and better mobile usability`,
      rect: { x: Math.round(target.x), y: Math.round(target.y), width: w, height: h },
    } as any);
  }
}

/**
 * Detect low contrast elements that are hard for low-vision users
 * v10.10.0: Always detect contrast issues regardless of persona
 * (issues exist on the page whether or not this persona would encounter them)
 */
async function detectLowContrast(ctx: BarrierContext): Promise<void> {
  const { page, persona, barriers } = ctx;

  // v10.10.0: Removed trait-based skipping - always detect issues
  // The severity is still adjusted based on persona traits
  const contrastSensitivity = persona.accessibilityTraits.contrastSensitivity || 1;

  // Check text elements for contrast (simplified check - real check needs computed colors)
  const lowContrastElements = await page.$$eval(
    'p, span, h1, h2, h3, h4, h5, h6, a, button, label, li, td, th',
    (elements) => {
      // Relative luminance per WCAG 2.1
      function luminance(r: number, g: number, b: number): number {
        const [rs, gs, bs] = [r, g, b].map(c => {
          c = c / 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
      }
      function contrastRatio(l1: number, l2: number): number {
        const lighter = Math.max(l1, l2);
        const darker = Math.min(l1, l2);
        return (lighter + 0.05) / (darker + 0.05);
      }
      function parseColor(color: string): [number, number, number] | null {
        const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
      }

      const vh = window.innerHeight;
      const results: Array<{
        selector: string; text: string; fontSize: number; ratio: number;
        isLargeText: boolean; color: string; bgColor: string;
      }> = [];

      for (const el of elements.slice(0, 150)) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0 || rect.bottom < 0 || rect.top > vh) continue;
        const text = el.textContent?.trim();
        if (!text || text.length < 2) continue;

        const styles = window.getComputedStyle(el);
        const fg = parseColor(styles.color);
        const bg = parseColor(styles.backgroundColor);
        if (!fg) continue;

        // Walk up to find non-transparent background
        // rgba(0, 0, 0, 0) = transparent, rgb(0, 0, 0) = black (valid)
        let bgColor = bg;
        const elBgStr = styles.backgroundColor;
        const isTransparent = (s: string) => s === 'rgba(0, 0, 0, 0)' || s === 'transparent' || s === 'initial';
        if (isTransparent(elBgStr)) {
          bgColor = null;
          let parent = el.parentElement;
          while (parent) {
            const pStyle = window.getComputedStyle(parent);
            const pBgStr = pStyle.backgroundColor;
            if (!isTransparent(pBgStr)) {
              bgColor = parseColor(pBgStr);
              break;
            }
            parent = parent.parentElement;
          }
        }
        if (!bgColor) bgColor = [255, 255, 255]; // assume white if no bg found

        // Skip elements where fg and bg are identical — likely hidden/decorative
        if (fg[0] === bgColor[0] && fg[1] === bgColor[1] && fg[2] === bgColor[2]) continue;

        const fgLum = luminance(fg[0], fg[1], fg[2]);
        const bgLum = luminance(bgColor[0], bgColor[1], bgColor[2]);
        const ratio = contrastRatio(fgLum, bgLum);

        const fontSize = parseFloat(styles.fontSize);
        const fontWeight = parseInt(styles.fontWeight) || 400;
        // Large text: >= 18pt (24px) or >= 14pt (18.66px) bold
        const isLargeText = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);

        // WCAG thresholds:
        // AA: 4.5:1 normal, 3:1 large (1.4.3)
        // AAA: 7:1 normal, 4.5:1 large (1.4.6)
        const aaThreshold = isLargeText ? 3 : 4.5;
        const aaaThreshold = isLargeText ? 4.5 : 7;

        if (ratio < aaaThreshold) {
          (results as any[]).push({
            selector: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : el.className ? `.${el.className.split(' ')[0]}` : ''),
            text: text.slice(0, 30),
            fontSize,
            ratio: Math.round(ratio * 10) / 10,
            isLargeText,
            color: styles.color,
            bgColor: styles.backgroundColor,
            // Document coordinates, as above.
            x: Math.round(rect.left + window.scrollX),
            y: Math.round(rect.top + window.scrollY),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          });
        }
      }

      return results;
    }
  );

  // AA threshold: 4.5:1 normal, 3:1 large text (WCAG 1.4.3)
  // AAA threshold: 7:1 normal, 4.5:1 large text (WCAG 1.4.6)
  for (const el of lowContrastElements.slice(0, 8)) {
    const aaThreshold = el.isLargeText ? 3 : 4.5;
    const failsAA = el.ratio < aaThreshold;
    const wcagCriteria = failsAA ? ["1.4.3", "1.4.6"] : ["1.4.6"];
    const barrierLevel = getBarrierWcagLevel(wcagCriteria);

    let rawSeverity: AccessibilityBarrierSeverity;
    if (failsAA) {
      rawSeverity = el.ratio < 2 ? "critical" : el.ratio < 3 ? "major" : "minor";
    } else {
      rawSeverity = "minor"; // passes AA, fails AAA
    }

    const severity = adjustSeverityForLevel(rawSeverity, barrierLevel, ctx.wcagLevel);

    barriers.push({
      type: "contrast",
      element: el.selector,
      description: failsAA
        ? `Contrast ratio ${el.ratio}:1 fails AA minimum (${el.isLargeText ? '3' : '4.5'}:1 required for ${el.isLargeText ? 'large' : 'normal'} text)`
        : `Contrast ratio ${el.ratio}:1 passes AA but fails AAA (${el.isLargeText ? '4.5' : '7'}:1 required)`,
      affectedPersonas: ["low-vision-magnified", "elderly-low-vision", "color-blind-deuteranopia"],
      wcagCriteria,
      severity,
      remediation: failsAA
        ? `Increase contrast to at least ${el.isLargeText ? '3' : '4.5'}:1 (current: ${el.ratio}:1)`
        : `For AAA compliance, increase contrast to ${el.isLargeText ? '4.5' : '7'}:1 (current: ${el.ratio}:1)`,
      rect: { x: (el as any).x, y: (el as any).y, width: (el as any).width, height: (el as any).height },
    } as any);
    if (failsAA) ctx.wcagViolations.add("1.4.3");
    else ctx.wcagViolations.add("1.4.6");
  }
}

/**
 * Detect cognitive load issues
 * v10.10.0: Always detect cognitive load issues regardless of persona
 * (issues exist on the page whether or not this persona would encounter them)
 */
async function detectCognitiveLoad(ctx: BarrierContext): Promise<void> {
  const { page, persona: _persona, barriers } = ctx;

  // v10.10.0: Removed trait-based skipping - always detect issues

  const cognitiveIssues = await page.evaluate(() => {
    const issues: Array<{ type: string; description: string; count?: number }> = [];
    const inVp = (window as any).__cbrowserInViewport || (() => true);

    // Check for long forms (in scope)
    const forms = Array.from(document.querySelectorAll('form')).filter(inVp);
    for (const form of forms) {
      const inputs = Array.from(form.querySelectorAll('input:not([type="hidden"]), textarea, select')).filter(inVp);
      if (inputs.length > 7) {
        issues.push({
          type: "long-form",
          description: `Form with ${inputs.length} fields may overwhelm users with attention difficulties`,
          count: inputs.length,
        });
      }
    }

    // Check for text walls (in scope)
    const paragraphs = Array.from(document.querySelectorAll('p')).filter(inVp);
    for (const p of paragraphs) {
      if (p.textContent && p.textContent.length > 500) {
        issues.push({
          type: "text-wall",
          description: "Long paragraph without breaks may be difficult to process",
        });
        break;
      }
    }

    // Check for animations/movement (in scope)
    const animations = Array.from(document.querySelectorAll('[class*="animate"], [class*="slider"], [class*="carousel"]')).filter(inVp);
    if (animations.length > 0) {
      issues.push({
        type: "animation",
        description: "Animated content may distract users with attention difficulties",
        count: animations.length,
      });
    }

    // Check for complex navigation (in scope)
    const navItems = Array.from(document.querySelectorAll('nav a, header a, [role="navigation"] a')).filter(inVp);
    if (navItems.length > 10) {
      issues.push({
        type: "complex-nav",
        description: `Navigation with ${navItems.length} items may be overwhelming`,
        count: navItems.length,
      });
    }

    return issues;
  });

  for (const issue of cognitiveIssues) {
    // Map each cognitive issue type to appropriate WCAG criteria (if any)
    const wcagMap: Record<string, { criteria: string[]; violation: string | null }> = {
      "long-form": { criteria: ["3.3.2"], violation: "3.3.2" }, // Labels or Instructions
      "text-wall": { criteria: ["1.3.1"], violation: null }, // Info and Relationships (recommendation, not violation)
      "animation": { criteria: ["2.2.2", "2.3.1"], violation: "2.2.2" }, // Pause Stop Hide
      "complex-nav": { criteria: [], violation: null }, // No WCAG criterion for nav item count — UX recommendation only
    };
    const mapping = wcagMap[issue.type] || { criteria: [], violation: null };

    barriers.push({
      type: "cognitive_load",
      element: issue.type,
      description: issue.description + (mapping.criteria.length === 0 ? ' (UX recommendation, not a WCAG violation)' : ''),
      affectedPersonas: ["cognitive-adhd", "dyslexic-user"],
      wcagCriteria: mapping.criteria,
      severity: issue.type === "long-form" ? "major" : "minor",
      remediation: issue.type === "long-form"
        ? "Break form into multiple steps or sections"
        : issue.type === "text-wall"
          ? "Break text into smaller paragraphs with headings"
          : issue.type === "animation"
            ? "Provide controls to pause/stop animations, or use prefers-reduced-motion"
            : "Consider simplifying navigation structure for cognitive accessibility",
    });
    if (mapping.violation) ctx.wcagViolations.add(mapping.violation);
  }
}

/**
 * Detect timing-based barriers
 */
async function detectTimingIssues(ctx: BarrierContext): Promise<void> {
  const { page, persona: _persona, barriers } = ctx;

  // Look for ACTUAL timing constraints — not CSS class substrings.
  // Previous version matched `[class*="auto-"]` (every Tailwind utility) and
  // `[class*="session"]` (Stripe's "Sessions" product, "session storage" UI,
  // etc.) and flagged them as severity:major time-limited content. That alone
  // dropped well-built sites by 30+ points on every empathy audit.
  // Real signals: explicit data-timeout, role=timer, ARIA live regions with
  // visible "expires/remaining/seconds" text, or meta http-equiv=refresh.
  const timingElements = await page.$$eval(
    '[data-timeout], [role="timer"], meta[http-equiv="refresh"], [aria-live]',
    (elements) => elements
      .map((el) => {
        const text = el.textContent?.trim().slice(0, 100) || "";
        const role = el.getAttribute("role") || "";
        const dataTimeout = el.hasAttribute("data-timeout");
        const httpRefresh = el.tagName === "META" && el.getAttribute("http-equiv")?.toLowerCase() === "refresh";
        // ARIA live regions only count as timing-relevant when their text
        // includes time-cue language (countdown, expires, remaining, seconds).
        const hasTimeCueText = /\b(countdown|expir|remaining|time\s*left|seconds?\s+left|minutes?\s+left)\b/i.test(text);
        const isTimingRelevant = dataTimeout || role === "timer" || httpRefresh || hasTimeCueText;
        return {
          isTimingRelevant,
          selector: el.tagName.toLowerCase() + (el.className && typeof (el as HTMLElement).className === "string"
            ? `.${(el as HTMLElement).className.split(" ")[0]}` : ""),
          text,
        };
      })
      .filter((el) => el.isTimingRelevant)
  );

  if (timingElements.length > 0) {
    const wcagCriteria = ["2.2.1", "2.2.2"];
    const barrierLevel = getBarrierWcagLevel(wcagCriteria);
    const severity = adjustSeverityForLevel("major", barrierLevel, ctx.wcagLevel);
    for (const el of timingElements) {
      barriers.push({
        type: "timing",
        element: el.selector,
        description: `Time-limited content detected — may not allow enough time for users who need longer`,
        affectedPersonas: ["motor-impairment-tremor", "low-vision-magnified", "cognitive-adhd", "dyslexic-user", "elderly-low-vision"],
        wcagCriteria,
        severity,
        remediation: "Allow users to extend, adjust, or disable time limits",
      });
      ctx.wcagViolations.add("2.2.1");
    }
  }
}

/**
 * Detect color-only information
 * v10.10.0: Always detect color-only issues regardless of persona
 * (issues exist on the page whether or not this persona would encounter them)
 */
async function detectColorOnlyInfo(ctx: BarrierContext): Promise<void> {
  const { page, persona: _persona, barriers } = ctx;

  // v10.10.0: Removed trait-based skipping - always detect issues

  const colorOnlyElements = await page.$$eval(
    '[class*="red"], [class*="green"], [class*="error"], [class*="success"], [class*="warning"]',
    (elements) => elements.map(el => {
      const styles = window.getComputedStyle(el);
      const hasIcon = el.querySelector('svg, i, [class*="icon"]') !== null;
      const hasText = (el.textContent?.trim() || '').length > 0;
      return {
        selector: el.tagName.toLowerCase() + (el.className ? `.${(el as HTMLElement).className.split(' ')[0]}` : ''),
        hasIcon,
        hasText,
        color: styles.color,
        bgColor: styles.backgroundColor,
      };
    }).filter(el => !el.hasIcon && !el.hasText)
  );

  for (const el of colorOnlyElements.slice(0, 5)) {
    barriers.push({
      type: "sensory",
      element: el.selector,
      description: "Information conveyed by color alone may not be perceivable by color-blind users",
      affectedPersonas: ["color-blind-deuteranopia"],
      wcagCriteria: ["1.4.1"],
      severity: "major",
      remediation: "Add icons, patterns, or text labels in addition to color",
    });
    ctx.wcagViolations.add("1.4.1");
  }
}

/**
 * Detect missing alt text and captions
 * v10.10.0: Also detect empty alt text on non-decorative images
 */
async function detectMissingAltText(ctx: BarrierContext): Promise<void> {
  const { page, persona: _persona, barriers } = ctx;

  // Check images without alt attribute
  const imagesWithoutAlt = await page.$$eval('img:not([alt])', (elements) =>
    elements.map(el => {
      const imgEl = el as HTMLImageElement;
      return {
        selector: `img[src="${imgEl.src.slice(0, 50)}..."]`,
        isDecorative: imgEl.width < 20 || imgEl.height < 20,
        issue: "missing",
      };
    }).filter(el => !el.isDecorative).slice(0, 10)
  );

  // v10.10.0: Also check images with empty alt text that appear non-decorative
  const imagesWithEmptyAlt = await page.$$eval('img[alt=""]', (elements) =>
    elements.map(el => {
      const imgEl = el as HTMLImageElement;
      const rect = imgEl.getBoundingClientRect();
      // Non-decorative heuristics: large enough to be content, in main content area, etc.
      const isLikelyDecorative =
        imgEl.width < 20 || imgEl.height < 20 ||
        rect.width < 50 || rect.height < 50 ||
        imgEl.className.includes('icon') ||
        imgEl.className.includes('decoration') ||
        imgEl.className.includes('separator') ||
        imgEl.getAttribute('role') === 'presentation';
      return {
        selector: `img[src="${imgEl.src.slice(0, 50)}..."]`,
        isDecorative: isLikelyDecorative,
        issue: "empty",
        width: rect.width,
        height: rect.height,
      };
    }).filter(el => !el.isDecorative).slice(0, 10)
  );

  for (const img of imagesWithoutAlt) {
    barriers.push({
      type: "sensory",
      element: img.selector,
      description: "Image without alt text - screen reader users cannot understand the content",
      affectedPersonas: ["deaf-user", "low-vision-magnified"],
      wcagCriteria: ["1.1.1"],
      severity: "major",
      remediation: "Add descriptive alt text, or alt=\"\" if image is purely decorative",
    });
    ctx.wcagViolations.add("1.1.1");
  }

  // v10.10.0: Flag potentially meaningful images marked as decorative
  for (const img of imagesWithEmptyAlt) {
    barriers.push({
      type: "sensory",
      element: img.selector,
      description: `Large image (${Math.round(img.width)}x${Math.round(img.height)}px) has empty alt text - may be incorrectly marked as decorative`,
      affectedPersonas: ["deaf-user", "low-vision-magnified"],
      wcagCriteria: ["1.1.1"],
      severity: "minor",
      remediation: "Verify this image is purely decorative. If it conveys meaning, add descriptive alt text",
    });
    ctx.wcagViolations.add("1.1.1");
  }

  // Check for videos without captions indicator
  // v10.10.0: Always detect, not just for deaf-user persona
  const videos = await page.$$eval('video, iframe[src*="youtube"], iframe[src*="vimeo"]', (elements) =>
    elements.map(el => ({
      selector: el.tagName.toLowerCase(),
      hasCaptions: el.querySelector('track[kind="captions"]') !== null,
    })).filter(el => !el.hasCaptions)
  );

  if (videos.length > 0) {
    barriers.push({
      type: "sensory",
      element: "video",
      description: `${videos.length} video(s) may not have captions - deaf users cannot access audio content`,
      affectedPersonas: ["deaf-user"],
      wcagCriteria: ["1.2.2"],
      severity: "critical",
      remediation: "Add captions to all video content",
    });
    ctx.wcagViolations.add("1.2.2");
  }
}

/**
 * Detect missing form labels
 * v10.10.0: New detector for unlabeled form inputs
 */
async function detectMissingFormLabels(ctx: BarrierContext): Promise<void> {
  const { page, barriers } = ctx;

  const unlabeledInputs = await page.$$eval(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]), textarea, select',
    (elements) => {
      const results: Array<{ selector: string; type: string; hasLabel: boolean; hasAriaLabel: boolean; hasPlaceholder: boolean }> = [];

      for (const el of elements.slice(0, 50)) {
        const input = el as HTMLInputElement;
        const id = input.id;

        // Check for associated label
        const hasLabel = id ? document.querySelector(`label[for="${id}"]`) !== null : false;

        // Check for aria-label or aria-labelledby
        const hasAriaLabel = input.hasAttribute('aria-label') || input.hasAttribute('aria-labelledby');

        // Check for placeholder (not a valid label, but informative)
        const hasPlaceholder = input.hasAttribute('placeholder');

        if (!hasLabel && !hasAriaLabel) {
          results.push({
            selector: input.tagName.toLowerCase() + (id ? `#${id}` : '') + (input.name ? `[name="${input.name}"]` : ''),
            type: input.type || 'text',
            hasLabel,
            hasAriaLabel,
            hasPlaceholder,
          });
        }
      }

      return results;
    }
  );

  for (const input of unlabeledInputs.slice(0, 10)) {
    const placeholderNote = input.hasPlaceholder
      ? ' (has placeholder, but placeholders are not valid labels)'
      : '';
    barriers.push({
      type: "cognitive_load",
      element: input.selector,
      description: `Form input (${input.type}) has no accessible label${placeholderNote}`,
      affectedPersonas: ["low-vision-magnified", "cognitive-adhd", "dyslexic-user"],
      wcagCriteria: ["1.3.1", "3.3.2", "4.1.2"],
      severity: "major",
      remediation: "Add a <label for=\"id\"> element or aria-label attribute to identify the input's purpose",
    });
    ctx.wcagViolations.add("3.3.2");
    ctx.wcagViolations.add("4.1.2");
  }
}

// ============================================================================
// Persona-Specific Detectors (v18.15.0)
// ============================================================================

/**
 * Get the persona category for routing to specialized detectors.
 * @since v18.15.0
 */
function getPersonaCategory(personaName: string): "motor" | "cognitive" | "vision" | "general" {
  const name = personaName.toLowerCase();

  // Motor personas
  if (
    name.includes("motor") ||
    name.includes("tremor") ||
    name.includes("limited-mobility") ||
    name.includes("mobility")
  ) {
    return "motor";
  }

  // Cognitive personas
  if (
    name.includes("adhd") ||
    name.includes("dyslexia") ||
    name.includes("dyslexic") ||
    name.includes("memory") ||
    name.includes("cognitive")
  ) {
    return "cognitive";
  }

  // Vision personas
  if (
    name.includes("vision") ||
    name.includes("low-vision") ||
    name.includes("color-blind") ||
    name.includes("deuteranopia") ||
    name.includes("elderly")
  ) {
    return "vision";
  }

  return "general";
}

/**
 * Detect barriers specifically relevant to motor-impaired personas.
 *
 * Key checks:
 * - Target size violations (< 44x44px critical for tremor users)
 * - Hover-dependent interactions (impossible with tremor)
 * - Drag-and-drop without keyboard alternative
 * - Time-limited interactions
 *
 * @since v18.15.0
 */
async function detectMotorBarriers(ctx: BarrierContext): Promise<void> {
  const { page, barriers } = ctx;

  // Check for hover-dependent interactions (no click alternative)
  const hoverOnlyElements = await page.$$eval(
    '[class*="hover"], [class*="dropdown"], [class*="menu"], [class*="tooltip"]',
    (elements) => {
      const results: Array<{ selector: string; hasClickAlternative: boolean; text: string }> = [];

      for (const el of elements.slice(0, 20)) {
        // Check if element or children have click handlers
        const hasClick = el.hasAttribute('onclick') ||
                         el.querySelector('[onclick]') !== null ||
                         el.querySelector('a, button') !== null;

        results.push({
          selector: el.tagName.toLowerCase() + (el.className ? `.${(el as HTMLElement).className.split(' ')[0]}` : ''),
          hasClickAlternative: hasClick,
          text: el.textContent?.trim().slice(0, 30) || '',
        });
      }

      return results.filter(r => !r.hasClickAlternative);
    }
  );

  for (const el of hoverOnlyElements.slice(0, 5)) {
    barriers.push({
      type: "motor_precision",
      element: el.selector,
      description: `Hover-dependent interaction without click alternative may be inaccessible for users with tremors`,
      affectedPersonas: ["motor-impairment-tremor", "motor-impairment-limited-mobility"],
      wcagCriteria: ["2.1.1", "2.5.1"],
      severity: "major",
      remediation: "Add click/tap alternative to hover interactions, or make hover content accessible via keyboard focus",
    });
    ctx.wcagViolations.add("2.1.1");
  }

  // Check for drag-and-drop without keyboard alternative
  const dragDropElements = await page.$$eval(
    '[draggable="true"], [class*="drag"], [class*="sortable"], [class*="reorder"]',
    (elements) => elements.map(el => ({
      selector: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : ''),
      hasAriaGrabbed: el.hasAttribute('aria-grabbed'),
      hasKeyboardHandler: el.hasAttribute('onkeydown') || el.hasAttribute('onkeyup'),
    }))
  );

  for (const el of dragDropElements.slice(0, 3)) {
    if (!el.hasKeyboardHandler) {
      barriers.push({
        type: "motor_precision",
        element: el.selector,
        description: `Drag-and-drop element lacks keyboard alternative`,
        affectedPersonas: ["motor-impairment-tremor", "motor-impairment-limited-mobility"],
        wcagCriteria: ["2.1.1", "2.5.7"],
        severity: "critical",
        remediation: "Provide keyboard-accessible alternative for drag-and-drop (arrow keys, or explicit move buttons)",
      });
      ctx.wcagViolations.add("2.1.1");
    }
  }

  // Check for very small spacing between interactive elements (motor precision issue)
  const closeElements = await page.$$eval(
    'button, a, input[type="checkbox"], input[type="radio"]',
    (elements) => {
      const closeGroups: Array<{ selectors: string[]; spacing: number }> = [];
      const elArray = Array.from(elements);

      for (let i = 0; i < Math.min(elArray.length, 30); i++) {
        const rect1 = elArray[i].getBoundingClientRect();
        if (rect1.width === 0) continue;

        for (let j = i + 1; j < Math.min(elArray.length, 30); j++) {
          const rect2 = elArray[j].getBoundingClientRect();
          if (rect2.width === 0) continue;

          // Calculate distance between elements
          const dx = Math.max(0, Math.max(rect1.left, rect2.left) - Math.min(rect1.right, rect2.right));
          const dy = Math.max(0, Math.max(rect1.top, rect2.top) - Math.min(rect1.bottom, rect2.bottom));
          const distance = Math.sqrt(dx * dx + dy * dy);

          // Flag elements less than 8px apart
          if (distance < 8 && distance >= 0) {
            closeGroups.push({
              selectors: [
                elArray[i].tagName.toLowerCase() + (elArray[i].id ? `#${elArray[i].id}` : ''),
                elArray[j].tagName.toLowerCase() + (elArray[j].id ? `#${elArray[j].id}` : '')
              ],
              spacing: Math.round(distance),
            });
          }
        }
      }

      return closeGroups.slice(0, 5);
    }
  );

  if (closeElements.length > 0) {
    barriers.push({
      type: "motor_precision",
      element: `${closeElements.length} element groups`,
      description: `${closeElements.length} groups of interactive elements are very close together (< 8px spacing), making them difficult to target for users with tremors`,
      affectedPersonas: ["motor-impairment-tremor"],
      wcagCriteria: ["2.5.5"],
      severity: "major",
      remediation: "Increase spacing between interactive elements to at least 8-12px",
    });
  }
}

/**
 * Detect barriers specifically relevant to cognitive personas (ADHD, dyslexia, memory impairment).
 *
 * Key checks:
 * - Form complexity (field count, required fields)
 * - Distraction count (animations, auto-playing media)
 * - Reading level (sentence complexity)
 * - Memory burden (multi-step processes without progress indicators)
 *
 * @since v18.15.0
 */
async function detectCognitiveBarriers(ctx: BarrierContext): Promise<void> {
  const { page, barriers } = ctx;

  // Check for auto-playing media (distraction for ADHD)
  const autoPlayMedia = await page.$$eval(
    'video[autoplay], audio[autoplay], [class*="autoplay"]',
    (elements) => elements.map(el => ({
      selector: el.tagName.toLowerCase(),
      hasControls: el.hasAttribute('controls'),
      hasMuted: el.hasAttribute('muted'),
    }))
  );

  for (const media of autoPlayMedia) {
    if (!media.hasMuted) {
      barriers.push({
        type: "cognitive_load",
        element: media.selector,
        description: `Auto-playing ${media.selector} with sound can be highly distracting for users with ADHD`,
        affectedPersonas: ["cognitive-adhd"],
        wcagCriteria: ["1.4.2", "2.2.2"],
        severity: "critical",
        remediation: "Add muted attribute to autoplay media, or provide user controls to pause/stop",
      });
      ctx.wcagViolations.add("1.4.2");
    }
  }

  // Check for multi-step forms without progress indicator
  const multiStepForms = await page.$$eval('form', (forms) => {
    const results: Array<{
      selector: string;
      fieldCount: number;
      hasProgress: boolean;
      hasStepIndicator: boolean;
    }> = [];

    for (const form of forms) {
      const inputs = form.querySelectorAll('input:not([type="hidden"]):not([type="submit"]), textarea, select');
      const hasProgress =
        form.querySelector('[class*="progress"], [class*="stepper"], [role="progressbar"]') !== null ||
        document.querySelector('[class*="step-indicator"], [class*="wizard"]') !== null;

      results.push({
        selector: 'form' + (form.id ? `#${form.id}` : ''),
        fieldCount: inputs.length,
        hasProgress,
        hasStepIndicator: hasProgress,
      });
    }

    return results;
  });

  for (const form of multiStepForms) {
    if (form.fieldCount > 5 && !form.hasProgress) {
      barriers.push({
        type: "cognitive_load",
        element: form.selector,
        description: `Form with ${form.fieldCount} fields lacks progress indicator - users with memory impairment may lose track of progress`,
        affectedPersonas: ["cognitive-adhd", "cognitive-memory-impairment"],
        wcagCriteria: ["3.3.4"],
        severity: "major",
        remediation: "Add progress indicator showing steps completed and remaining, or break form into clearly numbered sections",
      });
    }
  }

  // Check for dense text blocks (dyslexia barrier)
  const denseTextBlocks = await page.$$eval('p, article, section', (elements) => {
    const results: Array<{
      selector: string;
      wordCount: number;
      lineHeight: string;
      fontSize: string;
    }> = [];

    for (const el of elements.slice(0, 20)) {
      const text = el.textContent || '';
      const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
      const styles = window.getComputedStyle(el);

      // Flag blocks with 200+ words AND tight line spacing
      if (wordCount > 200) {
        results.push({
          selector: el.tagName.toLowerCase() + (el.className ? `.${(el as HTMLElement).className.split(' ')[0]}` : ''),
          wordCount,
          lineHeight: styles.lineHeight,
          fontSize: styles.fontSize,
        });
      }
    }

    return results;
  });

  for (const block of denseTextBlocks.slice(0, 3)) {
    const lineHeightNum = parseFloat(block.lineHeight);
    const fontSizeNum = parseFloat(block.fontSize);
    const lineHeightRatio = lineHeightNum / fontSizeNum;

    // Line height < 1.5 is hard for dyslexic users
    if (lineHeightRatio < 1.5) {
      barriers.push({
        type: "cognitive_load",
        element: block.selector,
        description: `Dense text block (${block.wordCount} words) with tight line spacing (${lineHeightRatio.toFixed(1)}x) is difficult for dyslexic users`,
        affectedPersonas: ["dyslexic-user"],
        wcagCriteria: ["1.4.12"],
        severity: "major",
        remediation: "Increase line-height to at least 1.5x font size, and consider breaking text into shorter paragraphs with headings",
      });
      ctx.wcagViolations.add("1.4.12");
    }
  }

  // Check for justified text (dyslexia barrier)
  const justifiedText = await page.$$eval('p, article, div', (elements) => {
    const results: string[] = [];

    for (const el of elements.slice(0, 50)) {
      const styles = window.getComputedStyle(el);
      if (styles.textAlign === 'justify') {
        results.push(el.tagName.toLowerCase() + (el.className ? `.${(el as HTMLElement).className.split(' ')[0]}` : ''));
      }
    }

    return results.slice(0, 5);
  });

  if (justifiedText.length > 0) {
    barriers.push({
      type: "cognitive_load",
      element: `${justifiedText.length} elements`,
      description: `Justified text creates uneven word spacing that makes reading difficult for dyslexic users`,
      affectedPersonas: ["dyslexic-user"],
      wcagCriteria: ["1.4.12"],
      severity: "minor",
      remediation: "Use left-aligned text instead of justified for better readability",
    });
    ctx.wcagViolations.add("1.4.12");
  }
}

/**
 * Detect barriers specifically relevant to vision personas (low vision, color blindness, elderly).
 *
 * Key checks:
 * - Contrast ratios below WCAG thresholds
 * - Text scaling behavior
 * - Color-only information
 * - Small font sizes (< 16px)
 *
 * @since v18.15.0
 */
async function detectVisionBarriers(ctx: BarrierContext): Promise<void> {
  const { page, barriers } = ctx;

  // Check for small base font sizes (vision impairment)
  const smallFontElements = await page.$$eval('body, p, span, div, li, td', (elements) => {
    const results: Array<{ selector: string; fontSize: string; fontSizeNum: number }> = [];

    for (const el of elements.slice(0, 100)) {
      const styles = window.getComputedStyle(el);
      const fontSize = parseFloat(styles.fontSize);

      // Flag fonts smaller than 14px as problematic for low vision
      if (fontSize > 0 && fontSize < 14) {
        results.push({
          selector: el.tagName.toLowerCase() + (el.className ? `.${(el as HTMLElement).className.split(' ')[0]}` : ''),
          fontSize: styles.fontSize,
          fontSizeNum: fontSize,
        });
      }
    }

    return results.slice(0, 10);
  });

  if (smallFontElements.length > 0) {
    const avgSize = smallFontElements.reduce((sum, el) => sum + el.fontSizeNum, 0) / smallFontElements.length;
    barriers.push({
      type: "visual_clarity",
      element: `${smallFontElements.length} elements`,
      description: `${smallFontElements.length} text elements use small font sizes (avg ${avgSize.toFixed(0)}px) that may be difficult for low-vision users`,
      affectedPersonas: ["low-vision-magnified", "elderly-low-vision"],
      wcagCriteria: ["1.4.4"],
      severity: avgSize < 12 ? "critical" : "major",
      remediation: "Use minimum 16px base font size, and ensure text can be resized to 200% without loss of content",
    });
    ctx.wcagViolations.add("1.4.4");
  }

  // Check for thin fonts (hard for low vision)
  const thinFontElements = await page.$$eval('body, h1, h2, h3, p, span', (elements) => {
    const results: string[] = [];

    for (const el of elements.slice(0, 50)) {
      const styles = window.getComputedStyle(el);
      const fontWeight = parseInt(styles.fontWeight, 10) || 400;

      // Font weight < 400 is thin and harder to read
      if (fontWeight < 400 && el.textContent && el.textContent.trim().length > 0) {
        results.push(el.tagName.toLowerCase());
      }
    }

    return results;
  });

  if (thinFontElements.length > 3) {
    barriers.push({
      type: "visual_clarity",
      element: `${thinFontElements.length} text elements`,
      description: `Multiple elements use thin font weights (< 400) which are harder to read for low-vision users`,
      affectedPersonas: ["low-vision-magnified", "elderly-low-vision"],
      wcagCriteria: ["1.4.12"],
      severity: "minor",
      remediation: "Use font-weight 400 or higher for body text to improve readability",
    });
  }

  // Check for links distinguished only by color (color blindness)
  const colorOnlyLinks = await page.$$eval('a', (links) => {
    const results: Array<{ selector: string; hasUnderline: boolean; hasIcon: boolean }> = [];

    for (const link of links.slice(0, 30)) {
      const styles = window.getComputedStyle(link);
      const hasUnderline = styles.textDecoration.includes('underline');
      const hasIcon = link.querySelector('svg, i, [class*="icon"]') !== null;

      if (!hasUnderline && !hasIcon) {
        results.push({
          selector: link.textContent?.trim().slice(0, 20) || 'link',
          hasUnderline,
          hasIcon,
        });
      }
    }

    return results;
  });

  if (colorOnlyLinks.length > 2) {
    barriers.push({
      type: "sensory",
      element: `${colorOnlyLinks.length} links`,
      description: `${colorOnlyLinks.length} links are distinguished only by color, without underline or icon - color-blind users may not identify them as links`,
      affectedPersonas: ["color-blind-deuteranopia"],
      wcagCriteria: ["1.4.1"],
      severity: "major",
      remediation: "Add underline to links on hover/focus at minimum, or use a non-color visual indicator",
    });
    ctx.wcagViolations.add("1.4.1");
  }

  // Check for status indicators using only red/green (color blindness)
  const redGreenIndicators = await page.$$eval(
    '[class*="status"], [class*="indicator"], [class*="badge"], [class*="alert"]',
    (elements) => {
      const problematic: string[] = [];

      for (const el of elements.slice(0, 20)) {
        const styles = window.getComputedStyle(el);
        const bgColor = styles.backgroundColor;
        const color = styles.color;

        // Simplified red/green detection
        const hasRedGreen =
          (bgColor.includes('255') && bgColor.includes('0')) || // Pure red or green
          (color.includes('255') && color.includes('0'));

        const hasIcon = el.querySelector('svg, i, [class*="icon"]') !== null;
        const hasText = (el.textContent?.trim() || '').length > 1;

        if (hasRedGreen && !hasIcon && !hasText) {
          problematic.push(el.className?.split(' ')[0] || 'indicator');
        }
      }

      return problematic;
    }
  );

  if (redGreenIndicators.length > 0) {
    barriers.push({
      type: "sensory",
      element: `${redGreenIndicators.length} status indicators`,
      description: `Status indicators using red/green without additional cues may be indistinguishable for color-blind users`,
      affectedPersonas: ["color-blind-deuteranopia"],
      wcagCriteria: ["1.4.1"],
      severity: "major",
      remediation: "Add icons, patterns, or text labels to status indicators in addition to color",
    });
    ctx.wcagViolations.add("1.4.1");
  }
}

// ============================================================================
// Journey Simulation for Empathy
// ============================================================================

async function simulateAccessibilityJourney(
  page: Page,
  url: string,
  goal: string,
  persona: AccessibilityPersona,
  scope: "viewport" | "full_page" = "viewport",
  maxSteps: number,
  maxTime: number,
  wcagLevel: "A" | "AA" | "AAA" = "AA"
): Promise<AccessibilityEmpathyResult> {
  const startTime = Date.now();
  const ctx: BarrierContext = {
    page,
    persona,
    barriers: [],
    frictionPoints: [],
    wcagViolations: new Set(),
    stepCount: 0,
    viewportOnly: scope === "viewport",
    wcagLevel,
  };

  let goalAchieved = false;
  let journeyValidation: Record<string, unknown> | undefined;

  // Emotional state captured from cognitive journey (v13.1.0)
  let finalEmotionalState: import("../types.js").EmotionalState | undefined;
  let emotionalEvents: import("../types.js").EmotionalEvent[] | undefined;

  try {
    // Navigate to URL
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 10000 });
    await page.waitForTimeout(1500);

    // Scope-dependent page discovery
    if (scope === "full_page") {
      // Scroll through the full page to trigger lazy-loaded content
      try {
        const pageHeight = await page.evaluate(() => document.body.scrollHeight);
        const viewportHeight = await page.evaluate(() => window.innerHeight);
        const scrollSteps = Math.min(5, Math.ceil(pageHeight / viewportHeight));

        for (let i = 1; i <= scrollSteps; i++) {
          await page.evaluate((y: number) => window.scrollTo(0, y), i * viewportHeight);
          await page.waitForTimeout(300);
        }
        // Scroll back to top — detectors check full DOM
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(300);
      } catch {
        // Scroll failure is non-fatal
      }
    }
    // viewport scope: no scroll — evaluate only what the user sees on first paint

    // Inject viewport filter helper so barrier detectors can scope their queries
    if (scope === "viewport") {
      await page.evaluate(() => {
        const vh = window.innerHeight;
        (window as any).__cbrowserInViewport = (el: Element): boolean => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < vh;
        };
        (window as any).__cbrowserViewportOnly = true;
      });
    } else {
      await page.evaluate(() => {
        (window as any).__cbrowserInViewport = () => true; // full page = everything counts
        (window as any).__cbrowserViewportOnly = false;
      });
    }

    // Run barrier detection
    // v10.10.0: All general detectors run unconditionally regardless of persona
    await detectSmallTouchTargets(ctx);
    await detectLowContrast(ctx);
    await detectCognitiveLoad(ctx);
    await detectTimingIssues(ctx);
    await detectColorOnlyInfo(ctx);
    await detectMissingAltText(ctx);
    await detectMissingFormLabels(ctx);

    // v18.15.0: Run persona-specific detectors based on persona category
    // This ensures each persona type gets specialized barrier detection
    const personaCategory = getPersonaCategory(persona.name);

    switch (personaCategory) {
      case "motor":
        await detectMotorBarriers(ctx);
        break;
      case "cognitive":
        await detectCognitiveBarriers(ctx);
        break;
      case "vision":
        await detectVisionBarriers(ctx);
        break;
      case "general":
        // Run all category-specific detectors for general personas
        await detectMotorBarriers(ctx);
        await detectCognitiveBarriers(ctx);
        await detectVisionBarriers(ctx);
        break;
    }

    // Use cognitive journey for realistic step tracking if API key available
    // v18.35.0: Add hard timeout to prevent MCP proxy disconnection (~60s limit on claude.ai)
    const journeyTimeoutMs = Math.min(maxTime * 1000, 45000); // Hard cap at 45s to leave margin
    if (isApiKeyConfigured()) {
      try {
        const journeyPromise = runCognitiveJourney({
          persona: persona.name,
          startUrl: url,
          goal,
          maxSteps: Math.min(maxSteps, 5), // Cap steps to keep within timeout
          maxTime: Math.min(maxTime, 30),   // Cap journey time
          headless: true,
          vision: false,
          verbose: false,
        });
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Journey timeout")), journeyTimeoutMs)
        );
        const journey = await Promise.race([journeyPromise, timeoutPromise]);
        ctx.stepCount = journey.stepCount;

        // Capture emotional state (v13.1.0)
        finalEmotionalState = journey.finalState.emotionalState;
        emotionalEvents = journey.finalState.emotionalJourney;

        // Map cognitive friction to accessibility friction
        for (const fp of journey.frictionPoints) {
          // Map FrictionPoint types to AccessibilityFrictionPoint types
          const accessibilityType =
            fp.type === "form_error" ? "motor" :
            fp.type === "confusing_ui" || fp.type === "unclear_button" ? "visual" :
            fp.type === "slow_load" || fp.type === "missing_element" ? "cognitive" :
            "cognitive";

          ctx.frictionPoints.push({
            step: ctx.stepCount,
            type: accessibilityType,
            description: fp.monologue.substring(0, 100),
            impact: fp.frustrationIncrease > 0.2 ? "high" : fp.frustrationIncrease > 0.1 ? "medium" : "low",
            accessibilityContext: `Cognitive state: patience ${Math.round(journey.finalState.patienceRemaining * 100)}%`,
          });
        }

        goalAchieved = journey.goalAchieved;

        // v18.29.0: Store journey validation data for attachment to result
        journeyValidation = {
          goalAchieved: journey.goalAchieved,
          goalEvidence: journey.goalEvidence || null,
          failureReason: journey.failureReason || null,
          navigationPath: journey.navigationPath || [],
          lastPage: journey.lastPage || null,
          stepCount: journey.stepCount,
          journeyLog: (journey.journeyLog || []).map((s) => ({
            step: s.step,
            url: s.url,
            action: s.action,
            focusedElement: s.focusedElement,
            mood: s.mood,
            goalProgress: s.goalProgress,
          })),
        };
      } catch {
        // Fall back to barrier-based estimation
        ctx.stepCount = Math.max(3, ctx.barriers.length + 2);
      }
    } else {
      // Estimate step count based on detected barriers (deterministic, not random)
      ctx.stepCount = Math.max(3, ctx.barriers.length + 2);
    }

    // v11.11.0: Improved goalAchieved calibration (stress test fix)
    // Distinguish FRICTION (difficult but achievable) from BLOCKER (impossible)
    //
    // BLOCKERS (goalAchieved = false):
    // - Element completely invisible/missing
    // - Element trapped behind non-dismissible overlay
    // - Critical timing issue that expires before action possible
    //
    // FRICTION (goalAchieved = true, with reduced score):
    // - Small touch targets (can still be clicked, just harder)
    // - Low contrast (can still be read, just slower)
    // - Cognitive load (can still complete, just more confusing)
    // - Minor/major severity barriers that slow but don't block
    const criticalBarriers = ctx.barriers.filter(b => b.severity === "critical");

    // Only truly blocking barriers should prevent goal achievement
    // Touch targets, contrast, cognitive load are friction, not blockers
    const blockingBarrierTypes: AccessibilityBarrierType[] = ["timing"]; // Timeout = can't complete
    const blockingBarriers = criticalBarriers.filter(b => blockingBarrierTypes.includes(b.type));

    // Simulate friction based on persona traits
    if (persona.accessibilityTraits.motorControl && persona.accessibilityTraits.motorControl < 0.5) {
      const smallTargets = ctx.barriers.filter(b => b.type === "touch_target");
      if (smallTargets.length > 3) {
        ctx.frictionPoints.push({
          step: 2,
          type: "motor",
          description: "Multiple small touch targets caused repeated mis-clicks",
          impact: "high",
          accessibilityContext: "Essential tremor makes precise clicking difficult",
        });
      }
    }

    if (persona.accessibilityTraits.visionLevel && persona.accessibilityTraits.visionLevel < 0.5) {
      const contrastIssues = ctx.barriers.filter(b => b.type === "contrast");
      if (contrastIssues.length > 2) {
        ctx.frictionPoints.push({
          step: 1,
          type: "visual",
          description: "Low contrast text required zooming and squinting",
          impact: "high",
          accessibilityContext: "3x magnification still insufficient for gray text",
        });
      }
    }

    if (persona.accessibilityTraits.attentionSpan && persona.accessibilityTraits.attentionSpan < 0.5) {
      const cognitiveIssues = ctx.barriers.filter(b => b.type === "cognitive_load");
      if (cognitiveIssues.length > 0) {
        ctx.frictionPoints.push({
          step: 3,
          type: "cognitive",
          description: "Lost focus due to complex form layout",
          impact: "high",
          accessibilityContext: "ADHD makes long forms particularly challenging",
        });
      }
    }

    // v11.11.0: Goal is achievable unless there are truly blocking barriers
    // Friction (small targets, contrast, cognitive load) reduces score but doesn't block
    goalAchieved = blockingBarriers.length === 0;

    // If journey validation says goal failed, override barrier-based goalAchieved
    if (journeyValidation && journeyValidation.goalAchieved === false) {
      goalAchieved = false;
    }

  } catch (e) {
    ctx.frictionPoints.push({
      step: 0,
      type: "error",
      description: `Navigation error: ${(e as Error).message}`,
      impact: "high",
    });
  }

  // v18.26.0: Persona-weighted scoring via perceptual transport profiles
  // Each persona has different barrier weights — motor users are 3x penalized
  // by touch targets, ADHD by cognitive load, low-vision by contrast, etc.
  const perceptualResult = calculatePerceptualScore(
    ctx.barriers,
    ctx.frictionPoints,
    goalAchieved,
    persona.name,
    (persona as any).accessibilityTraits,
  );
  const empathyScore = perceptualResult.score;
  const totalDeduction = Object.values(perceptualResult.deductions).reduce((a, b) => a + Math.abs(b), 0);
  const scoreContext = {
    baseScore: 100,
    deductionsByType: perceptualResult.deductions,
    totalBarrierDeduction: totalDeduction,
    // Were a hardcoded 0 and a locally re-derived guess. Both now come from the
    // same computation that actually moved the score, so the numbered fields and
    // the explanation prose can no longer disagree. (2026-07-28)
    frictionDeduction: perceptualResult.frictionDeduction,
    goalDeduction: perceptualResult.goalDeduction,
    cognitiveOverloadPenalty: perceptualResult.cognitiveOverloadPenalty,
    // The reading behind the prose above and behind cognitiveOverloadPenalty.
    // Named because two other numbers in this payload are also "cognitive load".
    visualComplexityCognitiveLoad: perceptualResult.cognitiveLoad,
    // Susceptibility weight applied per barrier type for THIS persona. Barriers
    // name a couple of exemplar affectedPersonas, which looks contradictory
    // beside a deduction charged to a different persona; the weight is what
    // actually differentiates them.
    appliedBarrierWeights: perceptualResult.appliedWeights,
    finalScore: empathyScore,
    explanation: perceptualResult.explanation
      + (perceptualResult.informationLoss > 0.05 ? ` | Info loss: ${(perceptualResult.informationLoss * 100).toFixed(0)}%` : '')
      + (perceptualResult.motorCost > 0.1 ? ` | Motor cost: ${(perceptualResult.motorCost * 100).toFixed(0)}%` : '')
      // Labelled by source. Three different numbers in one payload all called
      // "cognitive load" — this one (visual-complexity model), the screenshot
      // Wasserstein figure in perceptualTransport.cognitiveLoad, and the optimal
      // transport figure in cognitiveLoad.totalLoad. On one example.com audit
      // they read 70%, 34% and 4% respectively. See cognitiveLoadReadings.
      // (2026-07-28)
      + (perceptualResult.cognitiveLoad > 0.3 ? ` | Visual-complexity cog load: ${(perceptualResult.cognitiveLoad * 100).toFixed(0)}%` : ''),
  };

  // Generate remediation priorities
  const remediationPriority = generateRemediationPriority(ctx.barriers);

  // Capture page screenshot for WCAG overlay visualization
  let pageScreenshotBase64: string | undefined;
  let viewportSize: { width: number; height: number } | undefined;
  // Full document height, so a consumer can tell whether a rect in document
  // coordinates actually falls inside the captured image. Comparing document
  // coordinates against the VIEWPORT height flagged every rect as outside.
  // (2026-07-29)
  let documentHeight: number | undefined;
  try {
    const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: false });
    pageScreenshotBase64 = Buffer.from(screenshotBuffer).toString('base64');
    const vp = page.viewportSize();
    if (vp) viewportSize = { width: vp.width, height: vp.height };
    documentHeight = await page.evaluate(() =>
      Math.max(document.body?.scrollHeight ?? 0, document.documentElement?.scrollHeight ?? 0)
    );
  } catch {}

  return {
    url,
    persona: persona.name,
    disabilityType: getDisabilityType(persona),
    goalAchieved,
    barriers: ctx.barriers,
    frictionPoints: ctx.frictionPoints,
    // Filtered to the audit's conformance level, exactly as the top-level
    // allWcagViolations is (see the filter near the end of runEmpathyAudit).
    // Without this the per-persona list kept AAA criteria that the aggregate
    // had dropped at AA, so wcagViolationCount read 2 beside an
    // allWcagViolations of ["2.2.2"] — the same finding counted under two
    // different rules. (2026-07-29)
    wcagViolations: Array.from(ctx.wcagViolations).filter((v) => {
      const criteria = WCAG_CRITERIA[v];
      const order: Record<string, number> = { A: 1, AA: 2, AAA: 3 };
      return !criteria || order[criteria.level] <= order[wcagLevel];
    }),
    remediationPriority,
    empathyScore,
    scoreContext, // v18.22.0: Added score breakdown
    duration: Date.now() - startTime,
    finalEmotionalState,
    emotionalEvents,
    journeyValidation, // v18.29.0
    pageScreenshot: pageScreenshotBase64, // v18.60.0: For WCAG overlay visualization
    viewportSize, // v18.60.0
    documentHeight,
  } as any;
}

function getDisabilityType(persona: AccessibilityPersona): string {
  if (persona.accessibilityTraits.tremor) return "Motor impairment (tremor)";
  if (persona.accessibilityTraits.visionLevel && persona.accessibilityTraits.visionLevel < 0.5) return "Low vision";
  if (persona.accessibilityTraits.colorBlindness) return `Color blindness (${persona.accessibilityTraits.colorBlindness})`;
  if (persona.cognitiveTraits?.workingMemory && persona.cognitiveTraits.workingMemory < 0.5) return "Cognitive (ADHD/Memory)";
  if (persona.accessibilityTraits.processingSpeed && persona.accessibilityTraits.processingSpeed < 0.6) return "Cognitive (Processing)";
  return "General accessibility";
}

/**
 * Score calculation result with context (v18.22.0)
 */
interface ScoreResult {
  score: number;
  context: import("../types.js").EmpathyScoreContext;
}

/**
 * v11.10.0: Improved scoring with deduplication and capped deductions (issue #86)
 * v18.22.0: Added score context for transparency
 *
 * Previous issues:
 * - 10 small touch targets = -30 to -200 points (too harsh)
 * - Same barrier type detected per-element caused score collapse
 * - goalAchieved=false added -20 even when navigation was possible
 *
 * New approach:
 * - Group barriers by type, cap deduction per type
 * - Scale by unique issues, not total element count
 * - Base score on accessibility, not just barrier count
 */
function calculateEmpathyScoreWithContext(
  barriers: AccessibilityBarrier[],
  frictionPoints: AccessibilityFrictionPoint[],
  goalAchieved: boolean
): ScoreResult {
  const baseScore = 100;
  let score = baseScore;
  const deductionsByType: Record<string, number> = {};

  // v11.10.0: Group barriers by type to avoid over-penalizing repeated issues
  const barriersByType = new Map<AccessibilityBarrierType, AccessibilityBarrier[]>();
  for (const barrier of barriers) {
    const existing = barriersByType.get(barrier.type) || [];
    existing.push(barrier);
    barriersByType.set(barrier.type, existing);
  }

  // Deduct per barrier TYPE with caps
  // Max deduction per type: critical=25, major=15, minor=8
  let totalBarrierDeduction = 0;
  for (const [type, typeBarriers] of barriersByType) {
    const criticalCount = typeBarriers.filter(b => b.severity === "critical").length;
    const majorCount = typeBarriers.filter(b => b.severity === "major").length;
    const minorCount = typeBarriers.filter(b => b.severity === "minor").length;

    // Diminishing returns: first instance costs most, subsequent less
    const criticalDeduct = Math.min(25, criticalCount > 0 ? 15 + Math.min(criticalCount - 1, 2) * 5 : 0);
    const majorDeduct = Math.min(15, majorCount > 0 ? 8 + Math.min(majorCount - 1, 2) * 3 : 0);
    const minorDeduct = Math.min(8, minorCount > 0 ? 3 + Math.min(minorCount - 1, 3) * 1.5 : 0);

    const typeDeduction = criticalDeduct + majorDeduct + minorDeduct;
    if (typeDeduction > 0) {
      deductionsByType[type] = -typeDeduction;
      totalBarrierDeduction += typeDeduction;
    }
    score -= typeDeduction;
  }

  // Deduct for friction points (capped at 25 total)
  let rawFrictionDeduct = 0;
  for (const fp of frictionPoints) {
    switch (fp.impact) {
      case "high": rawFrictionDeduct += 8; break;
      case "medium": rawFrictionDeduct += 4; break;
      case "low": rawFrictionDeduct += 2; break;
    }
  }
  const frictionDeduction = Math.min(25, rawFrictionDeduct);
  score -= frictionDeduction;

  // Goal achievement affects score but doesn't zero it
  // v11.10.0: Reduced penalty, page can still be partially accessible
  const goalDeduction = goalAchieved ? 0 : 15;
  if (!goalAchieved) score -= 15;

  // Ensure minimum score of 10 if there are any working elements
  // A page with issues is still more accessible than a blank/broken page
  const hasWorkingElements = barriers.some(b => b.severity === "minor");
  if (hasWorkingElements && score < 10) {
    score = 10;
  }

  const finalScore = Math.max(0, Math.round(score));

  // Generate human-readable explanation
  const explanationParts: string[] = [];
  if (Object.keys(deductionsByType).length > 0) {
    const topDeductions = Object.entries(deductionsByType)
      .sort(([, a], [, b]) => a - b) // Most negative first
      .slice(0, 3)
      .map(([type, deduction]) => `${type.replace(/_/g, " ")} (${deduction})`)
      .join(", ");
    explanationParts.push(`Main barrier deductions: ${topDeductions}`);
  }
  if (frictionDeduction > 0) {
    explanationParts.push(`Friction deduction: -${frictionDeduction} (${frictionPoints.length} friction points)`);
  }
  if (goalDeduction > 0) {
    explanationParts.push(`Goal not achieved: -${goalDeduction}`);
  }
  if (explanationParts.length === 0) {
    explanationParts.push("No significant deductions - page is highly accessible");
  }

  return {
    score: finalScore,
    context: {
      baseScore,
      deductionsByType,
      totalBarrierDeduction,
      frictionDeduction,
      goalDeduction,
      finalScore,
      explanation: explanationParts.join(". ") + ".",
    },
  };
}

/**
 * Legacy wrapper for backward compatibility
 */
function calculateEmpathyScore(
  barriers: AccessibilityBarrier[],
  frictionPoints: AccessibilityFrictionPoint[],
  goalAchieved: boolean
): number {
  return calculateEmpathyScoreWithContext(barriers, frictionPoints, goalAchieved).score;
}

function generateRemediationPriority(barriers: AccessibilityBarrier[]): RemediationItem[] {
  const items: RemediationItem[] = [];
  let priority = 1;

  // Sort barriers by severity
  const sorted = [...barriers].sort((a, b) => {
    const severityOrder: Record<AccessibilityBarrierSeverity, number> = {
      critical: 0,
      major: 1,
      minor: 2,
    };
    return severityOrder[a.severity] - severityOrder[b.severity];
  });

  // Group by type to avoid duplicates
  const seen = new Set<string>();

  for (const barrier of sorted) {
    const key = `${barrier.type}-${barrier.description.slice(0, 50)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const effort: AgentReadyEffort =
      barrier.type === "contrast" ? "easy" :
      barrier.type === "touch_target" ? "easy" :
      barrier.type === "cognitive_load" ? "medium" :
      barrier.type === "timing" ? "medium" :
      "trivial";

    items.push({
      priority: priority++,
      issue: barrier.description,
      fix: barrier.remediation,
      wcagCriteria: barrier.wcagCriteria,
      effort,
    });

    if (items.length >= 10) break;
  }

  return items;
}

// ============================================================================
// Report Generation
// ============================================================================

/**
 * Convert numeric empathy score to letter grade
 */
function getEmpathyGrade(score: number): string {
  if (score >= 80) return "A";
  if (score >= 65) return "B";
  if (score >= 50) return "C";
  if (score >= 35) return "D";
  return "F";
}

export function formatEmpathyAuditReport(result: EmpathyAuditResult): string {
  const grade = getEmpathyGrade(result.overallScore);

  let report = `
╔══════════════════════════════════════════════════════════════════════════════╗
║                    ACCESSIBILITY EMPATHY AUDIT                               ║
╚══════════════════════════════════════════════════════════════════════════════╝

URL: ${result.url}
Goal: "${result.goal}"
Timestamp: ${result.timestamp}
Duration: ${(result.duration / 1000).toFixed(1)}s

⚠️  METHODOLOGY: Empathy scores are heuristic estimates based on barrier detection.*
    This is NOT a substitute for testing with actual users who have disabilities.
    *Based on WCAG criteria and persona simulation. See documentation for sources.

┌────────────────────────────────────────────────────────────────────────────┐
│  EMPATHY GRADE: ${grade}                                                          │
│  (Based on ${result.results.length} disability persona simulations)                          │
└────────────────────────────────────────────────────────────────────────────┘

`;

  // Results by persona
  for (const pr of result.results) {
    const emoji = pr.goalAchieved ? '✓' : '✗';
    const scoreColor = pr.empathyScore >= 70 ? '🟢' : pr.empathyScore >= 50 ? '🟠' : '🔴';

    report += `
${pr.disabilityType}
${'─'.repeat(pr.disabilityType.length)}
  Persona: ${pr.persona}
  Score: ${scoreColor} ${pr.empathyScore}/100
  Goal: ${emoji} ${pr.goalAchieved ? 'Achieved' : 'Not achieved'}
  Barriers: ${pr.barriers.length} (${pr.barriers.filter(b => b.severity === 'critical').length} critical)
  Friction points: ${pr.frictionPoints.length}
`;

    if (pr.frictionPoints.length > 0) {
      report += `  Experience issues:\n`;
      for (const fp of pr.frictionPoints) {
        report += `    • ${fp.description}${fp.accessibilityContext ? ` (${fp.accessibilityContext})` : ''}\n`;
      }
    }
  }

  // Combined WCAG violations
  report += `
WCAG VIOLATIONS
───────────────
`;
  for (const violation of result.allWcagViolations) {
    const criteria = WCAG_CRITERIA[violation];
    if (criteria) {
      report += `  ${violation} (Level ${criteria.level}): ${criteria.description}\n`;
    } else {
      report += `  ${violation}\n`;
    }
  }

  // Top remediations
  report += `
TOP REMEDIATION PRIORITIES
──────────────────────────
`;
  for (const rem of result.combinedRemediation.slice(0, 10)) {
    report += `
  ${rem.priority}. ${rem.issue}
     Fix: ${rem.fix}
     WCAG: ${rem.wcagCriteria.join(', ')}
     Effort: ${rem.effort}
`;
  }

  report += `
─────────────────────────────────────────────────────────────────────────────
* Methodology and research sources: docs/METHODOLOGY.md
  Key sources: WCAG 2.1, WebAIM Screen Reader Survey (2024), Baymard Institute

Generated by CBrowser v8.0.0 - Accessibility Empathy Audit
`;

  return report;
}

export function generateEmpathyAuditHtmlReport(result: EmpathyAuditResult): string {
  const grade = getEmpathyGrade(result.overallScore);
  const gradeColor = grade === 'A' || grade === 'B' ? '#10b981' : grade === 'C' ? '#f59e0b' : '#ef4444';

  const personaCards = result.results.map(pr => {
    const personaGrade = getEmpathyGrade(pr.empathyScore);
    const pGradeColor = personaGrade === 'A' || personaGrade === 'B' ? '#10b981' : personaGrade === 'C' ? '#f59e0b' : '#ef4444';
    return `
    <div class="persona-card ${pr.goalAchieved ? 'success' : 'failure'}">
      <div class="persona-header">
        <h3>${pr.disabilityType}</h3>
        <span class="score" style="background: ${pGradeColor}33; color: ${pGradeColor}">
          Grade ${personaGrade}
        </span>
      </div>
      <p class="persona-name">${pr.persona}</p>
      <div class="persona-stats">
        <div class="stat">
          <span class="label">Goal</span>
          <span class="value">${pr.goalAchieved ? '✓ Achieved' : '✗ Failed'}</span>
        </div>
        <div class="stat">
          <span class="label">Barriers</span>
          <span class="value">${pr.barriers.length}</span>
        </div>
        <div class="stat">
          <span class="label">Critical</span>
          <span class="value">${pr.barriers.filter(b => b.severity === 'critical').length}</span>
        </div>
      </div>
      ${pr.frictionPoints.length > 0 ? `
        <div class="friction-points">
          <h4>Experience Issues</h4>
          <ul>
            ${pr.frictionPoints.map(fp => `
              <li>
                <strong>${fp.type}:</strong> ${fp.description}
                ${fp.accessibilityContext ? `<br><small>${fp.accessibilityContext}</small>` : ''}
              </li>
            `).join('')}
          </ul>
        </div>
      ` : ''}
      ${pr.finalEmotionalState ? generateEmotionVisualizationSection(pr.finalEmotionalState, pr.emotionalEvents, "Emotional State") : ''}
    </div>
  `;
  }).join('');

  const wcagList = result.allWcagViolations.map(v => {
    const criteria = WCAG_CRITERIA[v];
    return `<li><strong>${v}</strong> (Level ${criteria?.level || '?'}): ${criteria?.description || 'Unknown'}</li>`;
  }).join('');

  const remediationRows = result.combinedRemediation.slice(0, 10).map(rem => `
    <tr>
      <td>${rem.priority}</td>
      <td>${rem.issue}</td>
      <td>${rem.fix}</td>
      <td>${rem.wcagCriteria.join(', ')}</td>
      <td><span class="badge badge-${rem.effort}">${rem.effort}</span></td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Accessibility Empathy Audit - ${result.url}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 1400px;
      margin: 0 auto;
      padding: 2rem;
      background: #0f172a;
      color: #e2e8f0;
    }
    h1 {
      color: #f8fafc;
      border-bottom: 3px solid #8b5cf6;
      padding-bottom: 0.5rem;
    }
    h2 { color: #94a3b8; margin-top: 2rem; }
    .meta {
      background: #1e293b;
      padding: 1rem;
      border-radius: 8px;
      margin-bottom: 1rem;
    }
    .meta p { margin: 0.25rem 0; }
    .score-card {
      background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
      border-radius: 16px;
      padding: 2rem;
      text-align: center;
      margin: 2rem 0;
    }
    .score-value {
      font-size: 4rem;
      font-weight: bold;
      color: ${gradeColor};
    }
    .score-label {
      font-size: 1.25rem;
      color: #94a3b8;
    }
    .persona-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
      gap: 1rem;
      margin: 2rem 0;
    }
    .persona-card {
      background: #1e293b;
      border-radius: 8px;
      padding: 1rem;
      border-left: 4px solid #3b82f6;
    }
    .persona-card.success { border-left-color: #10b981; }
    .persona-card.failure { border-left-color: #ef4444; }
    .persona-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .persona-header h3 {
      margin: 0;
      color: #f8fafc;
    }
    .persona-header .score {
      padding: 0.25rem 0.75rem;
      border-radius: 4px;
      font-weight: bold;
    }
    .persona-name {
      color: #94a3b8;
      font-size: 0.875rem;
      margin: 0.5rem 0;
    }
    .persona-stats {
      display: flex;
      gap: 1rem;
      margin: 1rem 0;
    }
    .persona-stats .stat {
      flex: 1;
      text-align: center;
      background: #334155;
      padding: 0.5rem;
      border-radius: 4px;
    }
    .persona-stats .label {
      display: block;
      font-size: 0.75rem;
      color: #94a3b8;
    }
    .persona-stats .value {
      display: block;
      font-weight: bold;
    }
    .friction-points {
      margin-top: 1rem;
      padding-top: 1rem;
      border-top: 1px solid #334155;
    }
    .friction-points h4 {
      margin: 0 0 0.5rem 0;
      font-size: 0.875rem;
      color: #94a3b8;
    }
    .friction-points ul {
      margin: 0;
      padding-left: 1.25rem;
    }
    .friction-points li {
      margin: 0.5rem 0;
      font-size: 0.875rem;
    }
    .friction-points small {
      color: #94a3b8;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: #1e293b;
      border-radius: 8px;
      overflow: hidden;
      margin: 1rem 0;
    }
    th, td {
      padding: 0.75rem 1rem;
      text-align: left;
      border-bottom: 1px solid #334155;
    }
    th { background: #0f172a; color: #94a3b8; }
    .badge {
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
    }
    .badge-trivial { background: #16653433; color: #86efac; }
    .badge-easy { background: #1e3a8a33; color: #93c5fd; }
    .badge-medium { background: #78350f33; color: #fde047; }
    .badge-hard { background: #7f1d1d33; color: #fca5a5; }
    .wcag-list {
      background: #1e293b;
      padding: 1rem;
      border-radius: 8px;
    }
    .wcag-list ul {
      margin: 0;
      padding-left: 1.5rem;
    }
    .wcag-list li {
      margin: 0.5rem 0;
    }
    .disclaimer {
      background: #1e3a5f;
      border-left: 4px solid #8b5cf6;
      padding: 1rem;
      margin: 1rem 0;
      border-radius: 0 8px 8px 0;
    }
    .disclaimer h4 {
      margin: 0 0 0.5rem 0;
      color: #a78bfa;
    }
    .disclaimer p {
      margin: 0.25rem 0;
      font-size: 0.875rem;
      color: #94a3b8;
    }
    .footnote {
      font-size: 0.75rem;
      color: #64748b;
      text-align: center;
      margin-top: 1rem;
    }
    /* Emotion visualization styles (v13.1.0) */
    ${getEmotionVisualizationStyles()}
  </style>
</head>
<body>
  <h1>♿ Accessibility Empathy Audit</h1>

  <div class="disclaimer">
    <h4>⚠️ Important Methodology Note</h4>
    <p>Empathy grades are <strong>heuristic estimates</strong> based on barrier detection and persona simulation.*</p>
    <p>This is <strong>NOT a substitute</strong> for testing with actual users who have disabilities.</p>
    <p style="font-size: 0.75rem; margin-top: 0.5rem;">*Based on WCAG 2.1 criteria and cognitive science research. Combine with automated WCAG checkers (axe, WAVE) and user testing for comprehensive accessibility validation.</p>
  </div>

  <div class="meta">
    <p><strong>URL:</strong> ${result.url}</p>
    <p><strong>Goal:</strong> "${result.goal}"</p>
    <p><strong>Timestamp:</strong> ${result.timestamp}</p>
    <p><strong>Duration:</strong> ${(result.duration / 1000).toFixed(1)}s</p>
  </div>

  <div class="score-card">
    <div class="score-value" style="color: ${gradeColor}">${grade}</div>
    <div class="score-label">Overall Empathy Grade</div>
    <p style="color: #94a3b8; margin-top: 0.5rem; font-size: 0.875rem;">Based on ${result.results.length} disability persona simulations</p>
  </div>

  <h2>Results by Disability Type</h2>
  <div class="persona-grid">
    ${personaCards}
  </div>

  <h2>WCAG Violations (${result.allWcagViolations.length})</h2>
  <div class="wcag-list">
    <ul>
      ${wcagList}
    </ul>
  </div>

  <h2>Remediation Priorities</h2>
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Issue</th>
        <th>Fix</th>
        <th>WCAG</th>
        <th>Effort</th>
      </tr>
    </thead>
    <tbody>
      ${remediationRows}
    </tbody>
  </table>

  <div class="footnote">
    <p>* Methodology and research sources: <a href="docs/METHODOLOGY.md" style="color: #60a5fa;">docs/METHODOLOGY.md</a></p>
    <p>Key sources: WCAG 2.1, WebAIM Screen Reader Survey (2024), Baymard Institute</p>
    <p style="margin-top: 0.5rem;"><strong>Important:</strong> This is NOT a substitute for testing with actual users who have disabilities.</p>
  </div>

  <p style="color: #64748b; text-align: center; margin-top: 2rem;">
    Generated by CBrowser v8.0.0 - Accessibility Empathy Audit
  </p>
</body>
</html>`;
}

// ============================================================================
// Barrier Deduplication
// ============================================================================

/**
 * v11.11.0: Deduplicate barriers by TYPE only, aggregate affected elements (stress test fix)
 *
 * Previous approach grouped by element+type, but 10 small touch targets still showed as
 * 10 separate barriers. Now we group by TYPE only:
 * - 10 small touch targets → 1 barrier with affectedElements: ["button#1", "link#2", ...]
 * - All affected personas combined
 * - Highest severity kept
 */
function deduplicateBarriers(
  _allBarriers: AccessibilityBarrier[],
  results: AccessibilityEmpathyResult[]
): AccessibilityBarrier[] {
  // Group by barrier TYPE only (not element)
  const barriersByType = new Map<AccessibilityBarrierType, {
    barriers: AccessibilityBarrier[];
    personas: Set<string>;
    elements: Set<string>;
    highestSeverity: AccessibilityBarrierSeverity;
  }>();

  for (const result of results) {
    for (const barrier of result.barriers) {
      const existing = barriersByType.get(barrier.type);
      // Use the barrier's OWN affectedPersonas (set by the detector — accurate)
      // rather than the test persona's name. Previously we overwrote with
      // result.persona, which made every barrier appear to affect only the
      // tested persona. That breaks downstream filtering and reporting.
      const barrierPersonas = barrier.affectedPersonas ?? [];

      if (existing) {
        existing.barriers.push(barrier);
        for (const p of barrierPersonas) existing.personas.add(p);
        existing.elements.add(barrier.element);

        // Track highest severity
        const severityOrder = { critical: 3, major: 2, minor: 1 };
        if (severityOrder[barrier.severity] > severityOrder[existing.highestSeverity]) {
          existing.highestSeverity = barrier.severity;
        }
      } else {
        barriersByType.set(barrier.type, {
          barriers: [barrier],
          personas: new Set(barrierPersonas),
          elements: new Set([barrier.element]),
          highestSeverity: barrier.severity,
        });
      }
    }
  }

  // Create one deduplicated barrier per type
  const deduplicated: AccessibilityBarrier[] = [];

  for (const [type, data] of barriersByType) {
    const elementCount = data.elements.size;
    const representative = data.barriers[0]; // Use first barrier as template

    // Create aggregated description
    const elementList = Array.from(data.elements).slice(0, 5);
    const moreCount = elementCount > 5 ? ` (+${elementCount - 5} more)` : "";
    const aggregatedDescription = elementCount > 1
      ? `${representative.description.split(" - ")[0]} - affects ${elementCount} elements: ${elementList.join(", ")}${moreCount}`
      : representative.description;

    deduplicated.push({
      type,
      element: elementCount > 1 ? `${elementCount} elements` : representative.element,
      description: aggregatedDescription,
      affectedPersonas: Array.from(data.personas),
      wcagCriteria: representative.wcagCriteria,
      // This is the WORST severity across every element grouped under this
      // barrier type, not one element's severity — but it shipped under the same
      // field name `severity` that individual rects use, so the same 152x20
      // target read "major" in barrierRects and "critical" in topBarriers and
      // looked like a contradiction. Both numbers were right; only the naming
      // hid that one is an aggregate. (2026-07-29)
      severity: data.highestSeverity,
      severityIsGroupMax: true,
      affectedElementCount: data.elements.size,
      remediation: representative.remediation,
    });
  }

  return deduplicated;
}

// ============================================================================
// Main Empathy Audit Function
// ============================================================================

export async function runEmpathyAudit(
  url: string,
  options: EmpathyAuditOptions
): Promise<EmpathyAuditResult> {
  const {
    goal,
    disabilities,
    wcagLevel = "AA",
    maxSteps = 20,
    maxTime = 120,
    headless = true,
  } = options;

  const startTime = Date.now();
  const results: AccessibilityEmpathyResult[] = [];
  const allWcagViolations = new Set<string>();
  const allBarriers: AccessibilityBarrier[] = [];

  // Map disability names to personas
  // v14.2.5: Added elderly-user mapping (issue #190 - persona dropout)
  const personaMap: Record<string, string> = {
    "motor-tremor": "motor-impairment-tremor",
    "motor": "motor-impairment-tremor",
    "tremor": "motor-impairment-tremor",
    "low-vision": "low-vision-magnified",
    "vision": "low-vision-magnified",
    "magnified": "low-vision-magnified",
    "adhd": "cognitive-adhd",
    "cognitive": "cognitive-adhd",
    "attention": "cognitive-adhd",
    "dyslexia": "dyslexic-user",
    "dyslexic": "dyslexic-user",
    "reading": "dyslexic-user",
    "deaf": "deaf-user",
    "hearing": "deaf-user",
    "elderly": "elderly-low-vision",
    "elderly-user": "elderly-low-vision",  // v14.2.5: Added missing mapping
    "elderly-low-vision": "elderly-low-vision",
    "senior": "elderly-low-vision",
    "old": "elderly-low-vision",  // v14.2.5: Additional synonym
    "color-blind": "color-blind-deuteranopia",
    "colorblind": "color-blind-deuteranopia",
    "deuteranopia": "color-blind-deuteranopia",
    // v18.35.0: New research-backed cognitive disability personas
    "autism": "autism-spectrum",
    "autistic": "autism-spectrum",
    "asd": "autism-spectrum",
    "autism-spectrum": "autism-spectrum",
    "intellectual-disability": "intellectual-disability",
    "intellectual": "intellectual-disability",
    "learning-disability": "intellectual-disability",
    "aphasia": "aphasia-receptive",
    "aphasia-receptive": "aphasia-receptive",
    "wernicke": "aphasia-receptive",
    "dyscalculia": "dyscalculia",
    "numeracy": "dyscalculia",
  };

  // Run audit for each disability type
  // v18.35.0: Accept any persona — wrap non-disability personas with default accessibility traits
  for (const disability of disabilities) {
    const personaName = personaMap[disability.toLowerCase()] || disability;
    let persona = getAccessibilityPersona(personaName);
    let isDisabilityPersona = !!persona;

    if (!persona) {
      // Try to find as a regular cognitive persona and wrap it
      const { getAnyPersona, createCognitivePersona } = await import("../personas.js");
      let cognitivePersona = getAnyPersona(personaName);

      // CMS custom persona fallback — fetch from API if not found locally
      if (!cognitivePersona) {
        try {
          const { getSessionApiKey } = await import("../mcp-tools/base/cognitive-tools.js");
          const apiKey = getSessionApiKey();
          if (apiKey) {
            const cmsUrl = process.env.CMS_URL || "http://localhost:3200";
            const res = await fetch(`${cmsUrl}/api/personas`, {
              headers: { "Authorization": `Bearer ${apiKey}` },
            });
            if (res.ok) {
              const data = await res.json() as { personas: Array<{ name: string; slug?: string; traits: Record<string, number>; accessibility_traits?: Record<string, unknown>; age_range?: string }> };
              const cmsMatch = data.personas.find(
                (p: { name: string; slug?: string }) =>
                  p.name.toLowerCase() === personaName.toLowerCase() ||
                  p.name.toLowerCase().replace(/\s+/g, '-') === personaName.toLowerCase() ||
                  p.name.toLowerCase().replace(/\s+/g, '_') === personaName.toLowerCase() ||
                  (p.slug && p.slug.toLowerCase() === personaName.toLowerCase())
              );
              if (cmsMatch) {
                const parsedTraits = typeof cmsMatch.traits === "string" ? JSON.parse(cmsMatch.traits) : cmsMatch.traits;
                cognitivePersona = createCognitivePersona(cmsMatch.name, cmsMatch.name, parsedTraits, {
                  ageRange: cmsMatch.age_range || undefined,
                });
                // Attach CMS accessibility traits if stored
                if (cmsMatch.accessibility_traits) {
                  const at = typeof cmsMatch.accessibility_traits === "string" ? JSON.parse(cmsMatch.accessibility_traits) : cmsMatch.accessibility_traits;
                  (cognitivePersona as any).accessibilityTraits = at;
                }
                console.log(`[empathy_audit] Found custom CMS persona: "${cmsMatch.name}" with ${Object.keys(parsedTraits).length} traits${cmsMatch.accessibility_traits ? ' + disability modeling' : ''}`);
              }
            }
          }
        } catch (e) {
          console.debug(`[empathy_audit] CMS persona lookup failed: ${(e as Error).message}`);
        }
      }

      if (cognitivePersona) {
        // Wrap cognitive persona as accessibility persona, inferring traits from name + cognitive traits
        const ct = (cognitivePersona as any).cognitiveTraits || {};
        const name = personaName.toLowerCase();
        const hasVisionHint = name.includes("vision") || name.includes("blind") || name.includes("elderly") || name.includes("magnif");
        const hasMotorHint = name.includes("motor") || name.includes("tremor") || name.includes("parkinsons");
        const hasCognitiveHint = name.includes("adhd") || name.includes("dyslexic") || name.includes("cognitive") || name.includes("memory");

        persona = {
          ...cognitivePersona,
          accessibilityTraits: {
            motorControl: hasMotorHint ? 0.3 : ct.motorControl ?? 1.0,
            tremor: hasMotorHint,
            reachability: hasMotorHint ? 0.4 : 1.0,
            visionLevel: hasVisionHint ? 0.4 : ct.visionLevel ?? 1.0,
            contrastSensitivity: hasVisionHint ? 0.5 : ct.contrastSensitivity ?? 1.0,
            processingSpeed: ct.comprehension ?? (hasCognitiveHint ? 0.4 : 0.8),
            attentionSpan: ct.patience ?? (hasCognitiveHint ? 0.3 : 0.7),
            fatigueSusceptibility: hasVisionHint || hasMotorHint ? 0.7 : 0.3,
          },
        } as any;
        // If the name hints at a disability, treat it as a disability persona for routing
        isDisabilityPersona = hasVisionHint || hasMotorHint || hasCognitiveHint;
        console.log(`[empathy_audit] "${disability}" wrapped as ${isDisabilityPersona ? "disability" : "general"} persona (vision=${hasVisionHint}, motor=${hasMotorHint}, cognitive=${hasCognitiveHint})`);
      } else {
        // Return an explicit error instead of silently skipping
        console.error(`[empathy_audit] Persona "${disability}" not found in any registry (built-in, custom, CMS)`);
        results.push({
          persona: personaName,
          disabilityType: disability,
          goalAchieved: false,
          empathyScore: 0,
          barriers: [],
          wcagViolations: [],
          journey: [],
          screenshotPath: null,
          error: `Persona "${disability}" not found. Use list_cognitive_personas to see available personas, or create one with persona_create_from_description.`,
        } as any);
        continue;
      }
    }

    // TypeScript guard — persona is guaranteed non-null after continue above
    const resolvedPersona = persona!;

    // Use externally provided page or launch a new browser
    const externalPage = options.page;
    let browser: CBrowser | null = null;
    try {
      let page: import("playwright").Page;
      if (externalPage) {
        page = externalPage;
      } else {
        browser = new CBrowser({
          headless,
          persistent: false,
          ...(options.device ? { device: options.device.toLowerCase() } : {}),
        });
        await browser.launch();
        page = await browser.getPage();
      }

      const auditScope = options.scope || "viewport";
      const result = await simulateAccessibilityJourney(
        page as any,
        url,
        goal,
        resolvedPersona,
        auditScope,
        maxSteps,
        maxTime,
        wcagLevel
      );

      // v18.28.0: Run attention analysis FIRST so we can pass page-specific data to perceptual transport
      let attentionData: { entropy: number; concentration: number; transportCost: number } | undefined;
      try {
        const { join: joinAttn } = await import("path");
        const { tmpdir: tmpdirAttn } = await import("os");
        const { unlinkSync: ulAttn } = await import("fs");
        const attnScreenshot = joinAttn(tmpdirAttn(), `empathy-attn-${Date.now()}.png`);
        await page.screenshot({ path: attnScreenshot, fullPage: false });

        const attnAnalysis = await analyzeAttention(attnScreenshot, personaName, 16);
        attentionData = {
          entropy: attnAnalysis.entropy,
          concentration: attnAnalysis.concentration,
          transportCost: attnAnalysis.transportCost,
        };
        (result as any).attentionAnalysis = {
          alignmentScore: attnAnalysis.alignmentScore,
          entropy: attnAnalysis.entropy,
          concentration: attnAnalysis.concentration,
          transportCost: attnAnalysis.transportCost,
          topAttentionAreas: attnAnalysis.attentionCompetitors,
          computeTimeMs: Math.round(attnAnalysis.computeTimeMs),
        };

        try { ulAttn(attnScreenshot); } catch {}
      } catch (e) {
        console.debug(`[empathy_audit] Attention analysis failed: ${(e as Error).message}`);
      }

      // v18.26.0: Screenshot-based perceptual transport analysis
      // Now receives attention data for page-specific differentiation
      try {
        const { join } = await import("path");
        const { tmpdir } = await import("os");
        const { unlinkSync } = await import("fs");
        const screenshotPath = join(tmpdir(), `empathy-screenshot-${Date.now()}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });

        const perceptualAnalysis = await analyzePerceptualTransport(screenshotPath, personaName, attentionData, (resolvedPersona as any).accessibilityTraits);

        // Attach perceptual metrics to the result
        (result as any).perceptualTransport = {
          informationLoss: perceptualAnalysis.informationLoss,
          attentionMismatch: perceptualAnalysis.attentionMismatch,
          motorCost: perceptualAnalysis.motorCost,
          cognitiveLoad: perceptualAnalysis.cognitiveLoad,
          perceptualScore: perceptualAnalysis.perceptualScore,
          transportDistance: perceptualAnalysis.transportDistance,
          computeTimeMs: perceptualAnalysis.computeTimeMs,
        };

        // Blend perceptual score into empathy score (30% perceptual, 70% barrier-based)
        const blendedScore = Math.round(
          result.empathyScore * 0.7 + perceptualAnalysis.perceptualScore * 0.3
        );
        (result as any).empathyScoreBarrierOnly = result.empathyScore;
        result.empathyScore = blendedScore;

        // scoreContext.explanation was built for the pre-blend score and then
        // left attached to the blended one, so its deductions summed to
        // empathyScoreBarrierOnly while sitting beside a different headline
        // (observed: deductions of 11 explaining 89, printed next to
        // empathyScore 91). Record the blend so the arithmetic reconciles
        // end to end, and say which number the deductions explain. (2026-07-28)
        const ctxToUpdate = (result as any).scoreContext;
        if (ctxToUpdate) {
          ctxToUpdate.explainsScore = "empathyScoreBarrierOnly";
          ctxToUpdate.barrierOnlyScore = (result as any).empathyScoreBarrierOnly;
          ctxToUpdate.perceptualScore = perceptualAnalysis.perceptualScore;
          ctxToUpdate.blendWeights = { barrier: 0.7, perceptual: 0.3 };
          ctxToUpdate.finalScore = blendedScore;
          ctxToUpdate.explanation =
            `${ctxToUpdate.explanation} || Headline empathyScore ${blendedScore} = ` +
            `barrier-only ${(result as any).empathyScoreBarrierOnly} x 0.7 + ` +
            `perceptual ${perceptualAnalysis.perceptualScore} x 0.3. ` +
            `The deductions above explain the barrier-only score, not the headline.`;
        }

        try { unlinkSync(screenshotPath); } catch {}
      } catch (e) {
        // Perceptual analysis is optional — don't fail the audit if it errors
        console.debug(`[empathy_audit] Perceptual transport analysis failed: ${(e as Error).message}`);
      }

      // v18.27.0: Cognitive load estimation via optimal transport
      try {
        const pageMetrics = await extractPageMetrics(page);
        const otProfile = buildOTCognitiveProfile(personaName, resolvedPersona.cognitiveTraits as unknown as Record<string, number> || {});
        const cogLoad = estimateCognitiveLoad(otProfile, pageMetrics);

        // Three separate models each produce a number called "cognitive load",
        // and all three ship in the same response with nothing to distinguish
        // them: one example.com audit returned 70%, 34% and 4% for the same
        // persona on the same page. They are not redundant — they measure
        // different things — so name them and their sources rather than picking
        // an arbitrary winner. (2026-07-28)
        (result as any).cognitiveLoadReadings = {
          note: "Three models, three scales. These are not expected to agree; use the one matching your question.",
          visualComplexity: {
            value: (result as any).scoreContext?.visualComplexityCognitiveLoad,
            source: "computePerceptualScore",
            measures: "visual complexity vs the persona's noise tolerance; this is the figure that deducts from the empathy score",
          },
          perceptualTransport: {
            value: (result as any).perceptualTransport?.cognitiveLoad,
            source: "computePerceptualAnalysis (screenshot Wasserstein)",
            measures: "how much visual information this persona loses versus a typical viewer",
          },
          opticalTransport: {
            value: Math.round(cogLoad.totalLoad * 100) / 100,
            source: "estimateCognitiveLoad (optimal transport over page metrics)",
            measures: "modelled working-memory demand of the page for this persona's traits",
          },
        };

        (result as any).cognitiveLoad = {
          totalLoad: Math.round(cogLoad.totalLoad * 100) / 100,
          overloaded: cogLoad.overloaded,
          bottleneck: cogLoad.bottleneck,
          breakdown: Object.fromEntries(
            Object.entries(cogLoad.breakdown).map(([k, v]) => [k, Math.round(v * 100) / 100])
          ),
          pageMetrics: {
            informationDensity: Math.round(pageMetrics.informationDensity * 100) / 100,
            visualComplexity: Math.round(pageMetrics.visualComplexity * 100) / 100,
            interactiveElements: pageMetrics.interactiveElementCount,
            animationLevel: Math.round(pageMetrics.animationLevel * 100) / 100,
            choiceCount: pageMetrics.choiceCount,
          },
        };
      } catch (e) {
        console.debug(`[empathy_audit] Cognitive load estimation failed: ${(e as Error).message}`);
      }

      // v18.28.0: Attention analysis already ran above (before perceptual transport)

      // v18.35.0: Flag non-disability personas
      if (!isDisabilityPersona) {
        (result as any).isDisabilityPersona = false;
        // getDisabilityType() derives labels like "Cognitive (ADHD/Memory)" from
        // trait thresholds alone (workingMemory < 0.5), so a wrapped general
        // persona such as first-timer (workingMemory 0.4) was reported as having
        // a disability while this very flag said it did not. Overwrite only an
        // actual disability label: personas already carrying a general one keep
        // their existing wording, so report text does not churn for cases that
        // were already correct. Kept a string rather than null because types.ts
        // declares disabilityType: string and formatEmpathyAuditReport() reads
        // .length on it. (2026-07-28)
        const stamped = (result as any).disabilityType;
        if (typeof stamped === "string" && !/^general\b/i.test(stamped)) {
          (result as any).disabilityType = "General UX (not a disability persona)";
        }
        (result as any).personaNote = `"${disability}" is not a disability persona. Barriers shown are general UX issues, not disability-specific. For disability testing, use: motor-impairment-tremor, low-vision-magnified, cognitive-adhd, dyslexic-user, deaf-user, elderly-low-vision, color-blind-deuteranopia.`;
      }

      results.push(result);

      // Collect WCAG violations and barriers
      for (const v of result.wcagViolations) {
        allWcagViolations.add(v);
      }
      allBarriers.push(...result.barriers);

    } finally {
      // Don't close browser if page was externally provided
      if (browser && !externalPage) {
        await browser.close();
      }
    }
  }

  // Filter WCAG violations by level
  const levelOrder: Record<string, number> = { A: 1, AA: 2, AAA: 3 };
  const maxLevel = levelOrder[wcagLevel];
  const filteredViolations = Array.from(allWcagViolations).filter(v => {
    const criteria = WCAG_CRITERIA[v];
    return !criteria || levelOrder[criteria.level] <= maxLevel;
  });

  // v11.10.0: Deduplicate barriers by element+type, list affected personas (issue #86)
  const deduplicatedBarriers = deduplicateBarriers(allBarriers, results);

  // Generate combined remediation from deduplicated barriers
  const combinedRemediation = generateRemediationPriority(deduplicatedBarriers);

  // Calculate overall score
  const overallScore = results.length > 0
    ? Math.round(results.reduce((sum, r) => sum + r.empathyScore, 0) / results.length)
    : 0;

  return {
    url,
    goal,
    timestamp: new Date().toISOString(),
    results,
    allWcagViolations: filteredViolations,
    allBarriers,
    topBarriers: deduplicatedBarriers, // v11.11.0: Deduplicated barriers grouped by type
    combinedRemediation,
    overallScore,
    duration: Date.now() - startTime,
  };
}
