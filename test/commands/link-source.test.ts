import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  discoverOdooCheckout,
  looksLikeOdooCheckout,
  parseWorktreePorcelain,
  performLinkSource,
} from "../../src/commands/link-source.js";
import { SourceResolverError } from "../../src/errors/errors.js";
import { makeRecordingRunner } from "../../src/testing/fake-adapters.js";
import { runWith } from "../helpers.js";

const tmp: Array<string> = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});

const makeDirs = () => {
  const root = mkdtempSync(join(tmpdir(), "oad-ls-"));
  tmp.push(root);
  const source = join(root, "odoo-src");
  mkdirSync(source);
  const project = join(root, "project");
  mkdirSync(project);
  return { project, root, source };
};

/** A directory that passes the legacy "looks like an Odoo checkout" test. */
const makeFakeOdooCheckout = (path: string) => {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "odoo-bin"), "#!/usr/bin/env python3\n");
  mkdirSync(join(path, "odoo"));
  mkdirSync(join(path, "addons"));
};

/** Runner whose `git worktree list --porcelain` reports the given worktrees. */
const runnerWithWorktrees = (worktrees: Array<string>) =>
  makeRecordingRunner((spec) =>
    spec.command === "git" && spec.args[0] === "worktree" && spec.args[1] === "list"
      ? {
          exitCode: 0,
          stdout: worktrees
            .map((wt) => `worktree ${wt}\nHEAD 0123abc\nbranch refs/heads/x\n`)
            .join("\n"),
          stderr: "",
        }
      : undefined,
  );

const link = (
  options: Parameters<typeof performLinkSource>[0],
  worktrees: Array<string> = [],
): Promise<string> => runWith(runnerWithWorktrees(worktrees).layer)(performLinkSource(options));

describe("looksLikeOdooCheckout", () => {
  it("requires odoo-bin plus odoo/ and addons/ directories", () => {
    const root = mkdtempSync(join(tmpdir(), "oad-chk-"));
    tmp.push(root);
    const checkout = join(root, "odoo");
    makeFakeOdooCheckout(checkout);
    expect(looksLikeOdooCheckout(checkout)).toBe(true);

    const noBin = join(root, "no-bin");
    mkdirSync(noBin);
    mkdirSync(join(noBin, "odoo"));
    mkdirSync(join(noBin, "addons"));
    expect(looksLikeOdooCheckout(noBin)).toBe(false);

    const flatFiles = join(root, "flat");
    mkdirSync(flatFiles);
    writeFileSync(join(flatFiles, "odoo-bin"), "");
    writeFileSync(join(flatFiles, "odoo"), "");
    writeFileSync(join(flatFiles, "addons"), "");
    expect(looksLikeOdooCheckout(flatFiles)).toBe(false);

    expect(looksLikeOdooCheckout(join(root, "missing"))).toBe(false);
  });
});

describe("parseWorktreePorcelain", () => {
  it("extracts worktree paths and ignores the other porcelain lines", () => {
    const stdout = [
      "worktree /repos/kriss-laure",
      "HEAD abc123",
      "branch refs/heads/main",
      "",
      "worktree /repos/kriss-laure-payment",
      "HEAD def456",
      "detached",
      "",
    ].join("\n");
    expect(parseWorktreePorcelain(stdout)).toEqual([
      "/repos/kriss-laure",
      "/repos/kriss-laure-payment",
    ]);
  });

  it("returns nothing for empty output", () => {
    expect(parseWorktreePorcelain("")).toEqual([]);
  });
});

describe("discoverOdooCheckout", () => {
  it("checks <root>/../odoo first, then each worktree's sibling odoo dir", async () => {
    const { project, root } = makeDirs();
    // ../odoo exists but is NOT a valid checkout (plain dir)
    mkdirSync(join(root, "odoo"));
    // a worktree lives elsewhere, with a valid checkout next to it
    const elsewhere = mkdtempSync(join(tmpdir(), "oad-wt-elsewhere-"));
    tmp.push(elsewhere);
    const worktree = join(elsewhere, "kriss-laure-payment");
    mkdirSync(worktree);
    makeFakeOdooCheckout(join(elsewhere, "odoo"));

    const { recording } = { recording: runnerWithWorktrees([worktree]) };
    const result = await runWith(recording.layer)(discoverOdooCheckout(project));
    expect(result.candidates).toEqual([join(root, "odoo"), join(elsewhere, "odoo")]);
    expect(result.resolved).toBe(join(elsewhere, "odoo"));
  });

  it("prefers a valid sibling checkout over worktree candidates", async () => {
    const { project, root } = makeDirs();
    makeFakeOdooCheckout(join(root, "odoo"));
    const recording = runnerWithWorktrees(["/somewhere/else/wt"]);
    const result = await runWith(recording.layer)(discoverOdooCheckout(project));
    expect(result.resolved).toBe(join(root, "odoo"));
  });

  it("survives git failure (not a repo): only the sibling candidate is checked", async () => {
    const { project, root } = makeDirs();
    const recording = makeRecordingRunner(() => ({
      exitCode: 128,
      stdout: "",
      stderr: "fatal: not a git repository",
    }));
    const result = await runWith(recording.layer)(discoverOdooCheckout(project));
    expect(result.candidates).toEqual([join(root, "odoo")]);
    expect(result.resolved).toBeUndefined();
  });
});

describe("performLinkSource", () => {
  it("creates a .odoo symlink to an explicit target without validating it", async () => {
    const { project, source } = makeDirs();
    // source is a plain directory — NOT a valid checkout; explicit wins anyway
    const linkPath = await link({
      rootDir: project,
      target: source,
      name: ".odoo",
      force: false,
      recipeSource: null,
    });
    expect(linkPath).toBe(join(project, ".odoo"));
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(source);
  });

  it("refuses to overwrite a real directory", async () => {
    const { project, source } = makeDirs();
    mkdirSync(join(project, ".odoo"));
    await expect(
      link({ rootDir: project, target: source, name: ".odoo", force: false, recipeSource: null }),
    ).rejects.toThrow(/refusing to overwrite/);
  });

  it("replaces an existing symlink only with force", async () => {
    const { project, source } = makeDirs();
    symlinkSync(project, join(project, ".odoo"));
    await expect(
      link({ rootDir: project, target: source, name: ".odoo", force: false, recipeSource: null }),
    ).rejects.toThrow(/--force/);
    await link({
      rootDir: project,
      target: source,
      name: ".odoo",
      force: true,
      recipeSource: null,
    });
    expect(readlinkSync(join(project, ".odoo"))).toBe(source);
  });

  it("falls back to recipe source (no validation), then discovery", async () => {
    const { project, source } = makeDirs();
    const linkPath = await link({
      rootDir: project,
      target: undefined,
      name: ".odoo",
      force: false,
      recipeSource: source,
    });
    expect(readlinkSync(linkPath)).toBe(source);
    unlinkSync(linkPath);
  });

  it("discovers a valid checkout near a worktree when nothing is configured", async () => {
    const { project } = makeDirs();
    const elsewhere = mkdtempSync(join(tmpdir(), "oad-wt-near-"));
    tmp.push(elsewhere);
    mkdirSync(join(elsewhere, "wt"));
    makeFakeOdooCheckout(join(elsewhere, "odoo"));
    const linkPath = await link(
      { rootDir: project, target: undefined, name: ".odoo", force: false, recipeSource: null },
      [join(elsewhere, "wt")],
    );
    expect(readlinkSync(linkPath)).toBe(join(elsewhere, "odoo"));
  });

  it("errors listing every candidate checked when none is a valid checkout", async () => {
    const { project, root } = makeDirs();
    mkdirSync(join(root, "odoo")); // exists, but not a checkout
    const effect = performLinkSource({
      rootDir: project,
      target: undefined,
      name: ".odoo",
      force: false,
      recipeSource: null,
    });
    const error = await runWith(runnerWithWorktrees([join(root, "wt")]).layer)(
      effect.pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(SourceResolverError);
    expect(error.reason).toContain(join(root, "odoo"));
    expect(error.reason).toContain("odoo-bin");
  });
});
