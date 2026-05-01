/**
 * Human input mechanics — wraps chromium's instant CDP-driven clicks and
 * keystrokes with realistic human timing and imperfection. The goal is that
 * a simulated journey, played back in any session-replay tool (FullStory,
 * LogRocket, Hotjar), is indistinguishable from a real user.
 *
 * What "realistic" means here:
 *   • Typing: Gaussian-spaced inter-key intervals + ~5% typo+correction rate
 *     + occasional "thinking" pauses + initial focus delay
 *   • Clicking: hover→dwell→click, with the click point off-center by a few
 *     pixels because humans don't aim perfectly
 *   • Scrolling: variable wheel deltas + occasional "glance back" (scroll up
 *     a hair then resume) which real readers do without thinking
 *   • Inter-action: a small "settle" pause after each action, modulated by
 *     persona traits (low patience → faster, high readingTendency → slower)
 *
 * All durations and probabilities are persona-trait-modulated so a "power
 * user" types twice as fast as an "elderly user" — the same way real
 * populations vary.
 */
import type { Page } from "playwright";

/**
 * Persona traits that drive input timing. Subset of CognitiveTraits — only
 * the ones that affect motor and reading behavior. All values are 0-1.
 */
export interface InputTraits {
  /** Procedural fluency — keyboard/mouse familiarity. 1 = fast, 0 = slow. */
  proceduralFluency?: number;
  /** Motor precision — aiming accuracy. 1 = bullseye, 0 = jittery. */
  motorPrecision?: number;
  /** Patience — willingness to wait. 1 = patient, 0 = impatient. */
  patience?: number;
  /** Reading tendency — time spent reading before acting. 1 = thorough, 0 = skim. */
  readingTendency?: number;
}

const TRAIT_DEFAULT: Required<InputTraits> = {
  proceduralFluency: 0.5,
  motorPrecision: 0.7,
  patience: 0.5,
  readingTendency: 0.5,
};

const traits = (t?: InputTraits): Required<InputTraits> => ({
  proceduralFluency: t?.proceduralFluency ?? TRAIT_DEFAULT.proceduralFluency,
  motorPrecision: t?.motorPrecision ?? TRAIT_DEFAULT.motorPrecision,
  patience: t?.patience ?? TRAIT_DEFAULT.patience,
  readingTendency: t?.readingTendency ?? TRAIT_DEFAULT.readingTendency,
});

// ─── Random helpers ─────────────────────────────────────────────────────────

/** Box-Muller sampler for Normal(mean, stddev). Truncated to [min, max]. */
function gauss(mean: number, std: number, min: number, max: number): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(min, Math.min(max, mean + z * std));
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, Math.max(0, ms)));

/** Uniform random in [min, max). */
const rand = (min: number, max: number) => min + Math.random() * (max - min);

// ─── Typing ─────────────────────────────────────────────────────────────────

// Adjacent-key map for realistic typos — neighboring keys on a QWERTY layout
// are far more likely typo sources than random characters.
const TYPO_NEIGHBORS: Record<string, string> = {
  q: "wa", w: "qes", e: "wrd", r: "etf", t: "ryg", y: "tuh", u: "yij", i: "uok", o: "ipl", p: "ol",
  a: "qsz", s: "awdz", d: "sefc", f: "drgv", g: "fthb", h: "gyjn", j: "hukm", k: "jiln", l: "kop",
  z: "axs", x: "zsdc", c: "xdfv", v: "cfgb", b: "vghn", n: "bhjm", m: "njk",
};

function typoFor(c: string): string {
  const lower = c.toLowerCase();
  const neighbors = TYPO_NEIGHBORS[lower];
  if (!neighbors) return c; // non-letter → no typo
  const pick = neighbors[Math.floor(Math.random() * neighbors.length)];
  return c === lower ? pick : pick.toUpperCase();
}

/**
 * Type into the focused element with realistic human cadence.
 *   • Gaussian inter-key intervals; high proceduralFluency → tighter, faster.
 *   • 5% typo rate per char — types the typo, pauses, backspaces, retypes.
 *   • Random "thinking" pauses (rare longer pauses).
 *   • Initial dwell before first key, modeling the user reading the label.
 */
export async function humanType(
  page: Page,
  text: string,
  inputTraits?: InputTraits,
): Promise<void> {
  const t = traits(inputTraits);
  // Faster procedural fluency → smaller mean and stddev. Range μ ≈ 90-260ms.
  const meanInterval = 260 - 170 * t.proceduralFluency;
  const stdInterval = 50 + 60 * (1 - t.proceduralFluency);

  // Initial dwell — patient/thorough readers take longer to find the field
  await sleep(rand(300, 800) * (1 + t.readingTendency * 0.6));

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // Occasional thinking pause (rare, longer)
    if (Math.random() < 0.04) {
      await sleep(rand(600, 1500) * (1 + (1 - t.proceduralFluency) * 0.5));
    }

    // 5% typo+correction rate, only on letter chars
    if (/[a-zA-Z]/.test(ch) && Math.random() < 0.05) {
      const wrong = typoFor(ch);
      await page.keyboard.type(wrong, { delay: 0 });
      await sleep(gauss(220, 90, 80, 600)); // notice the typo
      await page.keyboard.press("Backspace");
      await sleep(gauss(meanInterval * 0.7, stdInterval * 0.7, 30, 400));
    }

    // Type the actual char
    await page.keyboard.type(ch, { delay: 0 });
    await sleep(gauss(meanInterval, stdInterval, 30, 800));
  }
}

// ─── Clicking ───────────────────────────────────────────────────────────────

/**
 * Click at (x, y) with human-realistic mechanics:
 *   • Move to a slightly off-center target (motor precision determines spread)
 *   • Hover-and-dwell briefly before pressing — humans pause before clicking
 *     to confirm aim
 *   • 2% mis-click rate: click slightly outside the bbox, register, then
 *     follow up with the corrected click
 *
 * Returns the actual coordinates clicked (post-jitter), so callers can record
 * the realistic position rather than the ideal center.
 */
export async function humanClick(
  page: Page,
  cx: number,
  cy: number,
  inputTraits?: InputTraits,
  bbox?: { width: number; height: number },
): Promise<{ x: number; y: number }> {
  const t = traits(inputTraits);

  // Aim spread — high motorPrecision = small spread (1-2px), low = big (6-10px).
  // Clamped so the click still lands inside the bbox we know about.
  const maxSpread = 8 - 6 * t.motorPrecision;
  const halfW = bbox ? bbox.width / 2 : 30;
  const halfH = bbox ? bbox.height / 2 : 12;
  const spreadX = Math.min(maxSpread, halfW * 0.4);
  const spreadY = Math.min(maxSpread, halfH * 0.4);
  const dx = gauss(0, spreadX, -spreadX * 2, spreadX * 2);
  const dy = gauss(0, spreadY, -spreadY * 2, spreadY * 2);
  const targetX = cx + dx;
  const targetY = cy + dy;

  // Mis-click roll (only if we know the bbox so we can land just outside)
  const willMisclick = bbox && Math.random() < 0.02;
  if (willMisclick) {
    // Click 6-12px outside the bbox edge, in a random direction
    const angle = Math.random() * Math.PI * 2;
    const dist = rand(halfW + 6, halfW + 12);
    const missX = cx + Math.cos(angle) * dist;
    const missY = cy + Math.sin(angle) * dist;
    await page.mouse.move(missX, missY, { steps: 8 });
    await sleep(gauss(120, 40, 60, 250));
    await page.mouse.click(missX, missY);
    // Realize, recover
    await sleep(gauss(450, 120, 250, 900));
  }

  // Hover with smooth interpolation (steps=8-15) so any in-page mouse-tracker
  // sees a real movement curve, not a teleport.
  const moveSteps = Math.round(gauss(12, 3, 6, 24));
  await page.mouse.move(targetX, targetY, { steps: moveSteps });

  // Pre-click dwell — the "is this what I want?" pause
  const dwell = gauss(180, 80, 60, 500) * (1 + t.readingTendency * 0.4);
  await sleep(dwell);

  await page.mouse.click(targetX, targetY);

  return { x: targetX, y: targetY };
}

// ─── Scrolling ──────────────────────────────────────────────────────────────

/**
 * Scroll with variable deltas and occasional glance-back (a brief reverse
 * scroll real readers do unconsciously). Returns the actual delta applied.
 */
export async function humanScroll(
  page: Page,
  baseDeltaY: number,
  inputTraits?: InputTraits,
): Promise<number> {
  const t = traits(inputTraits);

  // Vary the delta ±20% — not always exactly 400px
  const variance = baseDeltaY * 0.2;
  const delta = baseDeltaY + gauss(0, variance / 2, -variance, variance);

  // 5% glance-back: scroll the opposite way 60-100px, pause, then scroll the
  // intended direction. Real readers do this when something catches their eye
  // mid-scroll. Skip for impatient personas.
  const willGlance = t.patience > 0.4 && Math.random() < 0.05;
  if (willGlance) {
    const glanceBack = -Math.sign(delta) * rand(60, 100);
    await page.evaluate(({ d }: { d: number }) => {
      window.scrollBy({ top: d, behavior: "smooth" });
    }, { d: glanceBack });
    await sleep(gauss(400, 120, 200, 900));
  }

  await page.evaluate(({ d }: { d: number }) => {
    window.scrollBy({ top: d, behavior: "smooth" });
  }, { d: delta });
  // Wait for the smooth scroll to settle
  await sleep(gauss(380, 80, 200, 700));

  return delta;
}

// ─── Inter-action settle ────────────────────────────────────────────────────

/**
 * "Settle" pause between actions — humans don't fire actions back-to-back at
 * machine speed. Patient readers settle longer; impatient skim faster.
 */
export async function humanSettle(inputTraits?: InputTraits): Promise<void> {
  const t = traits(inputTraits);
  // Range: 200ms (impatient) → 1200ms (very patient + thorough)
  const ms = gauss(
    400 + 600 * t.patience + 200 * t.readingTendency,
    180,
    150,
    1500,
  );
  await sleep(ms);
}
