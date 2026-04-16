/**
 * CBrowser Output Formatting System
 *
 * Provides accessible output modes for CLI:
 * - Default: Full color + emoji (unchanged behavior)
 * - --no-color / NO_COLOR: Strip ANSI color codes
 * - --plain: Strip emoji, box-drawing, and unicode decorations
 * - --json: Structured JSON output on stdout
 *
 * Follows the NO_COLOR standard (https://no-color.org)
 */

export interface OutputOptions {
  /** Suppress ANSI color codes */
  noColor: boolean;
  /** Suppress emoji, box-drawing, and unicode decorations */
  plain: boolean;
  /** Output structured JSON instead of human-readable text */
  json: boolean;
}

/** Singleton output options — set once at CLI startup */
let globalOptions: OutputOptions = {
  noColor: false,
  plain: false,
  json: false,
};

/**
 * Detect output mode from CLI flags and environment variables.
 * Precedence: --no-color flag > NO_COLOR env > TERM=dumb > TTY detection
 */
export function detectOutputOptions(cliOptions: Record<string, string | boolean>): OutputOptions {
  const noColorFlag = !!cliOptions["no-color"];
  const noColorEnv = process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "";
  const dumbTerminal = process.env.TERM === "dumb";
  const plainFlag = !!cliOptions["plain"];
  const jsonFlag = !!cliOptions["json-output"];

  const noColor = noColorFlag || noColorEnv || dumbTerminal;

  return {
    noColor: noColor || jsonFlag,
    plain: plainFlag || jsonFlag,
    json: jsonFlag,
  };
}

/** Set global output options (called once at CLI startup) */
export function setOutputOptions(opts: OutputOptions): void {
  globalOptions = opts;
}

/** Get current output options */
export function getOutputOptions(): OutputOptions {
  return globalOptions;
}

// Regex to match ANSI escape codes (colors, bold, underline, etc.)
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]/g;

// Regex to match common emoji (emoji presentation sequences, skin tones, etc.)
// eslint-disable-next-line no-misleading-character-class
const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu;

// Box-drawing and decorative unicode characters
const BOX_DRAWING_REGEX = /[\u2500-\u257F\u2580-\u259F\u25A0-\u25FF\u2550-\u256C]/g;

// Non-emoji decorative unicode used in CLIs (bullets, arrows, stars, checks)
// Emoji are already handled by EMOJI_REGEX — this only covers non-emoji symbols
const DECORATIVE_REGEX = /[━┃┏┓┗┛┣┫╋┳┻•●○◎◉▶▷►▻▪▫★☆✓✗✔✘]/gu;

/**
 * Strip ANSI color codes from a string.
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

/**
 * Strip emoji and decorative unicode from a string.
 * Preserves the semantic meaning by removing only the visual decoration.
 */
export function stripDecorations(text: string): string {
  return text
    .replace(EMOJI_REGEX, "")
    .replace(BOX_DRAWING_REGEX, "-")
    .replace(DECORATIVE_REGEX, "")
    .replace(/\s{2,}/g, " ")  // collapse multiple spaces left by removal
    .replace(/^\s+$/gm, "");  // remove lines that became whitespace-only
}

/**
 * Format text according to current output options.
 * Use this to wrap any text before printing to console.
 */
export function formatOutput(text: string): string {
  let result = text;
  if (globalOptions.noColor) {
    result = stripAnsi(result);
  }
  if (globalOptions.plain) {
    result = stripDecorations(result);
  }
  return result;
}

/**
 * JSON output structure for --json-output mode.
 */
export interface JsonOutput {
  success: boolean;
  command: string;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    howToFix?: string;
    docUrl?: string;
  };
  warnings?: string[];
  meta: {
    version: string;
    duration_ms?: number;
  };
}

/**
 * Emit JSON output to stdout and exit.
 * All human-readable diagnostics go to stderr.
 */
export function emitJson(output: JsonOutput): void {
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

/**
 * Install console wrappers that respect output options.
 * Call once at CLI startup, AFTER setting output options.
 *
 * In JSON mode: console.log is suppressed (captured for JSON), console.error goes to stderr.
 * In plain/no-color modes: console.log output is filtered through formatOutput.
 */
export function installOutputWrappers(): void {
  // Default case: no flags active — skip wrapping entirely (zero overhead)
  if (!globalOptions.json && !globalOptions.noColor && !globalOptions.plain) {
    return;
  }

  if (globalOptions.json) {
    // In JSON mode, suppress console.log (data goes through emitJson)
    // Keep console.error for diagnostics on stderr
    const origError = console.error.bind(console);
    console.log = () => {};  // suppress stdout in JSON mode
    console.error = (...args: unknown[]) => {
      origError(...args.map(a => typeof a === "string" ? stripAnsi(stripDecorations(a)) : a));
    };
  } else {
    const origLog = console.log.bind(console);
    const origError = console.error.bind(console);

    console.log = (...args: unknown[]) => {
      origLog(...args.map(a => typeof a === "string" ? formatOutput(a) : a));
    };
    console.error = (...args: unknown[]) => {
      origError(...args.map(a => typeof a === "string" ? formatOutput(a) : a));
    };
  }
}
