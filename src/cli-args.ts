/**
 * cli-args.ts — argv parsing for the CLI.
 *
 * Extracted from cli.ts so it can be unit-tested: cli.ts runs `main()` at the
 * top level, so importing it from a test executes the CLI.
 */

export interface ParsedArgs {
  command: string;
  args: string[];
  options: Record<string, string | boolean>;
}

/**
 * Parse argv into a command, positional args, and options.
 *
 * NEGATIVE FLAGS: `--no-x` sets options["no-x"] = true AND options.x = false.
 *
 * Setting both is deliberate. Before 2026-07-27 only options["no-x"] was set,
 * so a reader written as `options.x !== false` never saw the flag. Measured
 * across the four documented negative flags:
 *
 *   --no-color      reads options["no-color"]   worked
 *   --no-vision     reads options["no-vision"]  worked
 *   --no-persistent reads options.persistent    SILENTLY IGNORED
 *   --no-restore    reads options.restore       SILENTLY IGNORED
 *
 * The two that were broken are both opt-outs for persisted browser state, so
 * state the user explicitly asked to discard was kept instead:
 * `cbrowser cookie list --no-persistent` still returned cookies out of the
 * persistent profile. Writing both keys fixes those two without disturbing the
 * two that already worked.
 */
export function parseArgs(args: string[]): ParsedArgs {
  const command = args[0] || "help";
  const restArgs: string[] = [];
  const options: Record<string, string | boolean> = {};

  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      const next = args[i + 1];

      if (next && !next.startsWith("--")) {
        options[key] = next;
        i++;
      } else {
        options[key] = true;
      }

      // Only for the boolean form: `--no-cache foo` means the value "foo",
      // and inverting that would be wrong.
      if (key.startsWith("no-") && key.length > 3 && options[key] === true) {
        options[key.slice(3)] = false;
      }
    } else {
      restArgs.push(args[i]);
    }
  }

  return { command, args: restArgs, options };
}
