/**
 * CBrowser - Page Understanding Engine
 * Real-time page understanding via accessibility tree + DOM analysis.
 * Produces rich page models: type classification, affordances, structure, relationships.
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 * @since v18.35.0
 */

import type { Page } from "playwright-core";

// ============================================================================
// Type Definitions
// ============================================================================

export type PageType = "landing" | "form" | "dashboard" | "article" | "search" | "checkout" | "error" | "settings" | "list";

export interface Affordance {
  element: string;
  elementText: string;
  action: "click" | "fill" | "select" | "scroll" | "submit" | "toggle";
  expectedOutcome: string;
  confidence: number;
  reversible: boolean;
  ariaRole?: string;
}

export interface ElementGroup {
  label: string;
  elements: Array<{ selector: string; text: string; role?: string }>;
}

export interface FormGroup {
  label: string;
  action?: string;
  method?: string;
  fields: Array<{ selector: string; type: string; name: string; label?: string; required: boolean }>;
  submitButton?: { selector: string; text: string };
}

export interface CTAElement {
  selector: string;
  text: string;
  prominence: "primary" | "secondary" | "tertiary";
  type: "link" | "button";
}

export interface HeadingNode {
  level: number;
  text: string;
  selector: string;
  children: HeadingNode[];
}

export interface PageStructure {
  navigation: ElementGroup[];
  mainContent: ElementGroup[];
  forms: FormGroup[];
  ctas: CTAElement[];
  headingHierarchy: HeadingNode[];
}

export interface ElementRelationship {
  elementA: string;
  elementB: string;
  type: "contains" | "adjacent" | "same-group" | "same-form" | "linked";
}

export interface PageUnderstanding {
  url: string;
  type: PageType;
  affordances: Affordance[];
  structure: PageStructure;
  relationships: ElementRelationship[];
  computedAt: number;
  computeTimeMs: number;
}

export interface PageSkeleton {
  url: string;
  type: PageType;
  elementCount: number;
  formCount: number;
  linkCount: number;
  headingCount: number;
  navLandmarks: number;
  contentHash: string;
}

// ============================================================================
// Raw DOM extraction types (internal, returned from page.evaluate)
// ============================================================================

interface RawInteractiveElement {
  tag: string;
  type: string;
  text: string;
  href: string;
  name: string;
  id: string;
  className: string;
  role: string;
  ariaLabel: string;
  disabled: boolean;
  rect: { top: number; left: number; width: number; height: number };
  formIndex: number;
  nthOfType: number;
}

interface RawHeading {
  level: number;
  text: string;
  id: string;
  nthOfType: number;
}

interface RawFormData {
  action: string;
  method: string;
  id: string;
  className: string;
  fields: Array<{
    tag: string;
    type: string;
    name: string;
    id: string;
    labelText: string;
    required: boolean;
    nthOfType: number;
  }>;
  submitButton: { tag: string; text: string; id: string; className: string; nthOfType: number } | null;
}

interface RawNavData {
  ariaLabel: string;
  id: string;
  className: string;
  links: Array<{ text: string; href: string; id: string; className: string; nthOfType: number }>;
  nthOfType: number;
}

interface RawRegion {
  tag: string;
  role: string;
  ariaLabel: string;
  id: string;
  className: string;
  nthOfType: number;
  childCount: number;
  /** Most children share one tag — looks like a result/feed list, not distinct sections. */
  repeatedChildTag?: boolean;
}

interface RawDOMExtraction {
  interactiveElements: RawInteractiveElement[];
  headings: RawHeading[];
  forms: RawFormData[];
  navs: RawNavData[];
  regions: RawRegion[];
  totalElementCount: number;
  title: string;
  viewportHeight: number;
}

interface RawSkeletonData {
  elementCount: number;
  formCount: number;
  linkCount: number;
  headingCount: number;
  navLandmarks: number;
  headingTexts: string[];
  title: string;
  hasSearchInput: boolean;
  inputCount: number;
  hasSubmitButton: boolean;
  hasSidebar: boolean;
  hasHero: boolean;
  longTextBlocks: number;
  repeatedStructures: number;
  hasErrorIndicator: boolean;
  hasPaymentKeywords: boolean;
  hasSettingsKeywords: boolean;
}

// ============================================================================
// Constants
// ============================================================================

const CACHE_TTL_MS = 30_000;
const MAX_ELEMENTS_FULL_SCAN = 1000;
const MAX_RELATIONSHIPS = 100;
const MAX_TEXT_LENGTH = 80;

// ============================================================================
// PageUnderstandingEngine
// ============================================================================

export class PageUnderstandingEngine {
  private cache: Map<string, { understanding: PageUnderstanding; contentHash: string; timestamp: number }>;

  constructor() {
    this.cache = new Map();
  }

  /**
   * Full page understanding (lazy, cached).
   * Extracts all interactive elements, headings, forms, nav landmarks, and semantic regions
   * in a single DOM traversal, then classifies, structures, and relates them.
   */
  async analyze(page: Page): Promise<PageUnderstanding> {
    const url = page.url();
    const start = Date.now();

    // Check cache: valid if not expired and content hash matches
    const cached = this.cache.get(url);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      const currentHash = await this.computeContentHash(page);
      if (currentHash === cached.contentHash) {
        return cached.understanding;
      }
    }

    const raw = await this.extractDOM(page);
    const type = classifyPageType(raw, url);
    const affordances = computeAffordances(raw, url);
    const structure = buildStructure(raw);
    const relationships = computeRelationships(raw, structure);

    const computeTimeMs = Date.now() - start;

    const understanding: PageUnderstanding = {
      url,
      type,
      affordances,
      structure,
      relationships,
      computedAt: Date.now(),
      computeTimeMs,
    };

    // Cache with content hash
    const contentHash = await this.computeContentHash(page);
    this.cache.set(url, { understanding, contentHash, timestamp: Date.now() });

    return understanding;
  }

  /**
   * Lightweight skeleton (cheap, can be called more often).
   * Counts elements, forms, links, headings, and nav landmarks in a single evaluate.
   * Must complete in <50ms.
   */
  async skeleton(page: Page): Promise<PageSkeleton> {
    const url = page.url();

    const data = await page.evaluate(() => {
      const allElements = document.querySelectorAll("*");
      const forms = document.querySelectorAll("form");
      const links = document.querySelectorAll("a[href]");
      const headings = document.querySelectorAll("h1, h2, h3, h4, h5, h6");
      const navs = document.querySelectorAll('nav, [role="navigation"]');
      const inputs = document.querySelectorAll("input, textarea, select");
      const submitBtns = document.querySelectorAll('button[type="submit"], input[type="submit"]');

      const headingTexts: string[] = [];
      headings.forEach((h) => {
        const text = (h.textContent || "").trim().slice(0, 80);
        if (text) headingTexts.push(text);
      });

      const title = document.title || "";

      // Search input detection
      const hasSearchInput = !!document.querySelector(
        'input[type="search"], input[name*="search" i], input[name*="query" i], input[name*="q" i][type="text"], input[aria-label*="search" i], [role="search"] input'
      );

      // Sidebar detection (aside, or nav-heavy sidebar patterns)
      const asides = document.querySelectorAll("aside, [role='complementary']");
      const hasSidebar = asides.length > 0;

      // Hero detection (large first section with CTA-like buttons)
      const firstSection = document.querySelector("main > section:first-child, body > section:first-child, .hero, [class*='hero' i]");
      const hasHero = !!firstSection;

      // Long text blocks (paragraphs with >200 chars)
      let longTextBlocks = 0;
      document.querySelectorAll("p").forEach((p) => {
        if ((p.textContent || "").trim().length > 200) longTextBlocks++;
      });

      // Repeated structures (3+ similar sibling elements)
      let repeatedStructures = 0;
      document.querySelectorAll("ul, ol, [role='list'], main, [role='main']").forEach((container) => {
        const children = container.children;
        if (children.length >= 3) {
          const firstTag = children[0]?.tagName;
          let similar = 0;
          for (let i = 1; i < Math.min(children.length, 10); i++) {
            if (children[i]?.tagName === firstTag) similar++;
          }
          if (similar >= 2) repeatedStructures++;
        }
      });

      // Error indicators
      const titleLower = title.toLowerCase();
      const hasErrorIndicator =
        titleLower.includes("404") ||
        titleLower.includes("not found") ||
        titleLower.includes("error") ||
        !!document.querySelector("h1")?.textContent?.toLowerCase().match(/(?:404|not found|error|page not found|oops)/);

      // Payment keywords in forms
      let hasPaymentKeywords = false;
      forms.forEach((form) => {
        const formText = (form.textContent || "").toLowerCase();
        if (
          formText.includes("payment") ||
          formText.includes("credit card") ||
          formText.includes("billing") ||
          formText.includes("card number") ||
          formText.includes("cvv") ||
          formText.includes("expir")
        ) {
          hasPaymentKeywords = true;
        }
      });

      // Settings keywords
      const h1Text = (document.querySelector("h1")?.textContent || "").toLowerCase();
      const hasSettingsKeywords =
        h1Text.includes("settings") ||
        h1Text.includes("preferences") ||
        h1Text.includes("configuration") ||
        titleLower.includes("settings") ||
        titleLower.includes("preferences");

      return {
        elementCount: allElements.length,
        formCount: forms.length,
        linkCount: links.length,
        headingCount: headings.length,
        navLandmarks: navs.length,
        headingTexts,
        title,
        hasSearchInput,
        inputCount: inputs.length,
        hasSubmitButton: submitBtns.length > 0,
        hasSidebar,
        hasHero,
        longTextBlocks,
        repeatedStructures,
        hasErrorIndicator,
        hasPaymentKeywords,
        hasSettingsKeywords,
      };
    });

    const contentHash = computeHashFromSkeleton(data);
    const type = classifyPageTypeFromSkeleton(data);

    return {
      url,
      type,
      elementCount: data.elementCount,
      formCount: data.formCount,
      linkCount: data.linkCount,
      headingCount: data.headingCount,
      navLandmarks: data.navLandmarks,
      contentHash,
    };
  }

  /** Invalidate cache for a specific URL. */
  invalidate(url: string): void {
    this.cache.delete(url);
  }

  /** Invalidate all cached entries. */
  invalidateAll(): void {
    this.cache.clear();
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Compute a lightweight content hash for cache invalidation.
   * Uses element counts + heading texts so it's cheap but detects meaningful changes.
   */
  private async computeContentHash(page: Page): Promise<string> {
    const data = await page.evaluate(() => {
      const headings = document.querySelectorAll("h1, h2, h3, h4, h5, h6");
      const headingTexts: string[] = [];
      headings.forEach((h) => {
        const text = (h.textContent || "").trim().slice(0, 40);
        if (text) headingTexts.push(text);
      });

      return {
        elementCount: document.querySelectorAll("*").length,
        formCount: document.querySelectorAll("form").length,
        linkCount: document.querySelectorAll("a[href]").length,
        headingTexts,
      };
    });

    // Simple hash: concatenate counts and heading texts
    const raw = `${data.elementCount}:${data.formCount}:${data.linkCount}:${data.headingTexts.join("|")}`;
    return simpleHash(raw);
  }

  /**
   * Single page.evaluate() that extracts everything in one DOM traversal.
   * For pages with >1000 elements, restricts extraction to visible viewport + nav elements.
   */
  private async extractDOM(page: Page): Promise<RawDOMExtraction> {
    const raw = await page.evaluate((maxElements: number) => {
      const totalElementCount = document.querySelectorAll("*").length;
      const viewportHeight = window.innerHeight;
      const limitToViewport = totalElementCount > maxElements;

      function isInViewport(el: Element): boolean {
        if (!limitToViewport) return true;
        const rect = el.getBoundingClientRect();
        // Include elements in viewport OR in nav/header/footer (always important)
        if (rect.top < viewportHeight * 1.5 && rect.bottom > -100) return true;
        const tag = el.tagName.toLowerCase();
        if (tag === "nav" || tag === "header" || tag === "footer") return true;
        const role = el.getAttribute("role") || "";
        if (role === "navigation" || role === "banner" || role === "contentinfo") return true;
        return false;
      }

      function getVisibleText(el: Element): string {
        return (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
      }

      function getNthOfType(el: Element): number {
        const tag = el.tagName;
        let nth = 1;
        let sibling = el.previousElementSibling;
        while (sibling) {
          if (sibling.tagName === tag) nth++;
          sibling = sibling.previousElementSibling;
        }
        return nth;
      }

      // -- Interactive elements --
      const interactiveSelectors = "a[href], button, input, textarea, select, [role='button'], [role='link'], [role='checkbox'], [role='radio'], [role='switch'], [role='tab'], [role='menuitem'], [tabindex]";
      const interactiveEls = document.querySelectorAll(interactiveSelectors);
      const interactiveElements: RawInteractiveElement[] = [];

      // Build a form-index map
      const allForms = document.querySelectorAll("form");
      const formMap = new Map<Element, number>();
      allForms.forEach((form, index) => formMap.set(form, index));

      interactiveEls.forEach((el) => {
        if (!isInViewport(el)) return;
        const rect = el.getBoundingClientRect();
        // Skip zero-size hidden elements
        if (rect.width === 0 && rect.height === 0 && !(el as HTMLInputElement).type?.match(/hidden/i)) return;

        const tag = el.tagName.toLowerCase();
        const inputEl = el as HTMLInputElement;

        // Find enclosing form
        let formIndex = -1;
        let parent = el.parentElement;
        while (parent) {
          if (parent.tagName === "FORM" && formMap.has(parent)) {
            formIndex = formMap.get(parent)!;
            break;
          }
          parent = parent.parentElement;
        }

        interactiveElements.push({
          tag,
          type: inputEl.type || "",
          text: getVisibleText(el),
          href: (el as HTMLAnchorElement).href || "",
          name: inputEl.name || "",
          id: el.id || "",
          className: el.className?.toString()?.slice(0, 120) || "",
          role: el.getAttribute("role") || "",
          ariaLabel: el.getAttribute("aria-label") || "",
          disabled: inputEl.disabled || el.getAttribute("aria-disabled") === "true",
          rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
          formIndex,
          nthOfType: getNthOfType(el),
        });
      });

      // -- Headings --
      const headingEls = document.querySelectorAll("h1, h2, h3, h4, h5, h6");
      const headings: RawHeading[] = [];
      headingEls.forEach((el) => {
        if (!isInViewport(el)) return;
        const level = parseInt(el.tagName.charAt(1), 10);
        headings.push({
          level,
          text: getVisibleText(el),
          id: el.id || "",
          nthOfType: getNthOfType(el),
        });
      });

      // -- Forms --
      const forms: RawFormData[] = [];
      allForms.forEach((form) => {
        if (!isInViewport(form)) return;
        const fields: RawFormData["fields"] = [];
        form.querySelectorAll("input, textarea, select").forEach((field) => {
          const inputField = field as HTMLInputElement;
          const type = inputField.type || field.tagName.toLowerCase();
          // Skip hidden inputs from field list (they aren't user-interactable)
          if (type === "hidden") return;

          // Find associated label
          let labelText = "";
          if (field.id) {
            const labelEl = document.querySelector(`label[for="${field.id}"]`);
            if (labelEl) labelText = getVisibleText(labelEl);
          }
          if (!labelText) {
            // Check for wrapping label
            const parentLabel = field.closest("label");
            if (parentLabel) {
              // Get label text excluding the input's own text
              labelText = getVisibleText(parentLabel);
            }
          }
          if (!labelText) {
            labelText = field.getAttribute("aria-label") || field.getAttribute("placeholder") || "";
          }

          fields.push({
            tag: field.tagName.toLowerCase(),
            type,
            name: inputField.name || "",
            id: field.id || "",
            labelText: labelText.slice(0, 80),
            required: inputField.required || field.getAttribute("aria-required") === "true",
            nthOfType: getNthOfType(field),
          });
        });

        // Find submit button
        let submitButton: RawFormData["submitButton"] = null;
        const submitEl =
          form.querySelector('button[type="submit"], input[type="submit"]') ||
          form.querySelector("button:not([type])");  // Default button type is submit
        if (submitEl) {
          submitButton = {
            tag: submitEl.tagName.toLowerCase(),
            text: getVisibleText(submitEl) || (submitEl as HTMLInputElement).value || "Submit",
            id: submitEl.id || "",
            className: submitEl.className?.toString()?.slice(0, 120) || "",
            nthOfType: getNthOfType(submitEl),
          };
        }

        forms.push({
          action: (form as HTMLFormElement).action || "",
          method: ((form as HTMLFormElement).method || "GET").toUpperCase(),
          id: form.id || "",
          className: form.className?.toString()?.slice(0, 120) || "",
          fields,
          submitButton,
        });
      });

      // -- Nav landmarks --
      const navEls = document.querySelectorAll('nav, [role="navigation"]');
      const navs: RawNavData[] = [];
      navEls.forEach((nav) => {
        if (!isInViewport(nav)) return;
        const links: RawNavData["links"] = [];
        nav.querySelectorAll("a[href]").forEach((a) => {
          links.push({
            text: getVisibleText(a),
            href: (a as HTMLAnchorElement).href || "",
            id: a.id || "",
            className: a.className?.toString()?.slice(0, 120) || "",
            nthOfType: getNthOfType(a),
          });
        });

        navs.push({
          ariaLabel: nav.getAttribute("aria-label") || "",
          id: nav.id || "",
          className: nav.className?.toString()?.slice(0, 120) || "",
          links,
          nthOfType: getNthOfType(nav),
        });
      });

      // -- Semantic regions --
      const regionEls = document.querySelectorAll('main, aside, footer, header, section, [role="main"], [role="complementary"], [role="contentinfo"], [role="banner"], [role="region"]');
      const regions: RawRegion[] = [];
      regionEls.forEach((el) => {
        if (!isInViewport(el)) return;
        regions.push({
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || "",
          ariaLabel: el.getAttribute("aria-label") || "",
          id: el.id || "",
          className: el.className?.toString()?.slice(0, 120) || "",
          nthOfType: getNthOfType(el),
          childCount: el.children.length,
          // True when most children share one tag, i.e. this region looks like a
          // list of like items (search results, a feed) rather than a set of
          // distinct page sections. Used to tell a results page from a landing
          // page that merely has a search box. (2026-07-29)
          repeatedChildTag: (() => {
            const kids = Array.from(el.children);
            if (kids.length < 5) return false;
            const counts = new Map();
            for (const k of kids) {
              const t = k.tagName.toLowerCase();
              counts.set(t, (counts.get(t) || 0) + 1);
            }
            const top = Math.max(...counts.values());
            return top / kids.length >= 0.7;
          })(),
        });
      });

      return {
        interactiveElements,
        headings,
        forms,
        navs,
        regions,
        totalElementCount,
        title: document.title || "",
        viewportHeight,
      };
    }, MAX_ELEMENTS_FULL_SCAN);

    return raw;
  }
}

// ============================================================================
// Page type classification
// ============================================================================

function classifyPageType(raw: RawDOMExtraction, pageUrl?: string): PageType {
  const { interactiveElements, headings, forms, navs, regions, title } = raw;
  const titleLower = title.toLowerCase();

  // Error page: title or h1 contains error keywords
  const h1 = headings.find((h) => h.level === 1);
  const h1Text = (h1?.text || "").toLowerCase();
  if (
    titleLower.match(/\b(404|500|not found|error|oops)\b/) ||
    h1Text.match(/\b(404|500|not found|error|oops|page not found)\b/)
  ) {
    return "error";
  }

  // Collect form field count
  const totalFormFields = forms.reduce((sum, f) => sum + f.fields.length, 0);

  // Checkout: form with payment keywords
  const hasPaymentForm = forms.some((f) => {
    const fieldNames = f.fields.map((field) => `${field.name} ${field.labelText}`.toLowerCase()).join(" ");
    return (
      fieldNames.includes("card") ||
      fieldNames.includes("payment") ||
      fieldNames.includes("billing") ||
      fieldNames.includes("cvv") ||
      fieldNames.includes("expir") ||
      fieldNames.includes("credit")
    );
  });
  if (hasPaymentForm) return "checkout";

  // Search: has search input + what looks like a results list
  const hasSearchInput = interactiveElements.some(
    (el) =>
      el.type === "search" ||
      el.name.toLowerCase().includes("search") ||
      el.name.toLowerCase().includes("query") ||
      (el.name.toLowerCase() === "q" && el.tag === "input") ||
      el.ariaLabel.toLowerCase().includes("search") ||
      el.role === "search"
  );
  // A search RESULTS page, not merely a page with a search box in its header.
  // `childCount >= 5` on <main> is satisfied by almost any marketing homepage
  // with a few sections, so a site whose nav carries a search field was typed
  // "search". Require the search field to be the page's own subject: repeated
  // sibling structure that looks like a result list, and no competing landing
  // signal. (2026-07-29)
  // Kept for the "list" heuristic below, which legitimately wants the loose test.
  const hasRepeatedContent = regions.some((r) => r.childCount >= 5 && (r.tag === "main" || r.role === "main"));
  const hasResultList = regions.some(
    (r) => (r.tag === "main" || r.role === "main") && r.childCount >= 5 && r.repeatedChildTag === true
  );
  // A search box in the site nav does not make a page a search page — that is
  // how a marketing homepage got typed "search". The thing that actually
  // distinguishes a results page is that it is SERVING a query: /search in the
  // path, or a query parameter. Require that as well as the DOM signals.
  let looksLikeSearchUrl = false;
  if (pageUrl) {
    try {
      const u = new URL(pageUrl);
      const qKeys = ["q", "query", "s", "search", "keyword", "term"];
      looksLikeSearchUrl =
        /\/search\b/i.test(u.pathname) || qKeys.some((k) => u.searchParams.has(k));
    } catch { looksLikeSearchUrl = false; }
  }
  if (hasSearchInput && hasResultList && looksLikeSearchUrl) return "search";

  // Settings: many toggles/selects/checkboxes with settings keywords
  const toggleCount = interactiveElements.filter(
    (el) =>
      el.type === "checkbox" ||
      el.type === "radio" ||
      el.role === "switch" ||
      el.role === "checkbox" ||
      el.tag === "select"
  ).length;
  if (
    toggleCount >= 3 &&
    (h1Text.includes("settings") ||
      h1Text.includes("preferences") ||
      h1Text.includes("configuration") ||
      titleLower.includes("settings") ||
      titleLower.includes("preferences"))
  ) {
    return "settings";
  }

  // Dashboard: sidebar nav + multiple data sections
  const hasSidebar = regions.some(
    (r) => r.tag === "aside" || r.role === "complementary"
  );
  const hasMultipleNavs = navs.length >= 2;
  const hasMultipleSections = regions.filter(
    (r) => r.tag === "section" || r.role === "region"
  ).length >= 3;
  if ((hasSidebar || hasMultipleNavs) && hasMultipleSections) return "dashboard";

  // Form: 3+ input fields with a submit button
  if (totalFormFields >= 3 && forms.some((f) => f.submitButton)) return "form";

  // Article: long text content with heading hierarchy, few forms
  const hasDeepHeadings = headings.some((h) => h.level >= 3);
  const manyHeadings = headings.length >= 3;
  // Article heuristic: multiple headings, deep hierarchy, few interactive elements relative to headings
  if (manyHeadings && hasDeepHeadings && totalFormFields <= 2) return "article";

  // List: repeated card/row structures (check for many links or repeated elements)
  const linkCount = interactiveElements.filter((el) => el.tag === "a").length;
  if (linkCount >= 10 && hasRepeatedContent) return "list";

  // Landing: hero section, CTA buttons, default fallback
  // Check for hero-like patterns: large elements near top of page
  const hasTopButtons = interactiveElements.some(
    (el) => el.tag === "a" && el.rect.top < 600 && el.text.length > 0 && el.text.length < 30
  );
  if (hasTopButtons || navs.length > 0) return "landing";

  return "landing";
}

function classifyPageTypeFromSkeleton(data: RawSkeletonData): PageType {
  if (data.hasErrorIndicator) return "error";
  if (data.hasPaymentKeywords) return "checkout";
  if (data.hasSearchInput && data.repeatedStructures > 0) return "search";
  if (data.hasSettingsKeywords && data.inputCount >= 3) return "settings";
  if (data.hasSidebar && data.navLandmarks >= 2) return "dashboard";
  if (data.inputCount >= 3 && data.hasSubmitButton) return "form";
  if (data.headingCount >= 3 && data.longTextBlocks >= 2 && data.formCount <= 1) return "article";
  if (data.repeatedStructures >= 1 && data.linkCount >= 10) return "list";
  return "landing";
}

// ============================================================================
// Affordance computation
// ============================================================================

function computeAffordances(raw: RawDOMExtraction, pageUrl?: string): Affordance[] {
  const affordances: Affordance[] = [];

  for (const el of raw.interactiveElements) {
    if (el.disabled) continue;

    const action = determineAction(el);
    const expectedOutcome = predictOutcome(el, action, pageUrl);
    const confidence = computeConfidence(el);
    const reversible = determineReversibility(el, action);
    const selector = buildSelector(el);

    affordances.push({
      element: selector,
      elementText: el.text.slice(0, MAX_TEXT_LENGTH),
      action,
      expectedOutcome,
      confidence,
      reversible,
      ...(el.role ? { ariaRole: el.role } : {}),
    });
  }

  return affordances;
}

function determineAction(el: RawInteractiveElement): Affordance["action"] {
  const { tag, type, role } = el;

  // Submit buttons.
  // HTMLButtonElement.type has an IDL default of "submit", so `type === "submit"`
  // was true for EVERY bare <button> even on a page with no <form> at all, and the
  // `el.formIndex >= 0` guard below it was unreachable dead code. A button outside
  // a form submits nothing, and mislabelling it matters because "submit" is what
  // marks the affordance irreversible (see isReversible), which feeds risk and
  // safety reasoning. Require an actual owning form. (2026-07-29)
  if (tag === "button" || tag === "input") {
    if (type === "submit" && el.formIndex >= 0) return "submit";
  } else if (type === "submit") {
    return "submit";
  }

  // Toggle elements
  if (role === "switch" || role === "checkbox" || type === "checkbox" || type === "radio") return "toggle";

  // Fill elements
  if (tag === "input" && !["submit", "button", "reset", "checkbox", "radio", "hidden"].includes(type)) return "fill";
  if (tag === "textarea") return "fill";

  // Select elements
  if (tag === "select" || role === "listbox" || role === "combobox") return "select";

  // Everything else is a click
  return "click";
}

function predictOutcome(el: RawInteractiveElement, action: Affordance["action"], pageUrl?: string): string {
  const text = el.text.toLowerCase().trim();
  const href = el.href;

  switch (action) {
    case "submit":
      return "Submit form data to server";

    case "fill": {
      const label = el.ariaLabel || el.name || el.type;
      return `Enter ${label || "text"} value`;
    }

    case "select":
      return `Select an option from ${el.ariaLabel || el.name || "dropdown"}`;

    case "toggle":
      return `Toggle ${el.ariaLabel || el.name || "option"} on/off`;

    case "click": {
      if (el.tag === "a" && href) {
        if (href.startsWith("mailto:")) return `Open email to ${href.replace("mailto:", "")}`;
        if (href.startsWith("tel:")) return `Initiate phone call`;
        if (href.includes("#")) return "Scroll to page section";
        // This engine runs in NODE, where globalThis.location is undefined, so the
        // old test collapsed to `!href.includes("__no_match__")` — always true.
        // Every absolute link was labelled external, same-origin ones included.
        // It only compiled because tsconfig pulls in the DOM lib. Compare against
        // the page's real origin instead. (2026-07-29)
        if (href.startsWith("http")) {
          let sameOrigin = false;
          if (pageUrl) {
            try { sameOrigin = new URL(href).origin === new URL(pageUrl).origin; } catch { sameOrigin = false; }
          }
          if (!sameOrigin) return "Navigate to external site";
        }
        return `Navigate to ${text || "linked page"}`;
      }
      if (el.role === "tab") return `Switch to ${text || "tab"} panel`;
      if (el.role === "menuitem") return `Select ${text || "menu"} option`;
      if (text.match(/\b(close|dismiss|cancel)\b/i)) return "Close or dismiss";
      if (text.match(/\b(delete|remove)\b/i)) return "Delete or remove item";
      if (text.match(/\b(save|update)\b/i)) return "Save changes";
      if (text.match(/\b(add|create|new)\b/i)) return "Create new item";
      if (text.match(/\b(edit|modify)\b/i)) return "Enter edit mode";
      if (text.match(/\b(open|show|view|expand)\b/i)) return "Show or reveal content";
      if (text.match(/\b(next|continue|proceed)\b/i)) return "Advance to next step";
      if (text.match(/\b(back|previous|prev)\b/i)) return "Return to previous step";
      if (text.match(/\b(search|find)\b/i)) return "Initiate search";
      if (text.match(/\b(sign in|log in|login)\b/i)) return "Navigate to sign in";
      if (text.match(/\b(sign up|register|join)\b/i)) return "Navigate to registration";
      return `Activate ${text || el.ariaLabel || "element"}`;
    }

    default:
      return "Interact with element";
  }
}

function computeConfidence(el: RawInteractiveElement): number {
  // ARIA role gives highest confidence - explicitly declared purpose
  if (el.role && el.role !== "presentation" && el.role !== "none") return 0.9;
  // Clear visible text indicates purpose
  if (el.text.trim().length > 0 && el.text.trim().length <= 50) return 0.8;
  // ARIA label provides machine-readable purpose
  if (el.ariaLabel) return 0.8;
  // Type attribute at least tells us the input category
  if (el.type && el.type !== "text") return 0.7;
  // Name attribute suggests server-side purpose
  if (el.name) return 0.65;
  // Has an id (developer intended something)
  if (el.id) return 0.6;
  // Generic element with no distinguishing attributes
  return 0.5;
}

function determineReversibility(el: RawInteractiveElement, action: Affordance["action"]): boolean {
  // Links are reversible (browser back button)
  if (el.tag === "a" && el.href) return true;
  // Toggles are reversible (click again)
  if (action === "toggle") return true;
  // Fill is reversible (clear and retype)
  if (action === "fill") return true;
  // Select is reversible (choose different option)
  if (action === "select") return true;
  // Tabs are reversible (click another tab)
  if (el.role === "tab") return true;
  // Form submits are NOT reversible
  if (action === "submit") return false;
  // Delete/remove buttons are NOT reversible
  if (el.text.toLowerCase().match(/\b(delete|remove|destroy)\b/)) return false;
  // Default: clicks with no clear destructive intent are cautiously reversible
  return true;
}

// ============================================================================
// Structure building
// ============================================================================

function buildStructure(raw: RawDOMExtraction): PageStructure {
  const navigation = buildNavigationGroups(raw);
  const mainContent = buildMainContentGroups(raw);
  const forms = buildFormGroups(raw);
  const ctas = detectCTAs(raw);
  const headingHierarchy = buildHeadingHierarchy(raw.headings);

  return { navigation, mainContent, forms, ctas, headingHierarchy };
}

function buildNavigationGroups(raw: RawDOMExtraction): ElementGroup[] {
  return raw.navs.map((nav) => {
    const navSelector = buildNavSelector(nav);
    return {
      label: nav.ariaLabel || "Navigation",
      elements: nav.links.map((link) => ({
        selector: buildLinkSelector(link, navSelector),
        text: link.text,
        role: "link",
      })),
    };
  });
}

function buildMainContentGroups(raw: RawDOMExtraction): ElementGroup[] {
  // Gather links NOT inside any nav
  const navLinkHrefs = new Set<string>();
  for (const nav of raw.navs) {
    for (const link of nav.links) {
      navLinkHrefs.add(link.href);
    }
  }

  const contentLinks = raw.interactiveElements.filter(
    (el) => el.tag === "a" && el.href && !navLinkHrefs.has(el.href)
  );

  if (contentLinks.length === 0) return [];

  return [
    {
      label: "Content links",
      elements: contentLinks.map((el) => ({
        selector: buildSelector(el),
        text: el.text.slice(0, MAX_TEXT_LENGTH),
        role: el.role || "link",
      })),
    },
  ];
}

function buildFormGroups(raw: RawDOMExtraction): FormGroup[] {
  return raw.forms.map((form, index) => {
    const formSelector = form.id ? `#${cssEscape(form.id)}` : `form:nth-of-type(${index + 1})`;

    // Derive a label from the form's first heading or legend or aria-label
    const label = form.id || `Form ${index + 1}`;

    return {
      label,
      action: form.action || undefined,
      method: form.method || undefined,
      fields: form.fields.map((field) => ({
        selector: buildFieldSelector(field, formSelector),
        type: field.type,
        name: field.name,
        label: field.labelText || undefined,
        required: field.required,
      })),
      submitButton: form.submitButton
        ? {
            selector: buildSubmitSelector(form.submitButton, formSelector),
            text: form.submitButton.text,
          }
        : undefined,
    };
  });
}

function detectCTAs(raw: RawDOMExtraction): CTAElement[] {
  const ctas: CTAElement[] = [];
  const ctaKeywords = /\b(sign up|get started|try|start|buy|subscribe|download|join|register|book|order|contact|learn more|shop now|explore)\b/i;

  for (const el of raw.interactiveElements) {
    if (el.disabled) continue;
    const text = el.text.trim();
    if (!text || text.length > 60) continue;

    // Check if element text matches CTA patterns
    if (!ctaKeywords.test(text)) continue;

    const selector = buildSelector(el);
    const type: CTAElement["type"] = el.tag === "a" ? "link" : "button";

    // Determine prominence based on position and styling hints
    let prominence: CTAElement["prominence"] = "tertiary";
    if (el.rect.top < 600) {
      // Above the fold
      if (el.rect.width > 120 || el.className.toLowerCase().match(/\b(primary|cta|hero|main)\b/)) {
        prominence = "primary";
      } else {
        prominence = "secondary";
      }
    } else if (el.className.toLowerCase().match(/\b(primary|cta)\b/)) {
      prominence = "secondary";
    }

    ctas.push({ selector, text, prominence, type });
  }

  // Sort: primary first, then secondary, then tertiary
  const order: Record<string, number> = { primary: 0, secondary: 1, tertiary: 2 };
  ctas.sort((a, b) => order[a.prominence] - order[b.prominence]);

  return ctas;
}

function buildHeadingHierarchy(headings: RawHeading[]): HeadingNode[] {
  if (headings.length === 0) return [];

  const root: HeadingNode[] = [];
  const stack: HeadingNode[] = [];

  for (const h of headings) {
    const node: HeadingNode = {
      level: h.level,
      text: h.text,
      selector: h.id ? `#${cssEscape(h.id)}` : `h${h.level}:nth-of-type(${h.nthOfType})`,
      children: [],
    };

    // Pop stack until we find a heading with a lower level (parent)
    while (stack.length > 0 && stack[stack.length - 1].level >= h.level) {
      stack.pop();
    }

    if (stack.length === 0) {
      root.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }

    stack.push(node);
  }

  return root;
}

// ============================================================================
// Relationship computation
// ============================================================================

function computeRelationships(raw: RawDOMExtraction, structure: PageStructure): ElementRelationship[] {
  const relationships: ElementRelationship[] = [];

  // same-form: inputs sharing a form element
  for (const form of structure.forms) {
    const fieldSelectors = form.fields.map((f) => f.selector);
    for (let i = 0; i < fieldSelectors.length && relationships.length < MAX_RELATIONSHIPS; i++) {
      for (let j = i + 1; j < fieldSelectors.length && relationships.length < MAX_RELATIONSHIPS; j++) {
        relationships.push({
          elementA: fieldSelectors[i],
          elementB: fieldSelectors[j],
          type: "same-form",
        });
      }
    }
    // Form contains its submit button
    if (form.submitButton && relationships.length < MAX_RELATIONSHIPS) {
      for (const field of form.fields) {
        if (relationships.length >= MAX_RELATIONSHIPS) break;
        relationships.push({
          elementA: form.submitButton.selector,
          elementB: field.selector,
          type: "same-form",
        });
      }
    }
  }

  // contains: nav containing links
  for (const navGroup of structure.navigation) {
    for (const el of navGroup.elements) {
      if (relationships.length >= MAX_RELATIONSHIPS) break;
      // Use the nav group label as a pseudo-selector for the container
      const navSelector = `nav[aria-label="${navGroup.label}"]`;
      relationships.push({
        elementA: navSelector,
        elementB: el.selector,
        type: "contains",
      });
    }
  }

  // adjacent: interactive elements near each other (within 50px vertical)
  const sorted = [...raw.interactiveElements]
    .filter((el) => !el.disabled && el.rect.width > 0)
    .sort((a, b) => a.rect.top - b.rect.top);

  for (let i = 0; i < sorted.length - 1 && relationships.length < MAX_RELATIONSHIPS; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const verticalGap = Math.abs(b.rect.top - (a.rect.top + a.rect.height));
    if (verticalGap < 50 && a.formIndex === -1 && b.formIndex === -1) {
      relationships.push({
        elementA: buildSelector(a),
        elementB: buildSelector(b),
        type: "adjacent",
      });
    }
  }

  return relationships.slice(0, MAX_RELATIONSHIPS);
}

// ============================================================================
// Selector builders
// ============================================================================

function buildSelector(el: RawInteractiveElement): string {
  if (el.id) return `#${cssEscape(el.id)}`;
  if (el.role && el.ariaLabel) return `[role="${el.role}"][aria-label="${cssEscapeAttr(el.ariaLabel)}"]`;
  if (el.name && el.tag === "input") return `input[name="${cssEscapeAttr(el.name)}"]`;
  if (el.name) return `${el.tag}[name="${cssEscapeAttr(el.name)}"]`;
  if (el.ariaLabel) return `${el.tag}[aria-label="${cssEscapeAttr(el.ariaLabel)}"]`;
  if (el.href && el.tag === "a") {
    const truncHref = el.href.length > 80 ? el.href.slice(0, 80) : el.href;
    return `a[href="${cssEscapeAttr(truncHref)}"]`;
  }
  // Fallback to nth-of-type
  return `${el.tag}:nth-of-type(${el.nthOfType})`;
}

function buildNavSelector(nav: RawNavData): string {
  if (nav.id) return `#${cssEscape(nav.id)}`;
  if (nav.ariaLabel) return `nav[aria-label="${cssEscapeAttr(nav.ariaLabel)}"]`;
  return `nav:nth-of-type(${nav.nthOfType})`;
}

function buildLinkSelector(link: RawNavData["links"][0], parentSelector: string): string {
  if (link.id) return `#${cssEscape(link.id)}`;
  if (link.href) return `${parentSelector} a[href="${cssEscapeAttr(link.href)}"]`;
  return `${parentSelector} a:nth-of-type(${link.nthOfType})`;
}

function buildFieldSelector(field: RawFormData["fields"][0], formSelector: string): string {
  if (field.id) return `#${cssEscape(field.id)}`;
  if (field.name) return `${formSelector} ${field.tag}[name="${cssEscapeAttr(field.name)}"]`;
  return `${formSelector} ${field.tag}:nth-of-type(${field.nthOfType})`;
}

function buildSubmitSelector(btn: NonNullable<RawFormData["submitButton"]>, formSelector: string): string {
  if (btn.id) return `#${cssEscape(btn.id)}`;
  if (btn.tag === "input") return `${formSelector} input[type="submit"]`;
  return `${formSelector} button[type="submit"]`;
}

// ============================================================================
// Utility functions
// ============================================================================

/**
 * Simple string hash for cache invalidation.
 * Not cryptographic - just needs to detect content changes.
 */
function simpleHash(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return `h${(hash >>> 0).toString(36)}`;
}

function computeHashFromSkeleton(data: RawSkeletonData): string {
  const raw = `${data.elementCount}:${data.formCount}:${data.linkCount}:${data.headingTexts.join("|")}`;
  return simpleHash(raw);
}

/**
 * Escape a string for use as a CSS ID selector.
 * Handles characters that are invalid in CSS identifiers.
 */
function cssEscape(value: string): string {
  return value.replace(/([^\w-])/g, "\\$1");
}

/**
 * Escape a string for use inside a CSS attribute value selector.
 * Escapes quotes and backslashes.
 */
function cssEscapeAttr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
