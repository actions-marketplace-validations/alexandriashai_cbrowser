/**
 * CBrowser MCP Tools - Main Index
 *
 * Modular tool registration for CBrowser MCP servers.
 *
 * Tool counts by deployment:
 *
 * LOCAL MCP (npx cbrowser mcp-server):
 * - Base tools: 78 (4 marketing as stubs, 3 remediation, 1 ai_benchmark, 2 llms.txt, 1 webmcp_ready)
 * - Persona creation: 7
 * - Ask user: 1
 * - Enterprise stubs: 18
 * - Total: 104 (68 real + 23 stubs)
 *
 * DEMO SERVER (MCP_MODE=demo):
 * - Base tools: 78 (4 marketing real, 3 remediation, 1 ai_benchmark, 2 llms.txt, 1 webmcp_ready)
 * - Persona creation: 7
 * - Ask user: 1
 * - Enterprise stubs: 18
 * - Total: 104 (72 real + 19 stubs)
 *
 * ENTERPRISE (MCP_MODE=enterprise):
 * - All 91 tools fully functional
 *
 * @copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com https://cbrowser.ai
 * @license MIT
 */

// Re-export types
export type { McpServer, CBrowser, ToolRegistrationContext } from "./types.js";

// Re-export screenshot utilities
export {
  setRemoteMode,
  getRemoteMode,
  transformResponseForRemote,
  MAX_RESPONSE_SIZE,
} from "./screenshot-utils.js";

// Re-export base tools
export { registerBaseTools } from "./base/index.js";

// Re-export individual base tool categories for granular use
export {
  registerNavigationTools,
  registerInteractionTools,
  registerExtractionTools,
  registerAssertionTools,
  registerAnalysisTools,
  registerSessionTools,
  registerHealingTools,
  registerVisualTestingTools,
  registerTestingTools,
  registerBugAnalysisTools,
  registerPersonaComparisonTools,
  registerCognitiveTools,
  registerValuesTools,
  registerPerformanceTools,
  registerAuditTools,
  registerBrowserManagementTools,
  registerSecurityTools,
  registerMarketingTools,
  registerRemediationTools,
  registerLlmsTxtTools,
  registerSiteKnowledgeTools,
  registerAdvancedInteractionTools,
  registerBrowserStateTools,
  registerGifTools,
  setSecurityAuditToolList,
} from "./base/index.js";

// Re-export persona creation tools
export { registerPersonaCreationTools } from "./persona-creation-tools.js";

// Re-export ask user tool
export { registerAskUserTool } from "./ask-user-tools.js";

// Re-export enterprise stubs
export { registerEnterpriseStubs } from "./enterprise-stubs.js";

import type { McpServer, ToolRegistrationContext } from "./types.js";
import { registerBaseTools } from "./base/index.js";
import { registerPersonaCreationTools } from "./persona-creation-tools.js";
import { registerAskUserTool } from "./ask-user-tools.js";
import { registerEnterpriseStubs } from "./enterprise-stubs.js";
import { setActiveTier, createGatedServer } from "./tier-gate.js";
import type { PricingTier } from "./tool-categories.js";

// Re-export tier gating
export { setActiveTier, getActiveTier, isToolAccessible, upgradePrompt, createGatedServer, setActiveKeyHash, getActiveKeyHash } from "./tier-gate.js";
export type { PricingTier } from "./tool-categories.js";

/**
 * Register all public npm tools on an MCP server
 *
 * Tool count: 108 tools across all deployments
 *
 * @param server - MCP server instance
 * @param context - Tool registration context with browser access
 * @param pricingTier - User's pricing tier. null = self-hosted (no gating).
 *   'free' = core browser/testing/sessions only. 'pro' = cognitive/visual/personas.
 *   'enterprise' = marketing/stealth/security.
 */
export function registerAllPublicTools(
  server: McpServer,
  context: ToolRegistrationContext,
  pricingTier?: PricingTier | null,
): void {
  // Set active tier for gating (null = self-hosted, no gating)
  setActiveTier(pricingTier ?? null);

  // Wrap server with tier gate proxy (intercepts registerTool calls)
  const gatedServer = createGatedServer(server) as McpServer;

  // Base tools (78)
  registerBaseTools(gatedServer, context);

  // Persona creation tools (7)
  registerPersonaCreationTools(gatedServer);

  // Ask user tool (1)
  registerAskUserTool(gatedServer);

  // Enterprise stubs (18)
  registerEnterpriseStubs(gatedServer);
}
