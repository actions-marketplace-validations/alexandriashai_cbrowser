# CBrowser Architecture Ultraplan — 4 Major Upgrades

**Issues:** #160, #161, #162, #163
**Created:** 2026-04-07
**Status:** Approved by Council (Architect, Product, Security, Performance)

---

## Requirements Summary

Transform CBrowser from a stateless browser automation tool into an intelligent browser agent that:
1. Understands pages deeply (interaction graphs, affordances, semantic structure)
2. Learns about sites over time (navigation patterns, element reliability, goal paths)
3. Maintains persistent relationships with sites (cookies, auth state, profiles)
4. Decomposes and executes goals autonomously with fallback strategies

## Implementation Order (Council Consensus)

```
#162 Real-Time Page Understanding (independent, immediate value)
  ↓
#163 Cross-Session State (extends SessionManager, needs encryption)
  ↓
#160 Site Model Learning (consumes #162 page data, complements #163)
  ↓
#161 Autonomous Goal Decomposition (consumes all three above)
```

## Architectural Decisions (Council Consensus)

| Decision | Resolution | Rationale |
|----------|-----------|-----------|
| SiteModel vs SiteProfile storage | **Separate backing stores, unified query interface** | Different lifecycles, mental models, and security requirements |
| PageUnderstanding computation | **Lazy with caching** — computed on first access, cached in memory, invalidated on navigation | 200-500ms computation cost prohibits eager/hot-path |
| GoalDecomposer intelligence | **Claude API first with caching** — add heuristic fast-path later if telemetry warrants | Avoid premature optimization; let data drive heuristic investment |
| Credential storage | **Encrypted at rest (AES-256-GCM) from day one** — decrypted into memory on load, never on read path | 2-3ms overhead within 50ms budget; security non-negotiable |
| I/O pattern | **Async with write-coalescing** — batch dirty writes on 1-2s debounce, not per-mutation | Current sync I/O is tech debt; new features must not compound it |
| Performance gates | **50ms per-navigation overhead, 500KB per-domain model cap** — enforced in CI | Hard constraints, not aspirational targets |

---

## Phase 1: Real-Time Page Understanding (#162)

**Goal:** Rich page model from accessibility tree + DOM analysis
**Estimated effort:** 3-5 days
**Dependencies:** None (independent)

### New Files

#### `src/analysis/page-understanding.ts` — PageUnderstandingEngine

```typescript
// Core engine class
export class PageUnderstandingEngine {
  // Compute full page understanding from Playwright Page
  async analyze(page: Page): Promise<PageUnderstanding>;
  
  // Lightweight skeleton (cheap, can run on navigation)
  async skeleton(page: Page): Promise<PageSkeleton>;
  
  // Cache management
  private cache: Map<string, { understanding: PageUnderstanding; contentHash: string }>;
  invalidate(url: string): void;
}
```

**Key methods:**

1. **`classifyPageType()`** — Uses heading patterns, form presence, nav structure, content density
   - landing: hero section + CTA + minimal forms
   - form: 2+ input fields with submit
   - dashboard: sidebar nav + data panels
   - article: long-form text with heading hierarchy
   - search: search input + result list
   - checkout: payment/address forms
   - error: error codes, "not found" text
   - settings: toggle/select-heavy forms
   - list: repeated card/row structures

2. **`computeAffordances()`** — For each interactive element:
   - What action is possible (click, fill, select, scroll, submit)
   - What outcome is expected (navigation, modal, toggle, form submission)
   - Confidence score (based on ARIA role, element type, visible text)
   - Reversibility (back button vs destructive action)

3. **`detectFormGroups()`** — Groups inputs by:
   - Explicit `<fieldset>` boundaries
   - Visual proximity (computed from bounding rects)
   - Label associations (`for` attribute, `aria-labelledby`)
   - Naming patterns (shipping_*, billing_*, etc.)

4. **`separateNavFromContent()`** — Uses:
   - `<nav>` landmarks and `role="navigation"`
   - Position heuristics (top/left = nav, center = content)
   - Link density (nav regions have high link:text ratio)
   - ARIA landmarks: `main`, `complementary`, `contentinfo`

5. **`computeRelationships()`** — Element relationships:
   - contains: parent-child DOM
   - adjacent: sibling elements or visual proximity
   - same-group: shared fieldset/section/container
   - same-form: inputs within same `<form>`
   - linked: anchor pointing to element ID

#### `src/types.ts` — New interfaces

```typescript
export interface PageUnderstanding {
  url: string;
  type: PageType;
  affordances: Affordance[];
  structure: PageStructure;
  relationships: ElementRelationship[];
  computedAt: number;
  computeTimeMs: number;
}

export type PageType = 
  | "landing" | "form" | "dashboard" | "article" 
  | "search" | "checkout" | "error" | "settings" | "list";

export interface Affordance {
  element: string;        // selector
  elementText: string;    // visible text
  action: "click" | "fill" | "select" | "scroll" | "submit" | "toggle";
  expectedOutcome: string;
  confidence: number;     // 0-1
  reversible: boolean;
  ariaRole?: string;
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

export interface PageSkeleton {
  url: string;
  type: PageType;
  elementCount: number;
  formCount: number;
  linkCount: number;
  headingCount: number;
  navLandmarks: number;
  contentHash: string;   // for cache invalidation
}
```

### Modified Files

#### `src/mcp-tools/base/extraction-tools.ts`
- Add `page_understand` MCP tool registration
- Parameters: `url` (optional, uses current page), `includeRelationships` (boolean, default false)
- Returns: PageUnderstanding JSON

#### `src/mcp-tools/index.ts`
- Import and register page understanding tool
- Update tool count comment

#### `src/cognitive/index.ts`
- In autonomous journey: after navigation, compute PageUnderstanding
- Use affordances to make informed action choices instead of raw element lists
- Use page type to adjust exploration strategy

### Performance Constraints

- **Budget:** 500ms max for full analysis, 50ms for skeleton
- **Caching:** In-memory, keyed by URL + content hash
- **Invalidation:** On navigation, DOM mutation, or explicit call
- **Element limit:** If >1000 elements, compute affordances only for visible viewport + nav

### Acceptance Criteria

- [ ] PageUnderstanding computed in <500ms for pages with <500 elements
- [ ] PageSkeleton computed in <50ms
- [ ] Page type classification accuracy >80% on 20 test pages
- [ ] Affordance confidence scores correlate with actual element behavior
- [ ] Zero additional latency on navigate/click/fill tools (lazy, not eager)
- [ ] `page_understand` MCP tool returns valid PageUnderstanding JSON
- [ ] Cognitive journey uses affordances for action selection

---

## Phase 2: Cross-Session State (#163)

**Goal:** Persistent browser profiles per site with auto-save/restore
**Estimated effort:** 3-4 days
**Dependencies:** None (extends existing SessionManager)
**Security gate:** Credentials encrypted at rest before merge

### New Files

#### `src/browser/site-profile-manager.ts` — SiteProfileManager

```typescript
export class SiteProfileManager {
  private profileDir: string; // ~/.cbrowser/site-profiles/
  
  // Auto-save after session (called from CBrowser.close())
  async saveProfile(domain: string, context: BrowserContext): Promise<void>;
  
  // Auto-restore on connection (called from CBrowser.launch())
  async loadProfile(domain: string, context: BrowserContext): Promise<ProfileLoadResult>;
  
  // List all profiles with health status
  async listProfiles(): Promise<SiteProfileSummary[]>;
  
  // Delete a profile
  async deleteProfile(domain: string): Promise<void>;
  
  // Check if session is still valid after restore
  async checkSessionValidity(page: Page): Promise<SessionValidity>;
  
  // Encryption
  private encrypt(data: string): string;  // AES-256-GCM
  private decrypt(data: string): string;
  private getEncryptionKey(): Buffer;     // derived from machine ID
}
```

**Storage format:** `~/.cbrowser/site-profiles/{domain}/`
```
~/.cbrowser/site-profiles/
  example.com/
    cookies.enc.json      # encrypted cookies
    storage.json          # localStorage (not encrypted — no credentials)
    state.json            # last URL, auth status, timestamps
    meta.json             # domain, created, lastUsed, cookieCount
```

**Auto-save triggers:**
- Browser context close (CBrowser.close())
- Domain change during navigation (new domain → save old, load new)
- Explicit save_session MCP tool call

**Auto-restore triggers:**
- Navigation to a domain with existing profile
- Only if profile is <24 hours old (configurable)

**Session validity detection:**
- After restoring cookies, navigate to last URL
- Check for login redirect (302 to /login, /auth, /signin)
- Check for auth-required indicators (login form, "sign in" CTA)
- If invalid, report to user — no automatic re-auth in MVP

#### `src/types.ts` — New interfaces

```typescript
export interface SiteProfile {
  domain: string;
  created: string;        // ISO timestamp
  lastUsed: string;       // ISO timestamp
  cookieCount: number;
  localStorageKeys: number;
  lastUrl: string;
  authStatus: "unknown" | "authenticated" | "expired" | "none";
  profileVersion: number; // for migration
}

export interface ProfileLoadResult {
  success: boolean;
  domain: string;
  cookiesRestored: number;
  storageKeysRestored: number;
  sessionValid: boolean;
  message: string;
}

export interface SessionValidity {
  valid: boolean;
  reason: "active" | "expired" | "redirected" | "unknown";
  redirectedTo?: string;
}

export interface SiteProfileSummary {
  domain: string;
  lastUsed: string;
  cookieCount: number;
  authStatus: string;
  sizeBytes: number;
  healthy: boolean;
}
```

### Modified Files

#### `src/browser.ts`
- In `close()`: call `siteProfileManager.saveProfile()` if pages visited >1
- In `launch()`: check for existing profile on first navigation
- Add `siteProfileManager` as class member, initialized in constructor

#### `src/mcp-tools/base/session-tools.ts`
- Add `site_profile_list` tool — returns all profiles with health
- Add `site_profile_delete` tool — removes a specific profile
- Add `site_profile_status` tool — checks profile health for a domain

#### `src/mcp-tools/index.ts`
- Register new profile tools
- Update tool count

### Security Requirements (Non-negotiable)

- [ ] Cookies encrypted with AES-256-GCM before writing to disk
- [ ] Encryption key derived from machine-bound secret (hostname + user ID KDF)
- [ ] No plaintext credentials ever touch disk
- [ ] Profile files have 600 permissions (owner read/write only)
- [ ] Cookie encryption adds <5ms overhead
- [ ] Key rotation: re-encrypt on key change, document rotation procedure
- [ ] Unified query interface prevents cross-store credential leaks

### Acceptance Criteria

- [ ] Profile auto-saved when browser closes on domain with >1 page visited
- [ ] Profile auto-restored when navigating to domain with existing profile
- [ ] Session validity detected (login redirect detection)
- [ ] Profiles older than 24h skipped by default (configurable)
- [ ] `site_profile_list` returns all profiles with health status
- [ ] `site_profile_delete` removes profile and all associated files
- [ ] `site_profile_status` checks cookie expiry and auth state
- [ ] Existing SessionManager save/load still works unchanged
- [ ] AES-256-GCM encryption at rest for cookie files
- [ ] File permissions set to 600 on profile files

---

## Phase 3: Site Model Learning (#160)

**Goal:** Persistent knowledge graph per site, updated incrementally
**Estimated effort:** 5-7 days
**Dependencies:** #162 (page understanding feeds the model), #163 (complements profiles)

### New Files

#### `src/site-model/manager.ts` — SiteModelManager

```typescript
export class SiteModelManager {
  private modelDir: string; // ~/.cbrowser/site-models/
  private models: Map<string, SiteModel>;  // in-memory cache
  private dirty: Set<string>;  // domains with unsaved changes
  private writeTimer: NodeJS.Timeout | null;  // write-coalescing
  
  // Load model (lazy — only when queried)
  async loadModel(domain: string): Promise<SiteModel>;
  
  // Save with write-coalescing (1s debounce)
  markDirty(domain: string): void;
  private async flushDirty(): Promise<void>;
  
  // Update operations (called by tool hooks)
  recordNavigation(domain: string, edge: NavigationEdge): void;
  recordElementResult(domain: string, selector: string, success: boolean): void;
  recordGoalPath(domain: string, path: GoalPath): void;
  recordFailure(domain: string, failure: FailurePattern): void;
  updateFingerprint(domain: string, url: string, fingerprint: PageFingerprint): void;
  
  // Query operations
  queryBestPath(domain: string, goalType: string): GoalPath | null;
  queryElementReliability(domain: string, selector: string): number;
  queryNavigationTargets(domain: string, fromUrl: string): NavigationEdge[];
  
  // Maintenance
  pruneStaleData(domain: string): PruneResult;
  getModelStats(domain: string): SiteModelStats;
  
  // Size enforcement
  private enforceModelSizeCap(domain: string): void; // 500KB cap
}
```

#### `src/site-model/types.ts` — Site model types

```typescript
export interface SiteModel {
  domain: string;
  version: number;
  created: string;
  lastUpdated: string;
  navigation: NavigationGraph;
  elements: ElementReliabilityMap;
  goalPaths: GoalPath[];
  failures: FailurePattern[];
  fingerprints: PageFingerprintMap;
}

export interface NavigationGraph {
  nodes: Map<string, NavigationNode>;  // URL → node
  edges: NavigationEdge[];
}

export interface NavigationNode {
  url: string;
  pageType: PageType;       // from #162
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
  reliability: number;      // derived: success / (success + failure)
}

export interface ElementReliabilityMap {
  [selectorKey: string]: ElementReliability;
}

export interface ElementReliability {
  selector: string;
  domain: string;
  pageUrlPattern: string;   // URL pattern where this element appears
  successRate: number;       // 0-1
  totalAttempts: number;
  alternatives: string[];    // from selector cache
  lastVerified: number;
  decayFactor: number;       // reduced over time
}

export interface GoalPath {
  goalDescription: string;
  goalType: GoalType;
  actionSequence: GoalAction[];
  successRate: number;
  attemptCount: number;
  averageSteps: number;
  personaPerformance: Map<string, { success: boolean; steps: number }>;
  lastUsed: number;
}

export type GoalType = "find_information" | "complete_action" | "navigate_to" | 
                       "fill_form" | "compare" | "explore" | "extract_data";

export interface GoalAction {
  type: "navigate" | "click" | "fill" | "select" | "scroll" | "wait";
  target: string;       // URL or selector
  value?: string;       // for fill actions
  expectedOutcome: string;
}

export interface FailurePattern {
  pageUrlPattern: string;
  elementSelector?: string;
  failureType: "element_not_found" | "timeout" | "navigation_error" | 
               "blocked_by_overlay" | "auth_required" | "captcha" | "rate_limited";
  frequency: number;
  conditions: string[];   // context when failure occurs
  workaround?: string;    // known workaround
  lastSeen: number;
}

export interface PageFingerprint {
  urlPattern: string;
  headingStructureHash: string;
  formCount: number;
  navLinkCount: number;
  ctaCount: number;
  pageType: PageType;
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
```

### Modified Files

#### `src/mcp-tools/base/navigation-tools.ts`
- After successful `navigate()`: call `siteModelManager.recordNavigation()`
- After navigation: compute PageSkeleton, update fingerprint if changed

#### `src/mcp-tools/base/interaction-tools.ts`
- After `click()`/`fill()`: call `siteModelManager.recordElementResult()`
- On failure: call `siteModelManager.recordFailure()`

#### `src/mcp-tools/base/cognitive-tools.ts`
- After journey completion: call `siteModelManager.recordGoalPath()`
- Before journey init: query site model for known paths

#### `src/mcp-tools/base/analysis-tools.ts` (or new file)
- Add `site_model_status` MCP tool — returns SiteModelStats
- Add `site_model_query` MCP tool — query best path for a goal

#### `src/mcp-tools/index.ts`
- Register site model tools
- Update tool count

### Data Lifecycle

```
Navigation → recordNavigation() → markDirty() → [1s debounce] → flushDirty() → JSON.stringify → writeFile

Pruning (runs on load):
  - Elements with decayFactor < 0.1 → removed
  - Edges not used in 30 days → confidence halved
  - Edges with confidence < 0.05 → removed
  - Goal paths with 0% success and >3 attempts → removed
  - If model > 500KB after prune → LRU evict oldest edges/elements
```

### Integration with #162 and #163

- Page fingerprints use `PageSkeleton` from #162
- Navigation nodes store `PageType` from #162
- Site model loading checks if a SiteProfile (#163) exists for the domain
- When #163 restores a session, site model provides context about what the user was doing

### Acceptance Criteria

- [ ] SiteModel JSON stored at ~/.cbrowser/site-models/{domain}.json
- [ ] Navigation graph updated after every successful navigate()
- [ ] Element reliability updated after every click/fill interaction
- [ ] Goal paths recorded after cognitive journey completion
- [ ] Failure patterns recorded with context on interaction failure
- [ ] Page fingerprints computed from PageSkeleton (#162)
- [ ] Data decay: elements >30 days get 50% confidence reduction
- [ ] Data pruning: entries <0.1 confidence auto-removed
- [ ] 500KB per-domain size cap enforced with LRU eviction
- [ ] Write-coalescing: dirty models flushed on 1s debounce timer
- [ ] `site_model_status` MCP tool returns model stats
- [ ] `site_model_query` MCP tool returns best path for goal type
- [ ] Cognitive journey init checks site model before exploration
- [ ] Async I/O only — no sync writes on hot path
- [ ] Model load time <10ms for models under 500KB

---

## Phase 4: Autonomous Goal Decomposition (#161)

**Goal:** Transform CBrowser from reactive tool to autonomous agent
**Estimated effort:** 5-7 days
**Dependencies:** #160 (site model for informed planning), #162 (page understanding for action selection)

### New Files

#### `src/cognitive/goal-decomposer.ts` — GoalDecomposer

```typescript
export class GoalDecomposer {
  private siteModelManager: SiteModelManager;
  private pageEngine: PageUnderstandingEngine;
  
  // Parse goal into structured type
  parseGoal(goal: string): ParsedGoal;
  
  // Generate execution plan
  async decompose(
    goal: string, 
    domain: string, 
    currentPage: PageUnderstanding
  ): Promise<GoalPlan>;
  
  // Execute plan with fallback strategies
  async execute(
    plan: GoalPlan, 
    browser: CBrowser,
    options: ExecutionOptions
  ): Promise<GoalResult>;
  
  // Update site model with results
  private recordOutcome(domain: string, plan: GoalPlan, result: GoalResult): void;
}
```

#### `src/cognitive/goal-types.ts` — Goal decomposition types

```typescript
export interface ParsedGoal {
  originalText: string;
  type: GoalType;           // find_information, complete_action, etc.
  informationType?: InformationType;  // temporal, spatial, procedural, factual
  keywords: string[];
  confidence: number;
}

export type InformationType = "temporal" | "spatial" | "procedural" | "factual" | "comparative";

export interface GoalPlan {
  goal: ParsedGoal;
  subGoals: SubGoal[];
  estimatedSteps: number;
  confidence: number;       // based on site model coverage
  source: "site-model" | "claude-api" | "heuristic";
}

export interface SubGoal {
  description: string;
  strategies: Strategy[];
  dependencies: number[];   // indices of prerequisite sub-goals
  verificationCriteria: string;
}

export interface Strategy {
  name: string;
  actions: PlannedAction[];
  confidence: number;
  source: "site-model" | "heuristic" | "claude-api";
}

export interface PlannedAction {
  type: "navigate" | "click" | "fill" | "select" | "scroll" | "wait" | "extract";
  target: string;
  value?: string;
  expectedOutcome: string;
  timeout: number;
}

export interface GoalResult {
  achieved: boolean;
  evidence: string[];       // from goal evidence validation
  stepsExecuted: number;
  strategiesAttempted: number;
  failureReason?: string;
  journeyLog: JourneyLogEntry[];
}

export interface ExecutionOptions {
  maxSteps: number;         // default 15
  maxRetries: number;       // per sub-goal, default 3
  timeout: number;          // total timeout ms, default 120000
  persona?: string;         // cognitive persona for journey
}
```

### Goal Decomposition Flow

```
1. parseGoal("find application deadlines")
   → { type: "find_information", informationType: "temporal", keywords: ["application", "deadline"] }

2. Check site model for domain:
   a. Known goal paths matching type? → Use directly (high confidence)
   b. Known navigation to relevant pages? → Build plan from nav graph
   c. No site knowledge? → Fall through to Claude API

3. Claude API decomposition (if needed):
   - Send: goal text + page understanding + site model summary
   - Receive: SubGoal tree with strategies
   - Cache result keyed by goal type + domain

4. Execute plan:
   For each SubGoal (in dependency order):
     For each Strategy (in confidence order):
       Execute actions
       If success → move to next SubGoal
       If failure → try next Strategy
       If all strategies fail → record failure, report

5. Post-execution:
   - Record goal path to site model (success or failure)
   - Update element reliability scores
   - Update navigation graph with any new edges discovered
```

### Modified Files

#### `src/cognitive/index.ts`
- `runCognitiveJourney()` enhanced to use GoalDecomposer when available
- Check for Anthropic API key; decomposer requires it for Claude fallback
- Journey log includes strategy tracking

#### `src/mcp-tools/base/cognitive-tools.ts`
- `cognitive_journey_autonomous` enhanced with decomposer integration
- New parameter: `useDecomposer` (boolean, default true if API key available)
- Response includes: plan source, strategies attempted, confidence

#### `src/mcp-tools/index.ts`
- Update tool count

### Claude API Integration

```typescript
// Only called when site model has no coverage for the goal
async function claudeDecompose(
  goal: string,
  pageUnderstanding: PageUnderstanding,
  siteModelSummary: SiteModelStats,
  domain: string
): Promise<SubGoal[]> {
  const response = await anthropicClient.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    messages: [{
      role: "user",
      content: `Given this goal: "${goal}"
      
Page type: ${pageUnderstanding.type}
Available actions: ${pageUnderstanding.affordances.map(a => `${a.action} "${a.elementText}"`).join(", ")}
Site knowledge: ${siteModelSummary.navigationNodes} known pages, ${siteModelSummary.goalPaths} known paths

Decompose into 2-5 sub-goals with 2-3 strategies each. Return JSON.`
    }]
  });
  // Parse and validate response
}
```

### Acceptance Criteria

- [ ] GoalDecomposer parses goals into typed structures
- [ ] Goal type classification covers: find_information, complete_action, navigate_to, fill_form, compare, explore, extract_data
- [ ] Site model queried for known paths before Claude API
- [ ] Claude API called only when site model has no coverage
- [ ] SubGoal tree generated with 2-3 strategies per node
- [ ] Execution follows plan, switching strategies on failure
- [ ] Goal evidence validation integrated into verification
- [ ] Journey log tracks strategy attempted and outcome
- [ ] `cognitive_journey_autonomous` uses decomposer
- [ ] Site model updated with new goal paths after completion
- [ ] At least 3 strategy types: nav-based, search-based, URL-pattern

---

## Cross-Cutting Concerns

### Unified Query Interface

All per-domain data accessed through a thin facade:

```typescript
// src/site-knowledge/query.ts
export class SiteKnowledgeQuery {
  constructor(
    private models: SiteModelManager,
    private profiles: SiteProfileManager
  ) {}
  
  // Domain-level queries
  async getDomainSummary(domain: string): Promise<DomainSummary>;
  async hasPriorKnowledge(domain: string): Promise<boolean>;
  
  // CRITICAL: Never expose profile credentials through model queries
  // Credential isolation enforced at this boundary
}
```

### Async I/O Pattern

All new persistence uses this pattern:

```typescript
// Write-coalescing
private dirty = new Set<string>();
private writeTimer: NodeJS.Timeout | null = null;

markDirty(domain: string): void {
  this.dirty.add(domain);
  if (!this.writeTimer) {
    this.writeTimer = setTimeout(() => this.flushDirty(), 1000);
  }
}

private async flushDirty(): Promise<void> {
  this.writeTimer = null;
  const domains = [...this.dirty];
  this.dirty.clear();
  await Promise.all(domains.map(d => this.writeToDisk(d)));
}
```

### New MCP Tools Summary

| Tool | Phase | Description |
|------|-------|-------------|
| `page_understand` | #162 | Return PageUnderstanding for current page |
| `site_profile_list` | #163 | List all persistent profiles |
| `site_profile_delete` | #163 | Delete a site profile |
| `site_profile_status` | #163 | Check profile health |
| `site_model_status` | #160 | Site model statistics |
| `site_model_query` | #160 | Query best path for goal |

**Total tools after all phases: 97 (91 existing + 6 new)**

### New Directories

```
src/
  analysis/
    page-understanding.ts    # NEW — Phase 1
  browser/
    site-profile-manager.ts  # NEW — Phase 2
  site-model/
    manager.ts               # NEW — Phase 3
    types.ts                 # NEW — Phase 3
  site-knowledge/
    query.ts                 # NEW — Phase 3
  cognitive/
    goal-decomposer.ts       # NEW — Phase 4
    goal-types.ts            # NEW — Phase 4

~/.cbrowser/
  site-profiles/             # NEW — Phase 2
    {domain}/
      cookies.enc.json
      storage.json
      state.json
      meta.json
  site-models/               # NEW — Phase 3
    {domain}.json
```

---

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Page understanding >500ms on complex pages | Medium | Medium | Element limit (1000), viewport-only for large pages |
| Site model JSON bloat | High | Medium | 500KB cap, LRU eviction, aggressive pruning |
| Cookie restore triggers captchas | Medium | High | Fingerprint consistency, user notification, graceful fallback |
| Claude API latency for goal decomposition | Low | Medium | Cache decomposition results, site model reduces API calls over time |
| Encryption key management complexity | Low | High | Machine-bound derivation, documented rotation, no user-managed keys |
| Breaking existing MCP tools | Low | Critical | All new code in new files, existing tools unchanged, integration tests |
| SPA navigation detection gaps | Medium | Medium | Hook framenavigated events, MutationObserver for URL changes |

---

## Verification Steps

1. **Phase 1 verification:** Run `page_understand` on 20 diverse websites (landing, form, dashboard, article, search). Verify page type accuracy >80%, affordance list completeness, <500ms computation.

2. **Phase 2 verification:** Navigate to a site, interact with it, close browser. Reopen browser, navigate to same site. Verify cookies restored, localStorage intact, session validity detected correctly.

3. **Phase 3 verification:** Run 5 cognitive journeys on the same site. Verify site model accumulates navigation edges, element reliability scores, and goal paths. Verify model stays under 500KB. Verify the 6th journey is measurably faster/better than the 1st.

4. **Phase 4 verification:** Give a complex goal ("find scholarship application deadline and required documents"). Verify decomposition into sub-goals, strategy execution with fallbacks, goal evidence extraction, and site model update.

---

## Research References

- **AgentQ (MultiOn):** MCTS-guided browser agent, 81.7% success on complex tasks — validates goal decomposition approach
- **rtrvr.ai:** DOM-native intelligence outperforms screenshots (81.39% WebBench) — validates accessibility tree approach over vision-only
- **SeeAct (ICML 2024):** Set-of-Mark causes hallucination on complex pages — validates structured page understanding over visual grounding
- **Stagehand v3:** Action caching with DOM hash validation — closest prior art to site model learning
- **WebArena Contextual Experience Replay:** Prior knowledge augmentation raised GPT-4o success by 51% — strongest evidence for persistent site knowledge
- **Agueh & Carlier (SIAM 2011):** Wasserstein barycenters — existing CBrowser foundation for visual testing
- **Browserbase:** Managed persistent contexts — validates cross-session profile approach

---

## ADR: Architecture Decision Record

### Decision
Implement 4 CBrowser upgrades in order #162, #163, #160, #161 with separate backing stores, lazy page understanding, encrypted credential storage, and Claude-first goal decomposition.

### Drivers
1. No browser automation tool maintains persistent site knowledge — first-mover advantage
2. Page understanding is the foundation all other features consume
3. Users lose trust when sessions are ephemeral — persistence drives retention
4. Goal decomposition is the highest-value but highest-risk feature — ship last with most data

### Alternatives Considered
1. **Unified SiteKnowledge store** — rejected because credential isolation requires separate stores with different security postures
2. **Eager page understanding** — rejected because 200-500ms computation on every navigation violates 50ms budget
3. **Heuristic-first goal decomposer** — rejected as premature optimization; let telemetry drive heuristic investment
4. **#163 last (security concern)** — resolved by encrypting from day one, making ordering a non-issue

### Why Chosen
Council consensus after 3-round debate. Separate stores with unified interface satisfies both security (credential isolation) and developer ergonomics (single query surface). Lazy computation with caching satisfies both performance (50ms budget) and quality (rich page models when needed).

### Consequences
- 6 new MCP tools (97 total)
- 7 new source files across 4 new directories
- ~/.cbrowser/ gains 2 new subdirectories
- Async I/O pattern established as precedent for all future persistence
- Claude API dependency for goal decomposition (optional — heuristic fallback planned)

### Follow-ups
- Heuristic decomposer layer when telemetry shows >70% of goals match common patterns
- Key rotation automation for credential encryption
- Site model sharing across teams (opt-in, with PII scrubbing)
- Performance benchmarking dashboard for 50ms/500KB gates
