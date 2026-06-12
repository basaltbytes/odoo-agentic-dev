import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { performLinkSource } from "../../src/commands/link-source.js";
import { SourceResolverError } from "../../src/errors/errors.js";
import { runSyncFailure, runSyncSuccess } from "../helpers.js";

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
  return { project, source };
};

describe("performLinkSource", () => {
  it("creates a .odoo symlink to the resolved target", () => {
    const { project, source } = makeDirs();
    const linkPath = runSyncSuccess(
      performLinkSource({
        rootDir: project,
        target: source,
        name: ".odoo",
        force: false,
        recipeSource: null,
      }),
    );
    expect(linkPath).toBe(join(project, ".odoo"));
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(linkPath)).toBe(source);
  });

  it("refuses to overwrite a real directory", () => {
    const { project, source } = makeDirs();
    mkdirSync(join(project, ".odoo"));
    expect(
      runSyncFailure(
        performLinkSource({
          rootDir: project,
          target: source,
          name: ".odoo",
          force: false,
          recipeSource: null,
        }),
      ),
    ).toBeInstanceOf(SourceResolverError);
  });

  it("replaces an existing symlink only with force", () => {
    const { project, source } = makeDirs();
    symlinkSync(project, join(project, ".odoo"));
    expect(
      runSyncFailure(
        performLinkSource({
          rootDir: project,
          target: source,
          name: ".odoo",
          force: false,
          recipeSource: null,
        }),
      ).message,
    ).toMatch(/--force/);
    runSyncSuccess(
      performLinkSource({
        rootDir: project,
        target: source,
        name: ".odoo",
        force: true,
        recipeSource: null,
      }),
    );
    expect(readlinkSync(join(project, ".odoo"))).toBe(source);
  });

  it("falls back to recipe source, then errors with guidance", () => {
    const { project, source } = makeDirs();
    const linkPath = runSyncSuccess(
      performLinkSource({
        rootDir: project,
        target: undefined,
        name: ".odoo",
        force: false,
        recipeSource: source,
      }),
    );
    expect(readlinkSync(linkPath)).toBe(source);
    unlinkSync(linkPath);
    expect(
      runSyncFailure(
        performLinkSource({
          rootDir: project,
          target: undefined,
          name: ".odoo",
          force: false,
          recipeSource: null,
        }),
      ),
    ).toBeInstanceOf(SourceResolverError);
  });
});
