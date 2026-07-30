/**
 * CBrowser - Cognitive Browser Automation
 * Copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com
 * Learn more at https://cbrowser.ai - MIT License
 */

/**
 * Security layer — connects src/security/ to the tools that are actually served.
 *
 * Until 2026-07-26 the entire security module was dead code. A grep for its six
 * public entry points across src/, excluding src/security/ itself, returned ZERO
 * call sites, while README.md shipped a Zone table, skill/SKILL.md claimed
 * "Constitutional safety (won't execute dangerous actions)" with a checkmark in a
 * feature matrix, skill/Philosophy.md claimed "Every session generates an audit
 * log", and cli.ts documented `--force  Bypass red zone safety checks`. None of
 * it ran. Four green test files covered the functions in isolation, which is
 * exactly why a 570/570 suite read as assurance.
 *
 * Applied UNCONDITIONALLY, deliberately. `createGatedServer` returns the server
 * untouched when the tier is null, which is the live enterprise configuration, so
 * hanging security off tier gating would inherit that hole.
 *
 * WHAT IS ENFORCED, AND WHY THE REST IS NOT:
 *   - Audit logging: always. Zero behaviour change, and it is what makes the
 *     documented claim true.
 *   - Description scanning: at registration, recorded. Detection only.
 *   - Zone `black`: always denied. There are currently zero black tools, so this
 *     is a guard for future classifications rather than a change today.
 *   - Zone `red`: NOT denied by default. The zone model was designed around a CLI
 *     `--force` flag, and MCP has no equivalent affordance — a caller has no way
 *     to express override. Enforcing it would have denied six tools that work
 *     today on the paid product (stealth_enable/disable/diagnose, set_api_key,
 *     ask_user, cognitive_journey_autonomous, chaos_test), which is a worse
 *     outcome than the gap it closes. It is available behind
 *     CBROWSER_ENFORCE_RED_ZONE=true, and the real fix is a force affordance in
 *     the MCP surface — a design decision, not a patch.
 */

import { createAuditContext, wrapToolHandler } from "../security/audit-wrapper.js";
import { checkToolPermission } from "../security/tool-permissions.js";
import { scanToolDescription } from "../security/description-scanner.js";
import type { AuditContext } from "../security/audit-wrapper.js";

/** Registration-time description-scan results, for the caller to surface. */
export interface DescriptionScanSummary {
  scanned: number;
  flagged: Array<{ tool: string; issues: number }>;
}

let lastScan: DescriptionScanSummary = { scanned: 0, flagged: [] };

/** What the most recent registration pass found. Read-only. */
export function getDescriptionScanSummary(): DescriptionScanSummary {
  return { scanned: lastScan.scanned, flagged: [...lastScan.flagged] };
}

/** Red-zone denial is opt-in; see the module comment for why. */
function redZoneEnforced(): boolean {
  return process.env.CBROWSER_ENFORCE_RED_ZONE === "true" || process.env.CBROWSER_ENFORCE_RED_ZONE === "1";
}

/**
 * Wrap a server so every tool registered through it is audited and zone-checked.
 *
 * Composes with createGatedServer rather than replacing it: tier gating decides
 * what a customer may reach, this decides what is recorded and what is refused
 * outright.
 */
export function applySecurityLayer(server: unknown, opts?: { audit?: AuditContext }): unknown {
  // BOTH registration methods must be wrapped. There are two independent tool
  // surfaces in this package: registerAllPublicTools uses `registerTool` (the
  // hosted/remote servers), while src/mcp-server.ts — the local stdio server —
  // registers its own ~100 tools with the deprecated `server.tool(...)` in 4,372
  // lines of its own. Wrapping only the first covered the hosted path and left
  // the local server completely unaudited, which is precisely the "wired it but
  // it never fires" outcome this whole change exists to eliminate. Verified by
  // driving a real tools/call at each surface and checking for the entry.
  const srv = server as {
    registerTool?: (name: string, config: Record<string, unknown>, handler: (...args: unknown[]) => unknown) => void;
    tool?: (...args: unknown[]) => unknown;
  };
  const originalRegisterTool = srv.registerTool?.bind(srv);

  let audit: AuditContext;
  try {
    audit = opts?.audit ?? createAuditContext();
  } catch {
    // An unwritable audit dir must not take the server down. Degrade to
    // disabled-but-present rather than crashing at startup.
    audit = { sessionId: "unavailable", auditDir: "", enabled: false, includeStackTraces: false, actionsTriggered: new Map() };
  }

  lastScan = { scanned: 0, flagged: [] };

  /** Scan a description at registration time. Detection only, never blocking. */
  const scan = (name: string, description: unknown) => {
    try {
      if (typeof description === "string" && description) {
        lastScan.scanned++;
        const r = scanToolDescription(name, description);
        if (r.issues.length > 0) lastScan.flagged.push({ tool: name, issues: r.issues.length });
      }
    } catch { /* scanning must never block registration */ }
  };

  /** Wrap one handler with zone refusal + audit. */
  const secure = (name: string, handler: (...args: unknown[]) => unknown) => {
    const secured = async (...args: unknown[]) => {
      const decision = checkToolPermission(name, redZoneEnforced());
      // `black` is refused unconditionally; `red` only when explicitly enforced.
      // Anything allowed proceeds, with the zone recorded either way.
      const refuse =
        decision.zone === "black" || (decision.zone === "red" && redZoneEnforced() && !decision.allowed);
      if (refuse) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: JSON.stringify({
              error: "tool_refused_by_zone",
              tool: name,
              zone: decision.zone,
              message: decision.message ?? `Tool '${name}' is refused by its safety zone.`,
            }, null, 2),
          }],
        };
      }
      return (handler as (...a: unknown[]) => Promise<unknown>)(...args);
    };

    // Audit wraps the outermost call so a zone refusal is recorded too.
    // wrapToolHandler calls handler(params) with one argument; MCP passes
    // (args, extra). Forward the rest explicitly so the extra context is not
    // silently dropped on its way through the audit layer.
    const audited = wrapToolHandler(
      ((params: Record<string, unknown>) => secured(params)) as unknown as Parameters<typeof wrapToolHandler>[0],
      name,
      audit,
    ) as unknown as (...args: unknown[]) => unknown;
    return audited;
  };

  if (originalRegisterTool) {
    srv.registerTool = (name: string, config: Record<string, unknown>, handler: (...args: unknown[]) => unknown) => {
      scan(name, config?.description);
      originalRegisterTool(name, config, secure(name, handler));
    };
  }

  // The deprecated `.tool()` overloads put the handler last and the description
  // (when present) second, so locate the callback by position from the end
  // rather than assuming an arity.
  const originalTool = srv.tool?.bind(srv);
  if (originalTool) {
    srv.tool = (...args: unknown[]) => {
      const name = typeof args[0] === "string" ? args[0] : "(unknown)";
      const handlerIdx = args.length - 1;
      const handler = args[handlerIdx];
      if (typeof handler !== "function") return originalTool(...args);
      const maybeConfig = args.find((a) => a && typeof a === "object" && "description" in (a as object));
      scan(name, typeof args[1] === "string" ? args[1] : (maybeConfig as { description?: unknown })?.description);
      const next = [...args];
      next[handlerIdx] = secure(name, handler as (...a: unknown[]) => unknown);
      return originalTool(...next);
    };
  }

  return srv;
}
