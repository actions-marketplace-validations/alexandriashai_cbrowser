/**
 * Tier Gating for CBrowser Hosted MCP Server
 *
 * Wraps tool registration so gated tools return upgrade prompts
 * instead of executing. Tools still appear in the tool list so
 * users can discover what's available.
 *
 * Self-hosted (no tier set) = all tools ungated.
 * Hosted demo (free tier) = core browser + testing + sessions only.
 *
 * @since v18.43.0
 */

import { type PricingTier, getToolPricingTier, tierHasAccess } from "./tool-categories.js";

/** The current user tier for this server session */
let currentTier: PricingTier | null = null;

/** Set the active pricing tier. null = self-hosted (no gating). */
export function setActiveTier(tier: PricingTier | null): void {
  currentTier = tier;
}

/** Get the active pricing tier. null = ungated. */
export function getActiveTier(): PricingTier | null {
  return currentTier;
}

/** Check if a tool is accessible at the current tier */
export function isToolAccessible(toolName: string): boolean {
  if (currentTier === null) return true; // Self-hosted: no gating
  const required = getToolPricingTier(toolName);
  return tierHasAccess(currentTier, required);
}

/** Generate upgrade prompt for a gated tool */
export function upgradePrompt(toolName: string): {
  content: Array<{ type: "text"; text: string }>;
} {
  const required = getToolPricingTier(toolName);
  const tierLabel = required.charAt(0).toUpperCase() + required.slice(1);
  const userLabel = currentTier ? currentTier.charAt(0).toUpperCase() + currentTier.slice(1) : "Free";

  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        error: "Upgrade Required",
        tool: toolName,
        currentTier: currentTier || "free",
        requiredTier: required,
        message: `⚡ ${toolName} requires CBrowser ${tierLabel}.\n\nYou're on the ${userLabel} tier. Upgrade to unlock ${toolName} and ${required === 'pro' ? '60+ cognitive analysis tools' : 'marketing suite, stealth, and web security'}.`,
        upgrade: "https://cbrowser.ai/pricing",
        features: required === 'pro'
          ? [
            "Cognitive Transport Chain (6-layer effort analysis)",
            "Attention heatmaps and visual cognitive stories",
            "11 disability persona empathy audits",
            "AI Friendliness Suite (agent-ready, benchmark, remediation)",
            "Custom persona creation (26 traits)",
            "Visual regression and cross-browser testing",
            "Site knowledge and persistent models",
            "Competitive UX benchmarking",
            "Unlimited MCP access",
          ]
          : [
            "Everything in Pro, plus:",
            "Marketing campaign suite (8 buyer personas)",
            "Influence matrix and lever analysis",
            "Constitutional stealth for authorized testing",
            "Geo proxy (12 regions)",
            "Web security scanning",
            "Autonomous cognitive journeys",
            "Self-hosted deployment support",
          ],
      }, null, 2),
    }],
  };
}

/**
 * Get the description prefix for a tool based on its pricing tier.
 * Returns "" for free tools, "[Pro] " or "[Enterprise] " for gated ones.
 */
export function tierPrefix(toolName: string): string {
  if (currentTier === null) return ""; // Self-hosted: no prefixes
  const required = getToolPricingTier(toolName);
  if (required === "free") return "";
  if (required === "pro") return "[Pro] ";
  return "[Enterprise] ";
}

/**
 * Create a proxy around an MCP server that intercepts registerTool calls
 * and wraps handlers with tier gating. Gated tools still register (visible
 * in tool list) but return upgrade prompts when called.
 *
 * If no tier is set (self-hosted), returns the server unchanged.
 */
export function createGatedServer(server: unknown): unknown {
  if (currentTier === null) return server; // Self-hosted: no gating

  const srv = server as {
    registerTool: (name: string, config: Record<string, unknown>, handler: (...args: unknown[]) => unknown) => void;
  };
  const originalRegisterTool = srv.registerTool.bind(srv);

  srv.registerTool = (name: string, config: Record<string, unknown>, handler: (...args: unknown[]) => unknown) => {
    if (isToolAccessible(name)) {
      // User has access — register normally, add tier prefix to description if gated at higher tier
      const prefix = tierPrefix(name);
      if (prefix && typeof config.description === "string") {
        config.description = prefix + config.description;
      }
      originalRegisterTool(name, config, handler);
    } else {
      // User doesn't have access — register with upgrade handler
      const required = getToolPricingTier(name);
      const tierLabel = required.charAt(0).toUpperCase() + required.slice(1);
      const desc = typeof config.description === "string" ? config.description : "";
      originalRegisterTool(
        name,
        { ...config, description: `[${tierLabel}] ${desc}` },
        () => upgradePrompt(name),
      );
    }
  };

  return srv;
}
