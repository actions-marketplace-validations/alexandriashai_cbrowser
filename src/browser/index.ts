/**
 * CBrowser - Cognitive Browser Automation
 * Copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com
 * Learn more at https://cbrowser.ai - MIT License
 */


/**
 * Browser Module Exports
 *
 * Modular components extracted from CBrowser for better maintainability.
 */

export { SessionManager } from "./session-manager.js";
export type { SessionManagerConfig } from "./session-manager.js";

export { SelectorCacheManager } from "./selector-cache.js";
export type { SelectorCacheConfig } from "./selector-cache.js";

export { OverlayHandler, OVERLAY_PATTERNS } from "./overlay-handler.js";
export type { OverlayHandlerConfig } from "./overlay-handler.js";

export { SiteProfileManager } from "./site-profile-manager.js";
export type {
  SiteProfile,
  ProfileLoadResult,
  SessionValidity,
  SiteProfileSummary,
} from "./site-profile-manager.js";
