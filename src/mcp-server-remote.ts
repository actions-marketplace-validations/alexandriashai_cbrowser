#!/usr/bin/env node
/**
 * CBrowser - Cognitive Browser Automation
 * Copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com
 * Learn more at https://cbrowser.ai - MIT License
 */

/**
 * CBrowser Remote MCP Server
 *
 * HTTP-based MCP server for remote access via claude.ai custom connectors.
 * Uses StreamableHTTPServerTransport for HTTP/SSE communication.
 * Supports OAuth 2.1 via Auth0 for claude.ai integration.
 *
 * Run with: cbrowser mcp-remote
 * Or: npx cbrowser mcp-remote
 * Or: node dist/mcp-server-remote.js
 *
 * Environment variables:
 *   PORT - Port to listen on (default: 3000)
 *   HOST - Host to bind to (default: 0.0.0.0)
 *   MCP_SESSION_MODE - 'stateful' or 'stateless' (default: stateless)
 *   MCP_API_KEY - API key for authentication (optional, if not set server is open)
 *   MCP_API_KEYS - Comma-separated list of valid API keys (optional, alternative to MCP_API_KEY)
 *
 * Auth0 OAuth Environment Variables:
 *   AUTH0_DOMAIN - Your Auth0 tenant domain (e.g., 'your-tenant.auth0.com')
 *   AUTH0_AUDIENCE - API audience/identifier (e.g., 'https://cbrowser-mcp.yourdomain.com')
 *   AUTH0_CLIENT_ID - Optional: Client ID for static registration
 *
 * Rate Limiting Environment Variables:
 *   RATE_LIMIT_ENABLED - Enable IP-based rate limiting (default: false)
 *   RATE_LIMIT_REQUESTS - Max requests per window (default: 5)
 *   RATE_LIMIT_WINDOW_MS - Window size in milliseconds (default: 3600000 = 1 hour)
 *   RATE_LIMIT_WHITELIST - Comma-separated IPs to skip rate limiting
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CBrowser } from "./browser.js";
import { ensureDirectories } from "./config.js";

// Version from package.json - single source of truth
import { VERSION } from "./version.js";

// Stealth/Enterprise loader (v16.2.0)
import {
  type IConstitutionalEnforcer,
  type StealthConfig,
} from "./stealth/index.js";

// Modular MCP tools (v17.5.0)
import { registerAllPublicTools, setRemoteMode, setActiveTier as setTierGate } from "./mcp-tools/index.js";
import type { PricingTier } from "./mcp-tools/tool-categories.js";
import type { ToolRegistrationContext } from "./mcp-tools/types.js";

// Shared browser instance (single Chromium process)
let browser: CBrowser | null = null;

// Stealth state (enterprise integration)
const stealthConfig: Partial<StealthConfig> | null = null;

// ============================================================================
// Tool-Level Session Tokens (v18.33.0)
// Provides browser continuity across tool calls without relying on MCP session
// headers. Works with any MCP client including Claude.ai's proxy.
// ============================================================================

const browserTokens = new Map<string, { sessionId: string; createdAt: number }>();
const TOKEN_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Generate a short browser token that maps to a session's browser.
 */
export function generateBrowserToken(sessionId: string): string {
  // Short readable token
  const token = `cb_${Math.random().toString(36).substring(2, 10)}`;
  browserTokens.set(token, { sessionId, createdAt: Date.now() });
  return token;
}

/**
 * Resolve a browser token to a session's browser.
 * Falls back to creating a new session if token is invalid/expired.
 */
export async function getBrowserByToken(token?: string): Promise<{ browser: CBrowser; token: string }> {
  // Clean expired tokens
  const now = Date.now();
  for (const [t, info] of browserTokens) {
    if (now - info.createdAt > TOKEN_EXPIRY_MS) browserTokens.delete(t);
  }

  // Try to resolve existing token
  if (token) {
    const info = browserTokens.get(token);
    if (info) {
      const session = activeSessions.get(info.sessionId);
      if (session) {
        session.lastActivity = now;
        return { browser: session.browser, token };
      }
      // Session expired but token exists — create new session with same ID
      browserTokens.delete(token);
    }
  }

  // No valid token — create new session
  const sessionId = randomUUID();
  const proxyConfig = stealthConfig?.proxy;
  const sessionBrowser = new CBrowser({
    headless: true,
    persistent: false,
    proxy: proxyConfig,
  });

  activeSessions.set(sessionId, {
    browser: sessionBrowser,
    createdAt: now,
    lastActivity: now,
  });

  const newToken = generateBrowserToken(sessionId);
  console.log(`[Token] New browser session ${sessionId.substring(0, 8)}... → token ${newToken}`);
  return { browser: sessionBrowser, token: newToken };
}

// ============================================================================
// Session Isolation (v18.4.0)
// ============================================================================

const MAX_CONCURRENT_SESSIONS = parseInt(process.env.MAX_CONCURRENT_SESSIONS || "20", 10);
const SESSION_IDLE_TIMEOUT_MS = parseInt(process.env.SESSION_IDLE_TIMEOUT_MS || "300000", 10); // 5 min
const SESSION_MEMORY_LIMIT_MB = parseInt(process.env.SESSION_MEMORY_LIMIT_MB || "800", 10); // 800MB per session

interface SessionInfo {
  browser: CBrowser;
  createdAt: number;
  lastActivity: number;
}

// Active sessions: sessionId -> SessionInfo
const activeSessions = new Map<string, SessionInfo>();

// Track recently expired sessions for clear error messaging
// Sessions stay in this set for 10 minutes after expiry
const expiredSessions = new Map<string, { expiredAt: number; reason: string }>();
const EXPIRED_SESSION_RETENTION_MS = 600000; // 10 min

/**
 * Get or create a session-specific browser instance.
 * Each session gets its own CBrowser with isolated context.
 * If a session expired, transparently create a new one (low-friction reconnect).
 */
async function getSessionBrowser(sessionId: string): Promise<CBrowser> {
  // Check if this session was recently expired - auto-recover by creating new session
  const expiredInfo = expiredSessions.get(sessionId);
  if (expiredInfo) {
    const minutesAgo = Math.round((Date.now() - expiredInfo.expiredAt) / 60000);
    console.log(`[Session] Auto-recovering expired session ${sessionId.substring(0, 8)}... (expired ${minutesAgo}m ago: ${expiredInfo.reason})`);
    // Clear the expired marker so we can create a fresh session
    expiredSessions.delete(sessionId);
    // Fall through to create new session below
  }

  // Check if session already exists
  const existing = activeSessions.get(sessionId);
  if (existing) {
    existing.lastActivity = Date.now();
    return existing.browser;
  }

  // Check concurrent session limit
  if (activeSessions.size >= MAX_CONCURRENT_SESSIONS) {
    throw new Error(
      `🚫 CBrowser Demo Server at Capacity\n\n` +
      `The demo server currently has ${MAX_CONCURRENT_SESSIONS} active sessions.\n\n` +
      `Please tell the user:\n` +
      `"The CBrowser demo server is currently at full capacity. ` +
      `Please wait a few minutes and try again, or visit https://cbrowser.ai/enterprise for unlimited access."\n\n` +
      `Sessions automatically expire after 5 minutes of inactivity.`
    );
  }

  // Create new session with isolated browser context
  const proxyConfig = stealthConfig?.proxy;
  const sessionBrowser = new CBrowser({
    headless: true,
    persistent: false, // Non-persistent = fresh context per session
    proxy: proxyConfig,
  });

  activeSessions.set(sessionId, {
    browser: sessionBrowser,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  });

  console.log(`[Session] Created new session ${sessionId.substring(0, 8)}... (${activeSessions.size}/${MAX_CONCURRENT_SESSIONS} active)`);

  return sessionBrowser;
}

/**
 * Clean up a session's browser context
 * @param reason - Why the session was cleaned up (for user messaging)
 */
async function cleanupSession(sessionId: string, reason: string = "Session ended"): Promise<void> {
  const session = activeSessions.get(sessionId);
  if (session) {
    try {
      await session.browser.close();
    } catch (e) {
      // Ignore cleanup errors
    }
    activeSessions.delete(sessionId);

    // Track as expired so subsequent requests get a clear message
    expiredSessions.set(sessionId, {
      expiredAt: Date.now(),
      reason,
    });

    console.log(`[Session] Cleaned up session ${sessionId.substring(0, 8)}... (${activeSessions.size}/${MAX_CONCURRENT_SESSIONS} active) - ${reason}`);
  }
}

/**
 * Get memory usage of a browser session in MB
 * Returns null if unable to determine
 */
async function getSessionMemoryMB(session: SessionInfo): Promise<number | null> {
  try {
    // CBrowser wraps Playwright - try to get the underlying browser process
    const browserInstance = (session.browser as any).browser;
    if (!browserInstance) return null;

    const browserProcess = browserInstance.process?.();
    if (!browserProcess?.pid) return null;

    // Read /proc/<pid>/status for RSS memory
    const { readFileSync } = await import("node:fs");
    const status = readFileSync(`/proc/${browserProcess.pid}/status`, "utf-8");
    const rssMatch = status.match(/VmRSS:\s+(\d+)\s+kB/);
    if (rssMatch) {
      return Math.round(parseInt(rssMatch[1], 10) / 1024); // Convert kB to MB
    }
  } catch (e) {
    // Process may have exited or not be accessible
  }
  return null;
}

/**
 * Periodic cleanup of idle sessions, memory hogs, and expired session tracking
 */
setInterval(async () => {
  const now = Date.now();

  // Clean up expired session tracking (older than retention period)
  for (const [sessionId, info] of expiredSessions) {
    if (now - info.expiredAt > EXPIRED_SESSION_RETENTION_MS) {
      expiredSessions.delete(sessionId);
    }
  }

  // Check each active session for idle timeout and memory usage
  for (const [sessionId, session] of activeSessions) {
    // Check idle timeout
    if (now - session.lastActivity > SESSION_IDLE_TIMEOUT_MS) {
      const idleSeconds = Math.round((now - session.lastActivity) / 1000);
      console.log(`[Session] Cleaning up idle session ${sessionId.substring(0, 8)}... (idle for ${idleSeconds}s)`);
      await cleanupSession(sessionId, `Idle timeout (inactive for ${idleSeconds}s)`);
      continue;
    }

    // Check memory usage
    const memoryMB = await getSessionMemoryMB(session);
    if (memoryMB !== null && memoryMB > SESSION_MEMORY_LIMIT_MB) {
      console.log(`[Session] Killing session ${sessionId.substring(0, 8)}... (${memoryMB}MB > ${SESSION_MEMORY_LIMIT_MB}MB limit)`);
      await cleanupSession(sessionId, `Memory limit exceeded (${memoryMB}MB used, ${SESSION_MEMORY_LIMIT_MB}MB limit)`);
    }
  }
}, 30000); // Check every 30 seconds (more responsive for memory)

/**
 * Legacy getBrowser for backward compatibility (uses shared instance)
 */
async function getBrowser(): Promise<CBrowser> {
  if (!browser) {
    // Pass proxy configuration from stealth config if available
    const proxyConfig = stealthConfig?.proxy;

    browser = new CBrowser({
      headless: true,
      persistent: true,
      proxy: proxyConfig,
    });
  }
  return browser;
}

// Transport storage for stateful sessions
const transports = new Map<string, StreamableHTTPServerTransport>();

// Auth0 configuration interface
interface Auth0Config {
  domain: string;
  audience: string;
  clientId?: string;
}

// Token cache for Auth0 validation
const tokenCache = new Map<string, { payload: JWTPayload; expiry: number }>();
const TOKEN_CACHE_MARGIN = 60 * 1000; // 1 minute margin before expiry

function getAuth0Config(): Auth0Config | null {
  const domain = process.env.AUTH0_DOMAIN;
  const audience = process.env.AUTH0_AUDIENCE;

  if (!domain || !audience) {
    return null;
  }

  return {
    domain,
    audience,
    clientId: process.env.AUTH0_CLIENT_ID,
  };
}

async function validateAuth0Token(token: string): Promise<JWTPayload | null> {
  const auth0 = getAuth0Config();
  if (!auth0) return null;

  // Check cache first
  const cached = tokenCache.get(token);
  if (cached && cached.expiry > Date.now()) {
    return cached.payload;
  }

  try {
    // Try JWT validation first
    const jwks = createRemoteJWKSet(new URL(`https://${auth0.domain}/.well-known/jwks.json`));

    const { payload } = await jwtVerify(token, jwks, {
      issuer: `https://${auth0.domain}/`,
      audience: auth0.audience,
    });

    // Cache the result
    const exp = payload.exp ? payload.exp * 1000 : Date.now() + 30 * 60 * 1000;
    tokenCache.set(token, {
      payload,
      expiry: exp - TOKEN_CACHE_MARGIN,
    });

    return payload;
  } catch (jwtError) {
    // If JWT validation fails, try opaque token validation via userinfo
    try {
      const userinfoResponse = await fetch(`https://${auth0.domain}/userinfo`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (userinfoResponse.ok) {
        const userinfo = await userinfoResponse.json();
        const payload: JWTPayload = {
          sub: userinfo.sub,
          email: userinfo.email,
          name: userinfo.name,
        };

        // Cache opaque tokens for 30 minutes
        tokenCache.set(token, {
          payload,
          expiry: Date.now() + 30 * 60 * 1000 - TOKEN_CACHE_MARGIN,
        });

        return payload;
      }
    } catch {
      // Opaque token validation also failed
    }

    return null;
  }
}

function getProtectedResourceMetadata(): object | null {
  const auth0 = getAuth0Config();
  if (!auth0) return null;

  return {
    resource: auth0.audience,
    authorization_servers: [`https://${auth0.domain}`],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "profile", "email"],
  };
}

function getApiKeys(): Set<string> | null {
  const singleKey = process.env.MCP_API_KEY;
  const multipleKeys = process.env.MCP_API_KEYS;

  if (!singleKey && !multipleKeys) {
    return null;
  }

  const keys = new Set<string>();

  if (singleKey) {
    keys.add(singleKey);
  }

  if (multipleKeys) {
    for (const key of multipleKeys.split(",")) {
      const trimmed = key.trim();
      if (trimmed) {
        keys.add(trimmed);
      }
    }
  }

  return keys.size > 0 ? keys : null;
}

function validateApiKey(req: IncomingMessage, validKeys: Set<string>): boolean {
  // Check Authorization header (Bearer token)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (validKeys.has(token)) {
      return true;
    }
  }

  // Check X-API-Key header
  const apiKeyHeader = req.headers["x-api-key"];
  if (typeof apiKeyHeader === "string" && validKeys.has(apiKeyHeader)) {
    return true;
  }

  return false;
}

// ============================================================================
// API Key → Tier Resolution (account-based gating)
// ============================================================================

/** OAuth PKCE auth codes (short-lived, 5 min TTL) */
const oauthCodes = new Map<string, { apiKey: string; redirectUri: string; codeChallenge: string; expiresAt: number }>();

/** Cache resolved tiers by API key hash (5-min TTL) */
const tierCache = new Map<string, { tier: PricingTier; expiresAt: number }>();
const TIER_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Extract the raw API key from an incoming HTTP request.
 * Checks Authorization: Bearer and X-API-Key headers.
 */
function extractApiKey(req: IncomingMessage): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  const xApiKey = req.headers["x-api-key"];
  if (typeof xApiKey === "string") return xApiKey;
  return null;
}

/**
 * Resolve the pricing tier for an API key by calling the CMS backend.
 * Returns null for non-cbk keys (server admin keys pass through as-is).
 * Caches results for 5 minutes.
 */
async function resolveApiKeyTier(apiKey: string): Promise<PricingTier | null> {
  // Only resolve cbk_ keys (user account keys)
  if (!apiKey.startsWith("cbk_")) return null;

  // Check cache
  const { createHash } = await import("crypto");
  const keyHash = createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
  const cached = tierCache.get(keyHash);
  if (cached && cached.expiresAt > Date.now()) return cached.tier;

  // Call CMS to validate key and get tier
  const cmsUrl = process.env.CMS_URL || "http://localhost:3200";
  try {
    const res = await fetch(`${cmsUrl}/api/accounts/validate-key`, {
      headers: { "X-API-Key": apiKey },
    });
    if (!res.ok) return "free"; // Invalid key → free tier
    const data = await res.json() as { valid: boolean; tier?: string };
    if (!data.valid) return "free";
    const tier = (data.tier as PricingTier) || "free";
    tierCache.set(keyHash, { tier, expiresAt: Date.now() + TIER_CACHE_TTL_MS });
    return tier;
  } catch {
    // CMS unreachable — fall back to free
    return "free";
  }
}

// ============================================================================
// Rate Limiting (with session tracking and burst allowance)
// ============================================================================

interface RateLimitConfig {
  enabled: boolean;
  maxRequests: number;        // Sustained limit per hour
  windowMs: number;           // Main window (default: 1 hour)
  burstRequests: number;      // Burst limit (first few minutes)
  burstWindowMs: number;      // Burst window (default: 5 minutes)
  whitelist: Set<string>;
}

interface RateLimitEntry {
  requests: number[];         // Timestamps of all requests
  sessionStart: number;       // When this session/IP first appeared
}

// Rate limit storage: key (session or IP) -> entry
const rateLimitStore = new Map<string, RateLimitEntry>();

function getRateLimitConfig(): RateLimitConfig {
  const enabled = process.env.RATE_LIMIT_ENABLED === "true";
  const maxRequests = parseInt(process.env.RATE_LIMIT_REQUESTS || "30", 10);
  const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "3600000", 10);
  const burstRequests = parseInt(process.env.RATE_LIMIT_BURST || "15", 10);
  const burstWindowMs = parseInt(process.env.RATE_LIMIT_BURST_WINDOW_MS || "300000", 10);
  const whitelistStr = process.env.RATE_LIMIT_WHITELIST || "";

  const whitelist = new Set<string>();
  for (const ip of whitelistStr.split(",")) {
    const trimmed = ip.trim();
    if (trimmed) {
      whitelist.add(trimmed);
    }
  }

  return { enabled, maxRequests, windowMs, burstRequests, burstWindowMs, whitelist };
}

function getClientIP(req: IncomingMessage): string {
  // Check X-Forwarded-For header (behind proxy/load balancer)
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    // Take the first IP in the chain (original client)
    return forwarded.split(",")[0].trim();
  }

  // Check X-Real-IP header (nginx)
  const realIp = req.headers["x-real-ip"];
  if (typeof realIp === "string") {
    return realIp.trim();
  }

  // Fall back to socket remote address
  return req.socket.remoteAddress || "unknown";
}

function getRateLimitKey(req: IncomingMessage): string {
  // Prefer MCP session ID for per-session tracking
  const sessionId = req.headers["mcp-session-id"];
  if (typeof sessionId === "string" && sessionId.length > 0) {
    return `session:${sessionId}`;
  }

  // Fall back to IP-based tracking
  return `ip:${getClientIP(req)}`;
}

function checkRateLimit(
  req: IncomingMessage,
  config: RateLimitConfig
): { allowed: boolean; remaining: number; resetTime: number; burstRemaining?: number } {
  if (!config.enabled) {
    return { allowed: true, remaining: config.maxRequests, resetTime: 0 };
  }

  const ip = getClientIP(req);

  // Skip rate limiting for whitelisted IPs
  if (config.whitelist.has(ip)) {
    return { allowed: true, remaining: config.maxRequests, resetTime: 0 };
  }

  const key = getRateLimitKey(req);
  const now = Date.now();
  const windowStart = now - config.windowMs;
  const burstWindowStart = now - config.burstWindowMs;

  // Get or create entry
  let entry = rateLimitStore.get(key);
  if (!entry) {
    entry = { requests: [], sessionStart: now };
    rateLimitStore.set(key, entry);
  }

  // Filter out requests outside the main window
  entry.requests = entry.requests.filter(timestamp => timestamp > windowStart);

  // Count requests in burst window
  const burstRequests = entry.requests.filter(timestamp => timestamp > burstWindowStart).length;

  // Check if within burst period (first burstWindowMs of session)
  const inBurstPeriod = (now - entry.sessionStart) < config.burstWindowMs;

  // Determine current limit based on burst period
  let currentLimit: number;
  let currentWindowRequests: number;

  if (inBurstPeriod) {
    // During burst period: use burst limit
    currentLimit = config.burstRequests;
    currentWindowRequests = burstRequests;
  } else {
    // After burst period: use sustained limit
    currentLimit = config.maxRequests;
    currentWindowRequests = entry.requests.length;
  }

  // Calculate remaining requests
  const remaining = Math.max(0, currentLimit - currentWindowRequests);

  // Calculate reset time
  const resetTime = entry.requests.length > 0
    ? entry.requests[0] + config.windowMs
    : now + config.windowMs;

  if (currentWindowRequests >= currentLimit) {
    // Rate limit exceeded
    return {
      allowed: false,
      remaining: 0,
      resetTime,
      burstRemaining: inBurstPeriod ? 0 : undefined,
    };
  }

  // Allow request and record it
  entry.requests.push(now);

  return {
    allowed: true,
    remaining: remaining - 1,
    resetTime,
    burstRemaining: inBurstPeriod ? Math.max(0, config.burstRequests - burstRequests - 1) : undefined,
  };
}

// Cleanup old rate limit entries periodically (every 10 minutes)
setInterval(() => {
  const now = Date.now();
  const config = getRateLimitConfig();

  for (const [key, entry] of rateLimitStore.entries()) {
    // Filter out old requests
    entry.requests = entry.requests.filter(t => t > now - config.windowMs);

    // Remove entry if no requests and session is old (2x window)
    const sessionAge = now - entry.sessionStart;
    if (entry.requests.length === 0 && sessionAge > config.windowMs * 2) {
      rateLimitStore.delete(key);
    }
  }
}, 10 * 60 * 1000);

async function validateAuth(
  req: IncomingMessage,
  apiKeys: Set<string> | null,
  auth0Enabled: boolean
): Promise<{ valid: boolean; reason?: string }> {
  // Try API key first (faster)
  if (apiKeys && validateApiKey(req, apiKeys)) {
    return { valid: true };
  }

  // Try Auth0 if enabled
  if (auth0Enabled) {
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice(7);
      const payload = await validateAuth0Token(token);
      if (payload) {
        return { valid: true };
      }
    }
  }

  return { valid: false, reason: "Invalid or missing authentication" };
}

function sendUnauthorized(res: ServerResponse, message?: string): void {
  const auth0 = getAuth0Config();
  let wwwAuth = "Bearer";

  if (auth0) {
    wwwAuth = `Bearer realm="cbrowser-mcp", authorization_uri="https://${auth0.domain}/authorize", token_uri="https://${auth0.domain}/oauth/token"`;
  }

  res.writeHead(401, {
    "Content-Type": "application/json",
    "WWW-Authenticate": wwwAuth,
  });
  res.end(JSON.stringify({
    error: "Unauthorized",
    message: message || "Valid authentication required. Use Authorization: Bearer <token>",
    ...(auth0 && {
      auth0_domain: auth0.domain,
      authorization_endpoint: `https://${auth0.domain}/authorize`,
      token_endpoint: `https://${auth0.domain}/oauth/token`,
    }),
  }));
}

/**
 * Configure all CBrowser tools on an MCP server instance.
 * This is shared between stdio and HTTP transports.
 *
 * @param sessionId - Optional session ID for session isolation
 */
function configureMcpTools(
  server: McpServer,
  customRegisterTools?: (server: McpServer, context: ToolRegistrationContext) => void | Promise<void>,
  sessionId?: string,
  resolvedTier?: PricingTier | null,
): void {
  // Create session-aware getBrowser function
  const sessionGetBrowser = sessionId
    ? () => getSessionBrowser(sessionId)
    : getBrowser;

  const context: ToolRegistrationContext = { getBrowser: sessionGetBrowser, getBrowserByToken };

  // Tier priority: resolved from API key > CBROWSER_TIER env > null (self-hosted, no gating)
  const tier = resolvedTier ?? (process.env.CBROWSER_TIER as PricingTier | undefined) ?? null;

  if (customRegisterTools) {
    // Set tier BEFORE custom registration so createGatedServer uses resolved tier
    setTierGate(tier);
    customRegisterTools(server, context);
  } else {
    registerAllPublicTools(server, context, tier);
  }
}

/**
 * Create a configured MCP server instance
 *
 * @param customRegisterTools - Optional custom tool registration
 * @param sessionId - Optional session ID for session isolation
 */
function createMcpServer(
  customRegisterTools?: (server: McpServer, context: ToolRegistrationContext) => void | Promise<void>,
  sessionId?: string,
  resolvedTier?: PricingTier | null,
): McpServer {
  const server = new McpServer(
    {
      name: "cbrowser",
      title: "CBrowser — Cognitive Browser Automation",
      version: VERSION,
      description: "AI-powered browser automation with cognitive user simulation. 105 MCP tools for navigation, visual testing, accessibility auditing, persona-based testing, site knowledge learning, and security scanning. Simulates how real humans think, struggle, and give up on your site.",
      websiteUrl: "https://cbrowser.ai",
      icons: [{ src: "https://cbrowser.ai/favicon.ico", sizes: ["32x32"] }],
    },
    {
      capabilities: {
        tools: { listChanged: true },
        prompts: {},
        resources: {},
      },
      instructions: `CBrowser — cognitive browser automation with 107 tools across 16 categories.

CORE TOOLS (use these first):
• navigate, click, fill, scroll, screenshot, extract — browser control
• agent_ready_audit — AI-friendliness score (A-F grade)
• empathy_audit — disability barrier detection
• cognitive_effort — 6-layer cognitive transport cost per persona
• site_cognitive_assessment — 3-gate pipeline (bot detection → qualification → persona analysis)
• page_understand — page type, affordances, structure
• cognitive_journey_init/update_state — persona journey simulation
• security_audit — MCP tool injection scanning

SPECIALIST CATEGORIES (use when the task requires them):
• visual_testing (9 tools) — visual_baseline, visual_regression, cross_browser_test, responsive_test, ab_comparison, transport_map, attention_analysis...
• cognitive_transport (7 tools) — cognitive_distance, cognitive_coverage, cognitive_interpolate, cognitive_load_estimate, compare_personas...
• testing (5 tools) — nl_test_inline, nl_test_file, detect_flaky_tests, coverage_map, repair_test
• site_knowledge (5 tools) — site_model_status, site_model_query, site_profile_list/delete/status
• bug_hunting (3 tools) — hunt_bugs, chaos_test, competitive_benchmark
• performance (3 tools) — perf_baseline, perf_regression, list_baselines
• sessions (4 tools) — save_session, load_session, list_sessions, delete_session
• marketing (4 tools) — marketing_campaign_create/run/report, marketing_personas_list
• persona_creation (6 tools) — persona_create_start, questionnaire, from_description
• enterprise_security (8 tools) — web_security_scan, stealth_enable/disable/check, cloudflare_detect/wait
• enterprise_marketing (6 tools) — marketing_influence_matrix, lever_analysis, funnel_analyze, audience_discover

TIPS:
• Pass _browserToken between tool calls to maintain browser state
• Use site_cognitive_assessment for comprehensive site analysis (runs all gates automatically)
• For disability testing, pass one persona at a time to empathy_audit to avoid timeouts`,
    }
  );

  // Register prompts for common workflows
  server.prompt(
    "audit-site",
    "Run a comprehensive site audit with empathy, agent-readiness, and visual baseline",
    async () => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: "Please run a comprehensive audit on this site:\n1. Run agent_ready_audit to check AI-friendliness\n2. Run empathy_audit with persona \"cognitive-adhd\" to test accessibility\n3. Run page_understand to analyze the page structure\n4. Summarize the findings with recommendations",
        },
      }],
    })
  );

  server.prompt(
    "cognitive-journey",
    "Simulate a user journey with a specific persona and goal",
    async () => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: "Start a cognitive journey simulation. Ask me for:\n1. The URL to test\n2. Which persona to use (first-timer, elderly-user, power-user, etc.)\n3. The goal to accomplish\n\nThen use cognitive_journey_init and simulate step by step.",
        },
      }],
    })
  );

  server.prompt(
    "security-scan",
    "Run a security scan on an authorized domain",
    async () => ({
      messages: [{
        role: "user" as const,
        content: {
          type: "text" as const,
          text: "Run a security scan. Ask me for the URL to scan, then use web_security_scan with confirm_authorized=true. Also run security_audit to check MCP tool definitions. Summarize all findings.",
        },
      }],
    })
  );

  // Register resources
  server.resource(
    "docs://tools-overview",
    "docs://tools-overview",
    { description: "Overview of all 105 CBrowser MCP tools organized by category", mimeType: "text/plain" },
    async () => ({
      contents: [{
        uri: "docs://tools-overview",
        text: "CBrowser provides 105 MCP tools across 11 categories: Browser Automation, Visual Testing, Cognitive Journeys, Site Knowledge, Accessibility, Persona System, Testing, Performance, Security, Session Management, and Marketing. Visit https://cbrowser.ai/docs/Tools-Overview for the complete reference.",
        mimeType: "text/plain",
      }],
    })
  );

  server.resource(
    "docs://personas",
    "docs://personas",
    { description: "List of 21 built-in personas with cognitive traits", mimeType: "text/plain" },
    async () => ({
      contents: [{
        uri: "docs://personas",
        text: "CBrowser includes 21 personas: Cognitive (7): power-user, first-timer, mobile-user, elderly-user, impatient-user, impatient-explorer, screen-reader-user. Accessibility (11): motor-impairment-tremor, low-vision-magnified, cognitive-adhd, dyslexic-user, deaf-user, elderly-low-vision, color-blind-deuteranopia, autism-spectrum, intellectual-disability, aphasia-receptive, dyscalculia. Each persona has 26 cognitive traits. Visit https://cbrowser.ai/docs/Persona-Index for details.",
        mimeType: "text/plain",
      }],
    })
  );

  configureMcpTools(server, customRegisterTools, sessionId, resolvedTier);
  return server;
}

/**
 * Handle incoming HTTP MCP request
 */
async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  transport: StreamableHTTPServerTransport
): Promise<void> {
  const start = Date.now();

  // Fix Accept header for clients that don't properly set it (e.g., Claude.ai custom connectors)
  // The MCP SDK requires "application/json, text/event-stream" but some clients omit this
  // We must modify both headers object AND rawHeaders array since @hono/node-server may read either
  const acceptHeader = req.headers.accept || "";
  if (!acceptHeader.includes("text/event-stream")) {
    const fixedAccept = "application/json, text/event-stream";
    req.headers.accept = fixedAccept;
    // Also fix rawHeaders array (Hono may read from this)
    const acceptIdx = req.rawHeaders.findIndex(h => h.toLowerCase() === "accept");
    if (acceptIdx >= 0) {
      req.rawHeaders[acceptIdx + 1] = fixedAccept;
    } else {
      req.rawHeaders.push("Accept", fixedAccept);
    }
  }

  // Parse body for POST requests
  if (req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks).toString("utf-8");

    // Safely parse JSON - reject malformed requests gracefully
    let parsedBody: Record<string, unknown> | undefined;
    try {
      parsedBody = body ? JSON.parse(body) : undefined;
    } catch (parseError) {
      console.error(`Invalid JSON in request body: ${(parseError as Error).message}`);
      console.error(`Body preview: ${body.substring(0, 100)}...`);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32700,
          message: "Parse error: Invalid JSON in request body",
        },
        id: null,
      }));
      return;
    }

    // Log request details
    const method = (parsedBody?.method as string) || "unknown";
    let logLine = `← ${method}`;
    const params = parsedBody?.params as Record<string, unknown> | undefined;
    if (method === "tools/call" && params?.name) {
      logLine += ` [${params.name}]`;
    }
    if (method === "notifications/initialized") {
      logLine = `← session initialized`;
    }

    // Add connection close handler to detect early disconnects
    let connectionClosed = false;

    req.on("close", () => {
      if (!res.writableEnded) {
        connectionClosed = true;
        console.warn(`[Connection Closed] Client disconnected before response completed: ${logLine}`);
      }
    });

    // Debug: log session ID from client
    const clientSessionId = req.headers["mcp-session-id"] as string | undefined;
    if (method !== "initialize" && method !== "notifications/initialized") {
      console.log(`[Session Debug] ${method}: client sent session=${clientSessionId?.substring(0, 8) || "NONE"}, mode=${process.env.MCP_SESSION_MODE || "stateless"}`);
    }

    await transport.handleRequest(req, res, parsedBody);

    const duration = Date.now() - start;
    if (!connectionClosed) {
      console.log(`${logLine} → ${res.statusCode} (${duration}ms)`);
    }
  } else {
    // GET requests (SSE streams)
    let connectionClosed = false;

    req.on("close", () => {
      if (!res.writableEnded) {
        connectionClosed = true;
        console.warn(`[Connection Closed] Client disconnected before response completed: GET`);
      }
    });

    await transport.handleRequest(req, res);

    const duration = Date.now() - start;
    if (!connectionClosed) {
      console.log(`← ${req.method} → ${res.statusCode} (${duration}ms)`);
    }
  }
}

/**
 * Options for starting the remote MCP server
 */
export interface RemoteMcpServerOptions {
  /** Callback to register additional tools after base tools are configured */
  extendServer?: (server: McpServer) => void | Promise<void>;
  /** Custom server name (default: "cbrowser") */
  serverName?: string;
  /**
   * Custom tool registration function. If provided, replaces the default
   * registerAllPublicTools call. Use this for Enterprise servers that need
   * different tool compositions.
   */
  registerTools?: (server: McpServer, context: ToolRegistrationContext) => void | Promise<void>;
  /**
   * HTML content to serve on GET / requests.
   * If provided, GET / serves this homepage while POST / handles MCP.
   * If not provided, both GET and POST / go to MCP endpoint.
   */
  homepageHtml?: string;
}

// Re-export for enterprise use
export type { ToolRegistrationContext };

/**
 * Start the remote HTTP MCP server
 * @param options - Optional configuration including tool extension callback
 */
export async function startRemoteMcpServer(options?: RemoteMcpServerOptions): Promise<void> {
  // Auto-initialize all data directories on server start
  ensureDirectories();

  // Enable remote mode for screenshot handling (returns base64 images instead of paths)
  setRemoteMode(true);

  const port = parseInt(process.env.PORT || "3000", 10);
  const host = process.env.HOST || "0.0.0.0";
  const sessionMode = process.env.MCP_SESSION_MODE || "stateless";
  const apiKeys = getApiKeys();
  const auth0 = getAuth0Config();
  const apiKeyAuthEnabled = apiKeys !== null && apiKeys.size > 0;
  const auth0Enabled = auth0 !== null;
  const authEnabled = apiKeyAuthEnabled || auth0Enabled;
  const rateLimitConfig = getRateLimitConfig();

  console.log(`Starting CBrowser Remote MCP Server v${VERSION}...`);
  console.log(`Mode: ${sessionMode}`);
  console.log(`Auth: ${authEnabled ? "enabled" : "disabled (open access)"}`);
  if (apiKeyAuthEnabled) {
    console.log(`  - API Key auth: enabled (${apiKeys?.size} keys)`);
  }
  if (auth0Enabled) {
    console.log(`  - Auth0 OAuth: enabled (${auth0?.domain})`);
  }
  console.log(`Session Isolation: enabled`);
  console.log(`  - Max concurrent sessions: ${MAX_CONCURRENT_SESSIONS}`);
  console.log(`  - Idle timeout: ${SESSION_IDLE_TIMEOUT_MS / 1000}s`);
  console.log(`  - Memory limit per session: ${SESSION_MEMORY_LIMIT_MB}MB`);
  if (rateLimitConfig.enabled) {
    console.log(`Rate Limiting: enabled`);
    console.log(`  - Sustained: ${rateLimitConfig.maxRequests} requests per ${rateLimitConfig.windowMs / 1000 / 60} min`);
    console.log(`  - Burst: ${rateLimitConfig.burstRequests} requests in first ${rateLimitConfig.burstWindowMs / 1000 / 60} min`);
    console.log(`  - Tracking: per-session (falls back to IP)`);
    if (rateLimitConfig.whitelist.size > 0) {
      console.log(`  - Whitelisted IPs: ${Array.from(rateLimitConfig.whitelist).join(", ")}`);
    }
  }
  console.log(`Listening on ${host}:${port}`);

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    // Security headers (defense in depth)
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");

    // CORS headers for all responses
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, X-API-Key, X-Signature, X-Timestamp, X-Nonce");
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // =====================================================================
    // OAuth 2.1 PKCE Flow (for claude.ai custom MCP connectors)
    // =====================================================================

    // In-memory auth code store (short-lived, 5 min TTL)

    // GET /authorize — show login form
    if (url.pathname === "/authorize" && req.method === "GET") {
      const clientId = url.searchParams.get("client_id") || "";
      const redirectUri = url.searchParams.get("redirect_uri") || "";
      const state = url.searchParams.get("state") || "";
      const codeChallenge = url.searchParams.get("code_challenge") || "";
      const codeChallengeMethod = url.searchParams.get("code_challenge_method") || "";

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CBrowser — Sign In</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0a0a0a; color: #e5e5e5; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
  .card { background: #1a1a1a; border: 1px solid #333; border-radius: 12px; padding: 32px; width: 100%; max-width: 400px; }
  h1 { font-size: 24px; margin: 0 0 8px; background: linear-gradient(to right, #3b82f6, #06b6d4); -webkit-background-clip: text; background-clip: text; color: transparent; }
  p { color: #888; font-size: 14px; margin: 0 0 24px; }
  label { display: block; font-size: 13px; color: #aaa; margin-bottom: 6px; }
  input { width: 100%; padding: 10px 12px; background: #0a0a0a; border: 1px solid #333; border-radius: 8px; color: #e5e5e5; font-size: 14px; margin-bottom: 16px; box-sizing: border-box; }
  input:focus { outline: none; border-color: #3b82f6; }
  button { width: 100%; padding: 12px; background: linear-gradient(135deg, #3b82f6, #06b6d4); color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; }
  button:hover { opacity: 0.9; }
  .error { background: #3b1111; border: 1px solid #7f1d1d; color: #fca5a5; padding: 10px; border-radius: 8px; font-size: 13px; margin-bottom: 16px; display: none; }
  .register { text-align: center; margin-top: 16px; font-size: 13px; color: #666; }
  .register a { color: #3b82f6; text-decoration: none; }
</style></head><body>
<div class="card">
  <h1>CBrowser</h1>
  <p>Sign in to connect your account to Claude</p>
  <div class="error" id="error"></div>
  <form id="form" method="POST" action="/authorize">
    <input type="hidden" name="redirect_uri" value="${redirectUri.replace(/"/g, '&quot;')}">
    <input type="hidden" name="state" value="${state.replace(/"/g, '&quot;')}">
    <input type="hidden" name="code_challenge" value="${codeChallenge.replace(/"/g, '&quot;')}">
    <input type="hidden" name="code_challenge_method" value="${codeChallengeMethod.replace(/"/g, '&quot;')}">
    <input type="hidden" name="client_id" value="${clientId.replace(/"/g, '&quot;')}">
    <label for="email">Email</label>
    <input type="email" id="email" name="email" required autofocus placeholder="you@example.com">
    <label for="password">Password</label>
    <input type="password" id="password" name="password" required placeholder="Password">
    <button type="submit">Sign In &amp; Authorize</button>
  </form>
  <div class="register">No account? <a href="https://cbrowser.ai/account/register" target="_blank">Create one free</a></div>
</div>
<script>
document.getElementById('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const body = new URLSearchParams();
  f.forEach((v, k) => body.append(k, v));
  const res = await fetch('/authorize', { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  if (res.status === 302 || res.status === 303) {
    window.location.href = res.headers.get('Location') || '/';
  } else {
    const data = await res.json().catch(() => ({ error: 'Login failed' }));
    const err = document.getElementById('error');
    err.textContent = data.error || 'Login failed';
    err.style.display = 'block';
  }
});
</script>
</body></html>`);
      return;
    }

    // POST /authorize — validate credentials, issue code, redirect
    if (url.pathname === "/authorize" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      const email = params.get("email") || "";
      const password = params.get("password") || "";
      const redirectUri = params.get("redirect_uri") || "";
      const state = params.get("state") || "";
      const codeChallenge = params.get("code_challenge") || "";

      if (!email || !password) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Email and password required" }));
        return;
      }

      // Validate against CMS
      const cmsUrl = process.env.CMS_URL || "http://localhost:3200";
      try {
        const loginRes = await fetch(`${cmsUrl}/api/accounts/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });

        if (!loginRes.ok) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid email or password" }));
          return;
        }

        const loginData = await loginRes.json() as { token: string; account: { id: number; tier: string } };

        // Generate or get API key for this account
        const keyRes = await fetch(`${cmsUrl}/api/accounts/keys?name=Claude+MCP`, {
          method: "POST",
          headers: { Authorization: `Bearer ${loginData.token}` },
        });
        const keyData = await keyRes.json() as { key?: string; error?: string };
        const apiKey = keyData.key || "";

        if (!apiKey) {
          // May have hit max keys — get existing
          const meRes = await fetch(`${cmsUrl}/api/accounts/me`, {
            headers: { Authorization: `Bearer ${loginData.token}` },
          });
          const meData = await meRes.json() as { apiKeys?: Array<{ key_prefix: string }> };
          // Can't recover full key — user needs to use existing one
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Max API keys reached. Delete an unused key at cbrowser.ai/account" }));
          return;
        }

        // Generate auth code
        const code = randomUUID();
        oauthCodes.set(code, {
          apiKey,
          redirectUri,
          codeChallenge,
          expiresAt: Date.now() + 5 * 60 * 1000,
        });

        // Redirect back to Claude with auth code
        const callbackUrl = new URL(redirectUri);
        callbackUrl.searchParams.set("code", code);
        callbackUrl.searchParams.set("state", state);

        res.writeHead(303, { Location: callbackUrl.toString() });
        res.end();
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Authentication service unavailable" }));
      }
      return;
    }

    // POST /token — exchange auth code for API key (bearer token)
    if (url.pathname === "/token" && req.method === "POST") {
      let body = "";
      for await (const chunk of req) body += chunk;

      let params: URLSearchParams;
      if (body.startsWith("{")) {
        const json = JSON.parse(body);
        params = new URLSearchParams(json);
      } else {
        params = new URLSearchParams(body);
      }

      const grantType = params.get("grant_type");
      const code = params.get("code") || "";
      const codeVerifier = params.get("code_verifier") || "";

      if (grantType !== "authorization_code") {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "unsupported_grant_type" }));
        return;
      }

      const stored = oauthCodes.get(code);
      if (!stored || stored.expiresAt < Date.now()) {
        oauthCodes.delete(code);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant", error_description: "Code expired or invalid" }));
        return;
      }

      // Verify PKCE code_verifier against stored code_challenge
      if (stored.codeChallenge && codeVerifier) {
        const { createHash } = await import("crypto");
        const computed = createHash("sha256").update(codeVerifier).digest("base64url");
        if (computed !== stored.codeChallenge) {
          oauthCodes.delete(code);
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "invalid_grant", error_description: "PKCE verification failed" }));
          return;
        }
      }

      // Success — return the API key as bearer token
      oauthCodes.delete(code);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        access_token: stored.apiKey,
        token_type: "Bearer",
        expires_in: 2592000, // 30 days
      }));
      return;
    }

    // =====================================================================
    // Public Endpoints (no auth required)
    // =====================================================================

    // Health check endpoint
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        version: VERSION,
        auth: authEnabled,
        auth_methods: {
          api_key: apiKeyAuthEnabled,
          oauth: auth0Enabled,
        },
      }));
      return;
    }

    // Server info endpoint
    if (url.pathname === "/info") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        name: "cbrowser",
        version: VERSION,
        description: "Cognitive Browser - AI-powered browser automation with constitutional safety",
        mcp_endpoint: "/mcp",
        auth_required: authEnabled,
        auth_methods: {
          api_key: apiKeyAuthEnabled,
          oauth: auth0Enabled ? {
            domain: auth0?.domain,
            authorization_endpoint: `https://${auth0?.domain}/authorize`,
            token_endpoint: `https://${auth0?.domain}/oauth/token`,
          } : false,
        },
        capabilities: ["navigation", "interaction", "visual-testing", "nlp-testing", "performance"],
      }));
      return;
    }

    // llms.txt - AI-readable documentation (WebMCP standard)
    if (url.pathname === "/llms.txt" || url.pathname === "/.well-known/llms.txt") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(`# CBrowser MCP Server
# AI-powered browser automation with cognitive user simulation

> CBrowser is an MCP server that provides 91 tools for browser automation,
> visual testing, cognitive user simulation, and accessibility auditing.
> It simulates how real humans think, struggle, and give up on websites.

## MCP Endpoint
POST /mcp - Model Context Protocol endpoint (JSON-RPC 2.0 over SSE)

## Key Capabilities
- navigate: Open URLs and take screenshots
- click, fill: Interact with page elements using natural language
- screenshot: Capture current page state
- cognitive_journey_init: Simulate real users with patience/frustration tracking
- empathy_audit: Test with disability personas (motor tremor, low vision, ADHD)
- agent_ready_audit: Grade site AI-friendliness (A+ to F)
- hunt_bugs: Autonomous bug discovery
- visual_baseline, visual_regression: AI-powered visual testing
- compare_personas: Test with multiple user types simultaneously

## Authentication
- OAuth 2.1 with PKCE for claude.ai integration
- API Key authentication for programmatic access
- Demo server (demo.cbrowser.ai): Rate-limited, no auth required

## Tool Categories (91 tools)
- Navigation (1): navigate
- Interaction (5): click, smart_click, fill, scroll, press_key
- Analysis (4): analyze_page, extract, find_element_by_intent, assert
- Visual Testing (6): visual_baseline, visual_regression, cross_browser_test, responsive_test, ab_comparison
- Cognitive (3): cognitive_journey_init, cognitive_journey_update_state, list_cognitive_personas
- Personas (10): compare_personas_init, persona_create, persona_traits_list, etc.
- Testing (5): nl_test_file, nl_test_inline, repair_test, detect_flaky_tests, coverage_map
- Audit (4): agent_ready_audit, competitive_benchmark, empathy_audit, webmcp_ready_audit
- Session (4): save_session, load_session, list_sessions, delete_session
- Browser (4): browser_health, browser_recover, reset_browser, status

## Links
- Documentation: https://cbrowser.ai/docs
- GitHub: https://github.com/alexandriashai/cbrowser
- npm: https://npmjs.com/package/cbrowser

## Version
${VERSION}
`);
      return;
    }

    // Documentation endpoint
    if (url.pathname === "/docs" || url.pathname === "/README") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CBrowser MCP Server Documentation</title>
  <style>
    body { font-family: -apple-system, system-ui, sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; background: #0a0a0a; color: #e5e5e5; }
    h1 { color: #fff; }
    h2 { color: #3b82f6; border-bottom: 1px solid #333; padding-bottom: 8px; }
    code { background: #1e1e1e; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
    pre { background: #1e1e1e; padding: 16px; border-radius: 8px; overflow-x: auto; }
    a { color: #60a5fa; }
    .badge { display: inline-block; background: #3b82f6; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px; margin-right: 8px; }
  </style>
</head>
<body>
  <h1>CBrowser MCP Server <span class="badge">v${VERSION}</span></h1>
  <p>AI-powered browser automation with cognitive user simulation.</p>

  <h2>Quick Start</h2>
  <p>Connect to this MCP server from Claude Desktop or claude.ai:</p>
  <pre><code># Claude Desktop config
{
  "mcpServers": {
    "cbrowser": {
      "command": "npx",
      "args": ["cbrowser", "mcp-server"]
    }
  }
}</code></pre>

  <h2>Available Tools (91)</h2>
  <p>This server provides 91 MCP tools for browser automation, testing, and analysis.</p>
  <ul>
    <li><strong>Navigation:</strong> navigate, screenshot</li>
    <li><strong>Interaction:</strong> click, smart_click, fill, scroll, press_key</li>
    <li><strong>Cognitive:</strong> cognitive_journey_init, compare_personas, empathy_audit</li>
    <li><strong>Visual Testing:</strong> visual_baseline, visual_regression, cross_browser_test</li>
    <li><strong>Analysis:</strong> hunt_bugs, agent_ready_audit, chaos_test</li>
  </ul>

  <h2>Links</h2>
  <ul>
    <li><a href="https://cbrowser.ai/docs">Full Documentation</a></li>
    <li><a href="https://github.com/alexandriashai/cbrowser">GitHub Repository</a></li>
    <li><a href="https://npmjs.com/package/cbrowser">npm Package</a></li>
    <li><a href="/llms.txt">llms.txt (AI-readable docs)</a></li>
    <li><a href="/info">Server Info (JSON)</a></li>
    <li><a href="/health">Health Check</a></li>
  </ul>

  <h2>Authentication</h2>
  <p>Demo server: No authentication required (rate-limited)</p>
  <p>Self-hosted: Supports OAuth 2.1 and API Key authentication</p>
</body>
</html>`);
      return;
    }

    // Protected Resource Metadata (RFC 9728) - required for OAuth
    // OAuth Authorization Server Metadata (RFC 8414)
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      const serverHost = req.headers.host || `${host}:${port}`;
      const protocol = req.headers["x-forwarded-proto"] || "http";
      const baseUrl = `${protocol}://${serverHost}`;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        issuer: baseUrl,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      }));
      return;
    }

    if (url.pathname === "/.well-known/oauth-protected-resource") {
      const metadata = getProtectedResourceMetadata();
      if (metadata) {
        // Full OAuth configured
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(metadata));
      } else {
        // Built-in OAuth PKCE — advertise our own authorize/token endpoints
        const serverHost = req.headers.host || `${host}:${port}`;
        const protocol = req.headers["x-forwarded-proto"] || "http";
        const baseUrl = `${protocol}://${serverHost}`;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          resource: baseUrl,
          authorization_servers: [baseUrl],
          bearer_methods_supported: ["header"],
          scopes_supported: [],
          resource_documentation: `${protocol}://${serverHost}/docs`,
          resource_description: "CBrowser MCP Server - Open access (no authentication required)",
        }));
      }
      return;
    }

    // =====================================================================
    // Protected Endpoints (auth required)
    // =====================================================================

    // Rate limit check (if enabled)
    const rateLimit = checkRateLimit(req, rateLimitConfig);
    if (!rateLimit.allowed) {
      const retryAfterSeconds = Math.ceil((rateLimit.resetTime - Date.now()) / 1000);
      const retryAfterMinutes = Math.ceil(retryAfterSeconds / 60);
      const humanReadableTime = retryAfterSeconds > 60
        ? `${retryAfterMinutes} minute${retryAfterMinutes !== 1 ? "s" : ""}`
        : `${retryAfterSeconds} second${retryAfterSeconds !== 1 ? "s" : ""}`;

      res.writeHead(429, {
        "Content-Type": "application/json",
        "Retry-After": String(retryAfterSeconds),
        "X-RateLimit-Limit": String(rateLimitConfig.maxRequests),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(Math.ceil(rateLimit.resetTime / 1000)),
      });
      res.end(JSON.stringify({
        error: "Rate Limit Exceeded",
        message: `⚠️ CBrowser Demo Rate Limit Reached\n\nThe demo server allows ${rateLimitConfig.maxRequests} requests per hour to ensure fair access for all users.\n\nPlease wait ${humanReadableTime} before trying again.\n\nFor unlimited access, see: https://cbrowser.ai/enterprise`,
        user_message: `Rate limit reached. Please wait ${humanReadableTime} and try again.`,
        retry_after_seconds: retryAfterSeconds,
        retry_after_human: humanReadableTime,
        limit: rateLimitConfig.maxRequests,
        window_minutes: Math.round(rateLimitConfig.windowMs / 60000),
      }));
      return;
    }

    // Add rate limit headers to successful responses
    res.setHeader("X-RateLimit-Limit", String(rateLimitConfig.maxRequests));
    res.setHeader("X-RateLimit-Remaining", String(rateLimit.remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(rateLimit.resetTime / 1000)));

    // Auth check for protected endpoints
    if (authEnabled) {
      const authResult = await validateAuth(req, apiKeys, auth0Enabled);
      if (!authResult.valid) {
        sendUnauthorized(res, authResult.reason);
        return;
      }
    }

    // Homepage (GET / with homepageHtml option)
    if (url.pathname === "/" && req.method === "GET" && options?.homepageHtml) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(options.homepageHtml);
      return;
    }

    // MCP endpoint
    if (url.pathname === "/mcp" || url.pathname === "/") {
      // Get or create session
      // v18.14.0: Use client's mcp-session-id for browser session correlation
      // This fixes DOM interaction desync where navigate worked but other tools saw blank page
      const existingSessionId = req.headers["mcp-session-id"] as string | undefined;

      let transport: StreamableHTTPServerTransport;
      let browserSessionId: string;

      // First, determine the browser session ID (independent of transport mode)
      // Always prefer client's session ID for browser continuity
      let sessionSource: string;
      if (existingSessionId && activeSessions.has(existingSessionId)) {
        // Reuse existing browser session
        browserSessionId = existingSessionId;
        sessionSource = "reused";
        const session = activeSessions.get(browserSessionId);
        if (session) {
          session.lastActivity = Date.now();
        }
      } else if (existingSessionId) {
        // Client has a session ID but we don't have a browser for it yet
        // Use their ID to create a new browser session (enables session continuity)
        browserSessionId = existingSessionId;
        sessionSource = "client-new";
      } else {
        // No session ID from client - generate new one
        browserSessionId = randomUUID();
        sessionSource = "generated";
      }

      // Log session handling for debugging (truncate ID for readability)
      const shortId = browserSessionId.substring(0, 8);
      console.log(`[Session] ${sessionSource}: ${shortId}... (active: ${activeSessions.size})`);

      // Now handle transport (stateful mode caches transport, stateless creates new each time)
      const hasExistingTransport = existingSessionId ? transports.has(existingSessionId) : false;

      if (sessionMode === "stateful" && existingSessionId && hasExistingTransport) {
        transport = transports.get(existingSessionId)!;
        console.log(`[Transport] Reusing cached transport for ${existingSessionId.substring(0, 8)}...`);
      } else {

        // Create new transport
        // Stateful: return session ID for transport caching
        // Stateless: no session ID (each request is independent but browser reused via existingSessionId)
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: sessionMode === "stateful" ? () => browserSessionId : undefined,
        });

        // Resolve pricing tier from API key (cbk_ keys → CMS lookup)
        const requestApiKey = extractApiKey(req);
        const resolvedTier = requestApiKey ? await resolveApiKeyTier(requestApiKey) : null;

        // Create and connect server with session isolation and tier gating
        const server = createMcpServer(options?.registerTools, browserSessionId, resolvedTier);

        // Allow extension with additional tools (for Enterprise)
        if (options?.extendServer) {
          await options.extendServer(server);
        }

        await server.connect(transport);

        // Store transport for stateful mode
        // IMPORTANT: Use browserSessionId directly, not transport.sessionId
        // The transport.sessionId is only set AFTER the first response is sent,
        // but we need to store it NOW so subsequent requests can find it
        if (sessionMode === "stateful") {
          transports.set(browserSessionId, transport);
          transport.onclose = async () => {
            transports.delete(browserSessionId);
            // Clean up browser session on disconnect
            await cleanupSession(browserSessionId);
          };
        } else {
          // For stateless mode, clean up after a delay
          transport.onclose = async () => {
            // Give some time for rapid reconnects before cleanup
            setTimeout(async () => {
              const session = activeSessions.get(browserSessionId);
              if (session && Date.now() - session.lastActivity > 30000) {
                await cleanupSession(browserSessionId);
              }
            }, 30000);
          };
        }

        // Add error handling for transport errors
        transport.onerror = (error: Error) => {
          console.error(`[MCP Transport Error] ${error.message}`);
        };
      }

      // Handle the request with error wrapping
      try {
        await handleMcpRequest(req, res, transport);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[MCP Request Error] ${errorMessage}`);

        // If response not yet sent, send error
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32603,
              message: `Tool execution failed: ${errorMessage}`,
            },
            id: null,
          }));
        }
      }
      return;
    }

    // 404 for other paths
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  httpServer.listen(port, host, () => {
    console.log(`\nCognitive Browser Remote MCP Server running at http://${host}:${port}`);
    console.log(`\nEndpoints:`);
    console.log(`  MCP:      http://${host}:${port}/mcp`);
    console.log(`  Health:   http://${host}:${port}/health`);
    console.log(`  Info:     http://${host}:${port}/info`);
    if (auth0Enabled) {
      console.log(`  OAuth:    http://${host}:${port}/.well-known/oauth-protected-resource`);
    }
    if (authEnabled) {
      console.log(`\nAuthentication:`);
      if (apiKeyAuthEnabled) {
        console.log(`  API Key:  Authorization: Bearer <your-api-key>`);
        console.log(`            X-API-Key: <your-api-key>`);
      }
      if (auth0Enabled) {
        console.log(`  OAuth:    Authorization: Bearer <jwt-token>`);
        console.log(`            Auth0 Domain: ${auth0?.domain}`);
      }
    }
    console.log(`\nFor claude.ai custom connector:`);
    console.log(`  URL: http://${host}:${port}/mcp`);
    if (auth0Enabled) {
      console.log(`  OAuth metadata: http://${host}:${port}/.well-known/oauth-protected-resource`);
    }
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\nShutting down...");
    if (browser) {
      await browser.close();
    }
    httpServer.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Run if executed directly
if (process.argv[1]?.endsWith("mcp-server-remote.js") ||
    process.argv[1]?.endsWith("mcp-server-remote.ts")) {
  startRemoteMcpServer().catch((err) => {
    console.error("Failed to start remote MCP server:", err);
    process.exit(1);
  });
}
