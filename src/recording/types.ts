/**
 * CBrowser - Cognitive Browser Automation
 * Copyright 2026 Alexandria Eden alexandria.shai.eden@gmail.com
 * Learn more at https://cbrowser.ai - MIT License
 */

/**
 * Recording manifest contract.
 *
 * The manifest is the single artifact that describes a recording run: how it
 * was captured, what was captured, and every frame that made it into the
 * output. Encoders, the CLI, and any downstream consumer read this file rather
 * than re-deriving state from the frame directory.
 *
 * Schemas are zod v4; every exported TS type is inferred from its schema so the
 * runtime contract and the compile-time contract cannot drift.
 */

import { z } from "zod";

/** Manifest format version emitted by this build. */
export const MANIFEST_VERSION = 1;

// ============================================================================
// Primitives
// ============================================================================

export const EngineSchema = z.enum(["chromium", "firefox", "webkit"]);

export const CaptureMethodSchema = z.enum(["cdp-screencast", "screenshot-loop"]);

export const ViewportSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  deviceScaleFactor: z.number().positive(),
});

export const RectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().positive(),
  height: z.number().positive(),
});

export const DimsSchema = z.object({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

// ============================================================================
// Capture target
// ============================================================================

/**
 * What the recorder was pointed at. Discriminated on `kind` so encoders can
 * switch exhaustively without guessing from the presence of optional fields.
 */
export const TargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("viewport") }),
  z.object({ kind: z.literal("region"), rect: RectSchema }),
  z.object({
    kind: z.literal("element"),
    selector: z.string().min(1),
    padding: z.number().nonnegative(),
  }),
]);

// ============================================================================
// Per-frame side-channel records
// ============================================================================

/**
 * Console and network records are kept deliberately permissive: the recorder
 * owns their exact shape and may attach engine-specific extras. Only the fields
 * the encoders and reports actually read are required; unknown keys survive
 * parsing untouched.
 */
export const ConsoleEntrySchema = z
  .object({
    t_ms: z.number().nonnegative(),
    type: z.string(),
    text: z.string(),
  })
  .loose();

export const NetworkEntrySchema = z
  .object({
    t_ms: z.number().nonnegative(),
    url: z.string(),
    method: z.string().optional(),
    status: z.number().int().optional(),
    failed: z.boolean().optional(),
  })
  .loose();

// ============================================================================
// Frames
// ============================================================================

export const FrameSchema = z.object({
  /** Position in the frame sequence, 0-based and dense. */
  index: z.number().int().nonnegative(),
  /** Milliseconds since `started_at`. Non-decreasing across the sequence. */
  t_ms: z.number().nonnegative(),
  /** Path to the frame image, relative to the manifest. */
  path: z.string().min(1),
  /** Source-image crop this frame was cut from (post-clamp). */
  crop: RectSchema,
  /** SSIM against the previous frame; null for frame 0 or when not computed. */
  ssim_prev: z.number().nullable(),
  /** Frame flagged as a visual anomaly by the change detector. */
  anomaly: z.boolean(),
  /** Element-tracking state for element targets; null when not tracking. */
  tracking: z.enum(["ok", "stale"]).nullable(),
  console: z.array(ConsoleEntrySchema),
  network: z.array(NetworkEntrySchema),
});

export const FrameGapSchema = z.object({
  /** Gap occurred between this frame index and the next one. */
  after_index: z.number().int().nonnegative(),
  gap_ms: z.number().positive(),
});

// ============================================================================
// Manifest
// ============================================================================

export const RecordingManifestSchema = z.object({
  version: z.number().int().positive(),
  slug: z.string().min(1),
  engine: EngineSchema,
  capture_method: CaptureMethodSchema,
  /** Frame rate requested by the caller. */
  target_fps: z.number().positive(),
  /** Frame rate actually achieved: frames / (duration_ms / 1000). */
  actual_fps: z.number().nonnegative(),
  viewport: ViewportSchema,
  target: TargetSchema,
  /** Trigger that started capture; null when capture started immediately. */
  start_trigger: z.string().nullable(),
  /** Trigger that stopped capture; null when capture ran to a fixed duration. */
  stop_trigger: z.string().nullable(),
  /** True when capture ended because a trigger timed out rather than fired. */
  trigger_timeout: z.boolean(),
  /** ISO-8601 timestamp of the first frame. */
  started_at: z.string().min(1),
  duration_ms: z.number().nonnegative(),
  output_dims: DimsSchema,
  frames: z.array(FrameSchema),
  /** Frame indices where SSIM dropped below the change threshold. */
  change_points: z.array(z.number().int().nonnegative()),
  frame_gaps: z.array(FrameGapSchema),
  /** Present when a region/element rect had to be clamped into the viewport. */
  region_clamped: z.boolean().optional(),
  /** Output format ("gif", "webp", "mp4", ...) to artifact path. */
  artifacts: z.record(z.string(), z.string()),
});

// ============================================================================
// Inferred types
// ============================================================================

export type Engine = z.infer<typeof EngineSchema>;
export type CaptureMethod = z.infer<typeof CaptureMethodSchema>;
export type Viewport = z.infer<typeof ViewportSchema>;
export type Rect = z.infer<typeof RectSchema>;
export type Dims = z.infer<typeof DimsSchema>;
export type RecordingTarget = z.infer<typeof TargetSchema>;
export type ConsoleEntry = z.infer<typeof ConsoleEntrySchema>;
export type NetworkEntry = z.infer<typeof NetworkEntrySchema>;
export type Frame = z.infer<typeof FrameSchema>;
export type FrameGap = z.infer<typeof FrameGapSchema>;
export type RecordingManifest = z.infer<typeof RecordingManifestSchema>;

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse and validate a manifest.
 *
 * Accepts an already-parsed object or a raw JSON string. Throws an `Error`
 * whose message lists every failing path, so a malformed manifest reports all
 * of its problems at once instead of one per run.
 */
export function parseManifest(input: unknown): RecordingManifest {
  let candidate = input;

  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch (e) {
      throw new Error(`Invalid recording manifest: not valid JSON (${(e as Error).message})`);
    }
  }

  const result = RecordingManifestSchema.safeParse(candidate);
  if (result.success) return result.data;

  const details = result.error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `  - ${path}: ${issue.message}`;
    })
    .join("\n");

  throw new Error(`Invalid recording manifest:\n${details}`);
}
