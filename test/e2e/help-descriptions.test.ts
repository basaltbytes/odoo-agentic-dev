import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const CLI = resolve(import.meta.dirname, "../../dist/cli.js");

/**
 * Parse the SUBCOMMANDS block of the cli library's --help output. Each entry
 * is rendered as `  <name><padding><description>` (2-space indent, the name,
 * a run of padding spaces, then the description — empty when none was set).
 * The block runs from the SUBCOMMANDS header to the next blank line or EOF.
 */
const parseSubcommands = (help: string): Array<{ name: string; description: string }> => {
  const lines = help.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === "SUBCOMMANDS");
  expect(start, "help output should contain a SUBCOMMANDS block").toBeGreaterThanOrEqual(0);
  const entries: Array<{ name: string; description: string }> = [];
  for (const line of lines.slice(start + 1)) {
    // a blank line (or a new header that is not indented) ends the block
    if (line.trim() === "") break;
    const match = /^ {2}(\S+)\s*(.*)$/.exec(line);
    if (match === null) break;
    entries.push({ name: match[1]!, description: match[2]!.trim() });
  }
  return entries;
};

describe.skipIf(!existsSync(CLI))("--help subcommand descriptions (run `pnpm build` first)", () => {
  const help = execFileSync("node", [CLI, "--help"], { encoding: "utf8" });
  const subcommands = parseSubcommands(help);

  it("lists every root subcommand in the SUBCOMMANDS block", () => {
    const names = subcommands.map((s) => s.name);
    // the full root command tree from src/cli.ts
    expect(names).toEqual([
      "init",
      "info",
      "setup",
      "up",
      "restart",
      "down",
      "reset-db",
      "update",
      "test",
      "link-source",
      "list",
      "prune",
      "doctor",
      "logs",
      "shell",
      "psql",
      "run",
      "compose",
      "worktree",
      "eject",
    ]);
  });

  it("gives every subcommand a non-empty description", () => {
    const missing = subcommands.filter((s) => s.description.length === 0).map((s) => s.name);
    expect(missing, `subcommands missing a --help description: ${missing.join(", ")}`).toEqual([]);
  });

  it("keeps every subcommand description within 72 characters", () => {
    const tooLong = subcommands
      .filter((s) => s.description.length > 72)
      .map((s) => `${s.name} (${s.description.length})`);
    expect(tooLong, `descriptions over 72 chars: ${tooLong.join(", ")}`).toEqual([]);
  });
});
