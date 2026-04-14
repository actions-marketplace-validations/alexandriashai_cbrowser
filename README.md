# CBrowser — Cognitive Browser Automation

> **The browser automation that thinks.** Achieved **Grade A+** in comprehensive stress testing—100% pass rate across 108 tools, zero critical bugs, zero server crashes. [View Full Assessment →](docs/STRESS-TEST-v16.14.4.md)

[![npm version](https://img.shields.io/npm/v/cbrowser.svg)](https://www.npmjs.com/package/cbrowser)
[![Documentation](https://img.shields.io/badge/Docs-cbrowser.ai-blue.svg)](https://cbrowser.ai/docs)
[![Grade A+](https://img.shields.io/badge/Stress%20Test-A+-brightgreen.svg)](docs/STRESS-TEST-v16.14.4.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![MCP Ready](https://img.shields.io/badge/MCP-108%20Tools-blue)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-blue.svg)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%3E%3D18-green.svg)](https://nodejs.org/)

**Built for AI agents. Trusted by humans.** The only browser automation that asks: *"Will a confused first-timer complete this task—and exactly when will they give up?"*

Sites that pass CBrowser's cognitive tests are easier for both humans **and** AI agents to navigate. The same principles that reduce user friction—clear structure, predictable patterns, accessible design—make sites more reliable for autonomous AI.

---

## What Makes CBrowser Different

**108 MCP tools, 26 cognitive traits, 10 motivational values, 17 cognitive + 8 marketing personas.** After rigorous stress testing across production sites including Airbnb and Hacker News:

| Capability | Status | Why It Matters |
|------------|--------|----------------|
| **Natural Language Tests** | ⭐ Best-in-class | Write tests in plain English. 10-step E2E flows run 100% stable. |
| **Cognitive User Simulation** | 🔬 Novel | 26 research-backed traits model real human behavior—not just clicks. |
| **Empathy Accessibility Audits** | 🔬 Novel | Simulate users with tremors, low vision, ADHD. No competitor offers this. |
| **Self-Healing Selectors** | ✅ Production-ready | ARIA-first with 0.8+ confidence gating. Handles DOM changes automatically. |
| **Constitutional AI Safety** | 🔬 Novel | Risk-classified actions prevent autonomous agents from doing damage. |
| **108 MCP Tools** | ✅ Production-ready | Full Claude integration—local and remote servers. |

---

## The Problem We Solve

Traditional browser automation answers one question: *"Does this button click?"*

CBrowser answers the question that actually matters: *"Will a confused first-timer on a slow connection find this button—and will they give up before they do?"*

Built on Playwright with cognitive user simulation, constitutional AI safety, and research-backed behavioral models, CBrowser is the only testing framework designed for the AI agent era.

---

## Core Differentiators

| Challenge | Traditional Tools | CBrowser |
|-----------|-------------------|----------|
| **User behavior** | Simulates clicks and keystrokes | **Simulates human cognition**—patience decay, frustration accumulation, decision fatigue |
| **Abandonment prediction** | Fails when elements don't exist | **Predicts when users give up** before they do |
| **AI agent safety** | No guardrails for autonomous agents | **Constitutional AI safety**—risk-classified actions with verification gates |
| **Selector resilience** | Breaks when DOM changes | **Self-healing ARIA-first selectors** with 0.8+ confidence gating |
| **Accessibility testing** | WCAG compliance checklists | **Disability empathy simulation**—experience your site as a user with tremors, low vision, or ADHD |

---

## Quick Start

### Installation

```bash
npm install cbrowser
npx playwright install chromium
```

### First Commands

```bash
# Navigate with intelligent wait detection
npx cbrowser navigate "https://your-site.com"

# Self-healing click with 80%+ confidence threshold
npx cbrowser smart-click "Add to Cart"

# Natural language assertions
npx cbrowser assert "page contains 'Order Confirmed'"

# Run a cognitive journey—simulate a real user
npx cbrowser cognitive-journey \
  --persona first-timer \
  --start "https://your-site.com" \
  --goal "complete checkout"
```

---

## Constitutional AI Safety

AI agents need boundaries. CBrowser classifies every action by risk level:

| Zone | Examples | Behavior |
|------|----------|----------|
| 🟢 **Green** | Navigate, read, screenshot | Auto-execute |
| 🟡 **Yellow** | Click buttons, fill forms | Log and proceed |
| 🔴 **Red** | Submit, delete, purchase | Requires verification |
| ⬛ **Black** | Bypass auth, inject scripts | Never executes |

An AI agent can freely browse and gather data, but cannot accidentally submit a form, delete records, or make purchases without explicit verification.

---

## Cognitive User Simulation

CBrowser models **25 research-backed cognitive traits** across 6 tiers to simulate how real users think and behave:

| Trait | Research Basis | What It Models |
|-------|---------------|----------------|
| **Patience** | Nah (2004); Nielsen (1993) | Tolerance for delays; abandonment at 8+ seconds |
| **Working Memory** | Miller (1956) | 7±2 item capacity; affects form complexity tolerance |
| **Comprehension** | Card, Moran & Newell (1983) | UI convention understanding; GOMS model timing |
| **Risk Tolerance** | Kahneman & Tversky (1979) | Prospect theory; loss aversion affects CTA clicks |
| **Self-Efficacy** | Bandura (1977) | Belief in ability to solve problems; low = faster abandonment |
| **Satisficing** | Simon (1956) | Accept "good enough" vs. optimize; 50% faster decisions |
| **Trust Calibration** | Fogg (2003) | 8 trust signals; affects click-through by 40% |
| **Information Foraging** | Pirolli & Card (1999) | "Scent" following behavior; predicts navigation patterns |
| **Social Proof** | Cialdini (2001) | Influence of reviews, ratings, popularity indicators |
| **FOMO** | Przybylski et al. (2013) | Fear of missing out; urgency and scarcity responses |

*See [Trait Index](https://github.com/alexandriashai/cbrowser/wiki/Trait-Index) for all 26 traits including: Persistence, Resilience, Curiosity, Change Blindness, Anchoring Bias, Time Horizon, Attribution Style, Metacognitive Planning, Procedural Fluency, Transfer Learning, Authority Sensitivity, Emotional Contagion, Mental Model Rigidity, Interrupt Recovery, Reading Tendency, and Site Familiarity.*

> **Note:** Trait correlation values are [educated estimates](https://github.com/alexandriashai/cbrowser/wiki/Research-Methodology#validation-status) derived from related research. Empirical calibration planned per [GitHub #95](https://github.com/alexandriashai/cbrowser/issues/95).

**Full documentation:** [Research Methodology](https://github.com/alexandriashai/cbrowser/wiki/Research-Methodology) · [Trait Index](https://github.com/alexandriashai/cbrowser/wiki/Trait-Index) · [Bibliography](https://github.com/alexandriashai/cbrowser/wiki/Bibliography)

### Abandonment Detection

The simulation stops when a realistic user would give up:

```bash
# Output from cognitive journey
⚠️ ABANDONED after 8 steps
Reason: Patience depleted (0.08) - "This is taking too long..."
Friction points:
  1. Password requirements unclear (step 4)
  2. Form validation error not visible (step 6)
```

### Custom Persona Builder (v16.6.0)

Create research-backed custom personas via interactive questionnaire:

```bash
# Interactive questionnaire (8 core traits)
npx cbrowser persona-questionnaire start

# Comprehensive questionnaire (all 26 traits)
npx cbrowser persona-questionnaire start --comprehensive --name "my-tester"

# Look up trait behaviors
npx cbrowser persona-questionnaire lookup --trait patience --value 0.25

# List all available traits
npx cbrowser persona-questionnaire list-traits
```

Each trait maps to research-backed behavioral descriptions with 5 levels (0, 0.25, 0.5, 0.75, 1.0).

### Research-Backed Values System (v16.12.0)

Beyond cognitive traits, CBrowser models **motivational values** that drive user decisions. The values system integrates three foundational psychological frameworks:

| Framework | Research Basis | What It Models |
|-----------|---------------|----------------|
| **Schwartz's Universal Values** | Schwartz (1992) | 10 core human values: Power, Achievement, Hedonism, Stimulation, Self-Direction, Universalism, Benevolence, Tradition, Conformity, Security |
| **Self-Determination Theory** | Deci & Ryan (1985) | Autonomy, Competence, and Relatedness needs that drive intrinsic motivation |
| **Maslow's Hierarchy** | Maslow (1943) | 5 need levels from Physiological to Self-Actualization |

Values influence decision-making differently than cognitive traits. A user high in **Security** values will read privacy policies; one high in **Stimulation** will click "Try Beta Features" immediately.

```bash
# Look up a persona's values profile
npx cbrowser persona-values power-user

# Output shows Schwartz values, SDT needs, and Maslow level
```

### Category-Aware Persona Creation

When you create a custom persona via `persona-questionnaire`, CBrowser automatically assigns appropriate values based on persona category:

| Category | Example Values Profile |
|----------|----------------------|
| **Novice** | High Security, high Conformity, low Self-Direction |
| **Professional** | High Achievement, high Competence, high Self-Direction |
| **Elderly** | High Tradition, high Security, moderate Benevolence |
| **Accessibility** | High Universalism, variable by specific disability |

This ensures cognitive journeys reflect realistic motivational differences—not just skill gaps. See [Persona Values Documentation](https://cbrowser.ai/docs/Values-Framework) for the complete values framework.

---

## Natural Language Testing

Write tests in plain English:

```txt
# Test: Checkout Flow
go to https://your-site.com/products
click "Add to Cart" button
verify page contains "1 item in cart"
click checkout
fill email with "test@example.com"
click "Place Order"
verify url contains "/confirmation"
```

```bash
npx cbrowser test-suite checkout-test.txt --html
```

### Self-Healing Test Repair

When tests break due to site changes:

```bash
npx cbrowser repair-tests broken-test.txt --auto-apply --verify
```

CBrowser analyzes failures, generates alternative selectors, and repairs tests automatically.

---

## Visual Testing Suite

### AI Visual Regression

Semantic comparison—understands what changed, not just pixel differences:

```bash
npx cbrowser ai-visual capture "https://your-site.com" --name homepage
npx cbrowser ai-visual test "https://staging.your-site.com" homepage --html
```

### Cross-Browser & Responsive

```bash
# Compare Chrome, Firefox, Safari rendering
npx cbrowser cross-browser "https://your-site.com" --html

# Test across mobile, tablet, desktop
npx cbrowser responsive "https://your-site.com" --html

# A/B comparison (staging vs production)
npx cbrowser ab "https://staging.your-site.com" "https://your-site.com" --html
```

---

## Cognitive Transport Chain (v18.41.0)

The 6-layer Sequential Transport Chain models how cognitive effort flows through perception, processing, and action:

| Layer | What It Measures | Research Basis |
|-------|-----------------|----------------|
| **Saliency** | Visual attention capture | CIE-Lab W₂ perceptual model |
| **Cognitive Load** | Information processing demand | Sweller (1988) CLT |
| **Decision** | Choice complexity and fatigue | Hick-Hyman Law |
| **Motor** | Physical interaction difficulty | Grossman & Balakrishnan (2005) |
| **Frustration** | Emotional cost accumulation | Ceaparu et al. (2004) |
| **Readability** | Text comprehension effort | Perry & Zorzi (2013) reading model |

```bash
# Compute total cognitive effort for a persona on any URL
npx cbrowser cognitive-effort --url "https://your-site.com" --persona first-timer
```

Returns: total CTC score, per-layer breakdown, bottleneck identification, abandonment risk percentage, and motor accessibility overlay.

---

## Visual Overlays & Attention Analysis (v18.35.0)

Generate visual cognitive narratives showing where users look, what they struggle with, and whether CTAs capture attention:

```bash
# Full visual cognitive story — generates 4 annotated images + narrative
npx cbrowser visual-cognitive-story --url "https://your-site.com" --persona cognitive-adhd

# Attention heatmap — where does this persona look?
npx cbrowser attention-analysis --url "https://your-site.com" --persona first-timer
```

**Overlays generated:**
- **Attention heatmap** — CIE-Lab saliency on grayscale base (red = high attention)
- **Motor accessibility** — Green/yellow/red per element by P(hit)
- **Attention quality** — CTAs green, distractors red, headings blue
- **Comparison diff** — Blue = persona A attention, red = persona B

**Metrics returned:** CTA capture rate, value prop salience, distractor ratio, quality score (0-100), entropy.

---

## Site Knowledge System (v18.30.0)

CBrowser learns your site over time for smarter navigation:

- **Page Understanding** — DOM analysis, page type classification, available affordances
- **Site Model Learning** — Persistent knowledge graph across sessions
- **Cross-Session Profiles** — AES-256-GCM encrypted cookie/state profiles
- **Goal Decomposition** — Sub-goal trees with fallback strategies

```bash
# Check what CBrowser knows about a site
npx cbrowser site-model-status
```

---

## AI Friendliness Suite (v18.20.0)

Five tools to make your site ready for the AI agent era:

| Tool | What It Does |
|------|-------------|
| `agent_ready_audit` | Score site on findability, stability, accessibility, semantics (A-F grade) |
| `ai_benchmark` | Compare AI-friendliness across competitor URLs |
| `webmcp_ready_audit` | Audit MCP server for WebMCP compatibility |
| `remediation_patches` | Generate actionable code fixes for audit findings |
| `llms_txt_generate` | Generate AI-readable llms.txt site description |

```bash
npx cbrowser agent-ready-audit "https://your-site.com" --html
npx cbrowser ai-benchmark "https://site-a.com,https://site-b.com"
```

---

## Geo Proxy (v18.28.0)

Test from 12 global regions via residential proxies for geo-accurate results:

```bash
npx cbrowser cognitive-journey \
  --start "https://your-site.com" \
  --persona first-timer \
  --goal "sign up" \
  --geo-region uk
```

**Available regions:** `us-west`, `us-east`, `us-central`, `uk`, `germany`, `france`, `japan`, `australia`, `brazil`, `india`, `canada`, `singapore`

---

## UX Analysis Suite

### Agent-Ready Audit

Analyze any website for AI-agent friendliness:

```bash
npx cbrowser agent-ready-audit "https://your-site.com" --html
```

Returns:
- **Findability score** — Can agents locate elements? (ARIA labels, semantic HTML)
- **Stability score** — Will selectors break? (hidden inputs, overlays)
- **Letter grade (A-F)** with prioritized remediation and code examples

### Competitive UX Benchmark

Run identical cognitive journeys across your site and competitors:

```bash
npx cbrowser competitive-benchmark \
  --sites "https://your-site.com,https://competitor-a.com,https://competitor-b.com" \
  --goal "sign up for free trial" \
  --persona first-timer \
  --html
```

### Accessibility Empathy Mode

Simulate how users with disabilities experience your site:

```bash
npx cbrowser empathy-audit "https://your-site.com" \
  --goal "complete signup" \
  --disabilities "motor-tremor,low-vision,adhd" \
  --html
```

**Available personas (11 accessibility):** `motor-impairment-tremor`, `low-vision-magnified`, `cognitive-adhd`, `dyslexic-user`, `deaf-user`, `elderly-low-vision`, `color-blind-deuteranopia`, `autism-spectrum`, `intellectual-disability`, `aphasia-receptive`, `dyscalculia`

---

## MCP Server Integration

CBrowser runs as an MCP server for Claude Desktop and claude.ai.

### Remote MCP (claude.ai)

**Public Demo Server** (rate-limited, no auth):
```
https://demo.cbrowser.ai/mcp
```

Deploy your own: see [Remote MCP Server Guide](https://cbrowser.ai/docs/Remote-MCP-Server)

**v18.13.0+:** Screenshots automatically compress to JPEG in remote mode to stay under claude.ai's 200KB tool response limit. Compression is adaptive (quality 85→25, scales down if needed).

### Local MCP (Claude Desktop)

```json
{
  "mcpServers": {
    "cbrowser": {
      "command": "npx",
      "args": ["cbrowser", "mcp-server"]
    }
  }
}
```

### 108 MCP Tools

| Category | Tools | Count |
|----------|-------|-------|
| **Navigation** | `navigate`, `screenshot`, `scroll`, `extract`, `analyze_page`, `find_element_by_intent` | 6 |
| **Interaction** | `click`, `smart_click`, `fill`, `dismiss_overlay` | 4 |
| **Cognitive Core** | `cognitive_journey_init`, `cognitive_journey_update_state`, `cognitive_journey_autonomous`, `cognitive_effort`, `cognitive_load_estimate`, `site_cognitive_assessment` | 6 |
| **Cognitive Transport** | `cognitive_distance`, `cognitive_interpolate`, `cognitive_coverage`, `transport_map` | 4 |
| **Attention & Visual Story** | `attention_analysis`, `attention_compare`, `visual_cognitive_story` | 3 |
| **Persona** | `list_cognitive_personas`, `compare_personas`, `persona_create_*`, `persona_questionnaire_*`, `persona_trait_lookup`, `persona_values_*` | 15 |
| **Testing** | `nl_test_inline`, `nl_test_file`, `generate_tests`, `repair_test`, `detect_flaky_tests`, `coverage_map` | 6 |
| **Visual Testing** | `visual_baseline`, `visual_regression`, `responsive_test`, `cross_browser_test`, `cross_browser_diff`, `ab_comparison` | 6 |
| **Site Intelligence** | `page_understand`, `site_model_query`, `site_model_status`, `site_profile_*` | 6 |
| **AI Friendliness** | `agent_ready_audit`, `ai_benchmark`, `webmcp_ready_audit`, `remediation_patches`, `llms_txt_generate`, `llms_txt_validate`, `llms_txt_diff`, `structured_data_suggest` | 8 |
| **Analysis** | `hunt_bugs`, `chaos_test`, `competitive_benchmark`, `empathy_audit` | 4 |
| **Performance** | `perf_baseline`, `perf_regression` | 2 |
| **Marketing** *(Enterprise)* | `marketing_campaign_*`, `marketing_audience_discover`, `marketing_compete`, `marketing_funnel_analyze`, `marketing_influence_matrix`, `marketing_lever_analysis`, `marketing_personas_list`, `list_influence_patterns` | 11 |
| **Security** | `security_audit`, `web_security_scan` | 2 |
| **Stealth** *(Enterprise)* | `stealth_enable`, `stealth_disable`, `stealth_status`, `stealth_check`, `stealth_diagnose`, `cloudflare_detect`, `cloudflare_wait` | 7 |
| **Session & Browser** | `save_session`, `load_session`, `delete_session`, `list_sessions`, `list_baselines`, `browser_health`, `browser_recover`, `reset_browser`, `heal_stats`, `status` | 10 |
| **Utility** | `assert`, `ask_user`, `set_api_key`, `api_key_status`, `clear_api_key`, `get_api_key_prompt` | 6 |

---

## CI/CD Integration

### GitHub Actions

```yaml
name: CBrowser Tests
on: [pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: alexandriashai/cbrowser@v18
        with:
          test-file: tests/e2e/checkout.txt
          sensitivity: strict
```

### Docker

```bash
docker run --rm -v $(pwd)/tests:/work/tests ghcr.io/alexandriashai/cbrowser:latest \
  test-suite tests/checkout.txt --html
```

---

## Modular Architecture

Tree-shakeable imports for minimal bundle size:

```typescript
// Import specific modules
import { runVisualRegression, runCrossBrowserTest } from 'cbrowser/visual';
import { runNLTestSuite, detectFlakyTests, repairTest } from 'cbrowser/testing';
import { huntBugs, runChaosTest, findElementByIntent } from 'cbrowser/analysis';
import { capturePerformanceBaseline, detectPerformanceRegression } from 'cbrowser/performance';
```

---

## API Reference

```typescript
import { CBrowser } from 'cbrowser';

const browser = new CBrowser({
  headless: true,
  persistent: true,  // Maintain cookies between sessions
});

await browser.navigate('https://example.com');

const result = await browser.smartClick('Sign In', {
  maxRetries: 3,
  minConfidence: 0.8  // v12.0.0: Raised threshold for reliable healing
});

const assertion = await browser.assert("page contains 'Welcome'");
if (!assertion.passed) {
  console.error(assertion.message);
}

await browser.close();
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CBROWSER_DATA_DIR` | `~/.cbrowser` | Data storage directory |
| `CBROWSER_HEADLESS` | `true` | Run headless |
| `CBROWSER_BROWSER` | `chromium` | Browser engine |
| `CBROWSER_TIMEOUT` | `30000` | Default timeout (ms) |
| `CBROWSER_PROXY` | — | Proxy URL (e.g., `http://user:pass@proxy:8080`) |
| `CBROWSER_PROXY_SERVER` | — | Proxy server (alternative to full URL) |
| `CBROWSER_PROXY_USERNAME` | — | Proxy username (with `CBROWSER_PROXY_SERVER`) |
| `CBROWSER_PROXY_PASSWORD` | — | Proxy password (with `CBROWSER_PROXY_SERVER`) |

### API Key (for Cognitive Journeys)

```bash
npx cbrowser config set-api-key
```

### Token Cost & Selective Loading

CBrowser's 108 MCP tools consume approximately **~45,000 tokens** when loaded into an LLM context. For cost-sensitive applications, use selective tool loading:

**Tool Categories (for programmatic use):**

| Category | Tools | Use Case |
|----------|-------|----------|
| `navigation` | navigate, screenshot, scroll | Basic browsing |
| `interaction` | click, fill, smart_click | Form automation |
| `extraction` | extract, analyze_page | Data scraping |
| `assertion` | assert | Testing validation |
| `accessibility` | empathy_audit, hunt_bugs | A11y testing |
| `cognitive` | cognitive_journey_* | User simulation |
| `visual` | visual_baseline, visual_regression | Visual testing |
| `performance` | perf_baseline, perf_regression | Performance monitoring |
| `session` | save_session, load_session | State management |

**Programmatic selective loading:**

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerNavigationTools,
  registerInteractionTools,
  registerExtractionTools,
} from "cbrowser/mcp-tools";

const server = new McpServer({ name: "my-app", version: "1.0.0" });
const context = { getBrowser: () => browser };

// Only load what you need (~5,000 tokens instead of ~38,000)
registerNavigationTools(server, context);
registerInteractionTools(server, context);
registerExtractionTools(server, context);
```

**Full category list:** `navigation`, `interaction`, `extraction`, `assertion`, `analysis`, `session`, `healing`, `visualTesting`, `testing`, `bugAnalysis`, `personaComparison`, `cognitive`, `values`, `performance`, `audit`, `browserManagement`, `security`, `marketing`, `remediation`, `llmsTxt`.

---

## Examples

| Example | Description |
|---------|-------------|
| [`examples/basic-usage.ts`](examples/basic-usage.ts) | Navigation, extraction, sessions |
| [`examples/cognitive-journey.ts`](examples/cognitive-journey.ts) | Cognitive simulation with personas |
| [`examples/visual-testing.ts`](examples/visual-testing.ts) | Visual regression, cross-browser, A/B |
| [`examples/workflows/`](examples/workflows/) | E2E recipes for common scenarios |
| [`examples/ci-cd/`](examples/ci-cd/) | GitHub Actions, GitLab CI setup |

---

## Enterprise Edition

[CBrowser Enterprise](https://github.com/alexandriashai/cbrowser-enterprise) extends CBrowser with:

| Feature | Description |
|---------|-------------|
| **Marketing Suite** | Influence effectiveness research — test which design/copy/UX patterns influence which buyer segments |
| **8 Marketing Personas** | B2B (enterprise-buyer, startup-founder, procurement-manager, technical-evaluator) + Consumer (impulse-shopper, price-researcher, loyal-customer, skeptical-first-timer) |
| **Influence Matrix** | Conversion effectiveness for variant × persona combinations |
| **Lever Analysis** | Which psychological persuasion patterns work for each persona |
| **Constitutional Stealth** | Full stealth measures for authorized penetration testing |

**MCP Server:** Enterprise MCP includes all 108 tools (base + marketing + stealth + web security).

```bash
# Start Enterprise MCP server
npx cbrowser-enterprise mcp-server

# List marketing personas
npx cbrowser-enterprise marketing personas list --category b2b
```

See [Marketing Suite Wiki](https://github.com/alexandriashai/cbrowser/wiki/Marketing-Suite) for full documentation.

---

## License

**MIT License** — Free and open source.

Use, modify, and distribute freely for any purpose, including commercial and production use. See [LICENSE](LICENSE) for full terms.

---

## Copyright

© 2026 Alexandria Eden

Contact: [alexandria.shai.eden@gmail.com](mailto:alexandria.shai.eden@gmail.com)
Website: [cbrowser.ai](https://cbrowser.ai)

---

## Links

- **[📚 Documentation](https://cbrowser.ai/docs)** — Full documentation, guides, and API reference
- [NPM Package](https://www.npmjs.com/package/cbrowser)
- [GitHub Repository](https://github.com/alexandriashai/cbrowser)
- [Issue Tracker](https://github.com/alexandriashai/cbrowser/issues)
- [A+ Assessment Report](https://claude.ai/public/artifacts/0cee560d-60b8-44d6-8eec-e674fbfac9c4)
- [Roadmap](https://cbrowser.ai/docs/Roadmap)

### Research Documentation

- [Research Methodology](https://cbrowser.ai/docs/Research-Methodology) — How 26 traits were selected and validated
- [Trait Index](https://cbrowser.ai/docs/Trait-Index) — All cognitive traits with citations
- [Bibliography](https://cbrowser.ai/docs/Bibliography) — Complete academic references
- [Persona Index](https://cbrowser.ai/docs/Persona-Index) — All 17 cognitive + 8 marketing personas
