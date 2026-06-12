import { describe, expect, it } from "vitest";
import { DB_PREFIX_PATTERN } from "../../src/config/schema.js";
import { deriveDbPrefix, deriveProjectId, renderInitConfig } from "../../src/core/init-template.js";

describe("deriveProjectId", () => {
  it("lowercases and keeps a simple slug", () => {
    expect(deriveProjectId("KRISS-LAURE")).toBe("kriss-laure");
    expect(deriveProjectId("manywalls")).toBe("manywalls");
  });

  it("maps non-alphanumerics to '-' and collapses repeats", () => {
    expect(deriveProjectId("My  Cool__Project!!")).toBe("my-cool-project");
    expect(deriveProjectId("a___b   c")).toBe("a-b-c");
  });

  it("trims leading and trailing '-'", () => {
    expect(deriveProjectId("--foo--")).toBe("foo");
    expect(deriveProjectId("  spaced  ")).toBe("spaced");
  });

  it("prefixes 'odoo-' when the result does not start with a letter", () => {
    expect(deriveProjectId("123-app")).toBe("odoo-123-app");
    expect(deriveProjectId("9lives")).toBe("odoo-9lives");
  });

  it("collapses weird unicode to '-' and trims", () => {
    expect(deriveProjectId("café—münchen")).toBe("caf-m-nchen");
    expect(deriveProjectId("✨sparkle✨")).toBe("sparkle");
  });

  it("never returns empty (fallback 'odoo-project')", () => {
    expect(deriveProjectId("")).toBe("odoo-project");
    expect(deriveProjectId("!!!")).toBe("odoo-project");
    expect(deriveProjectId("---")).toBe("odoo-project");
    expect(deriveProjectId("123")).toBe("odoo-123");
  });

  it("is deterministic", () => {
    expect(deriveProjectId("KRISS LAURE")).toBe(deriveProjectId("KRISS LAURE"));
  });
});

describe("deriveDbPrefix", () => {
  it("multi-word slugs become initials", () => {
    expect(deriveDbPrefix("kriss-laure")).toBe("kl");
    expect(deriveDbPrefix("my-cool-project")).toBe("mcp");
  });

  it("single words truncate to 8 chars", () => {
    expect(deriveDbPrefix("manywalls")).toBe("manywall");
    expect(deriveDbPrefix("short")).toBe("short");
  });

  it("strips anything not [a-z0-9]", () => {
    expect(deriveDbPrefix("odoo-123-app")).toBe("o1a");
  });

  it("prefixes 'db' when the result does not start with a letter", () => {
    // initials of "9to5" style: single segment starting with a digit
    expect(deriveDbPrefix("9lives")).toBe("db9lives");
    // multi-word where the first initial is a digit
    expect(deriveDbPrefix("1-2-3")).toBe("db123");
  });

  it("never returns empty and always matches DB_PREFIX_PATTERN", () => {
    for (const id of [
      "kriss-laure",
      "manywalls",
      "odoo-123-app",
      "9lives",
      "1-2-3",
      "odoo-project",
      "a",
      "x-y-z-w",
    ]) {
      const prefix = deriveDbPrefix(id);
      expect(prefix.length).toBeGreaterThan(0);
      expect(prefix).toMatch(DB_PREFIX_PATTERN);
    }
  });

  it("is deterministic", () => {
    expect(deriveDbPrefix("kriss-laure")).toBe(deriveDbPrefix("kriss-laure"));
  });
});

describe("renderInitConfig", () => {
  it("renders a minimal defineConfig with project + odoo blocks", () => {
    const out = renderInitConfig({
      id: "kriss-laure",
      dbPrefix: "kl",
      odooVersion: "18.0",
      addonsHost: "addons",
    });
    expect(out.startsWith('import { defineConfig } from "@basaltbytes/odoo-agentic-dev";')).toBe(
      true,
    );
    expect(out).toContain("export default defineConfig(");
    expect(out).toContain('id: "kriss-laure"');
    expect(out).toContain('dbPrefix: "kl"');
    expect(out).toContain('version: "18.0"');
    expect(out).toContain("// adjust to your Odoo version");
    expect(out).toContain('host: "addons"');
    expect(out).toContain('container: "/mnt/extra-addons/custom"');
  });

  it("omits the addons adjust comment when the host is a real directory", () => {
    const out = renderInitConfig({
      id: "x",
      dbPrefix: "x",
      odooVersion: "18.0",
      addonsHost: "addons",
      addonsIsPlaceholder: false,
    });
    expect(out).not.toContain("// adjust to your addons directory");
  });

  it("adds the addons adjust comment when the host is a placeholder", () => {
    const out = renderInitConfig({
      id: "x",
      dbPrefix: "x",
      odooVersion: "18.0",
      addonsHost: "addons",
      addonsIsPlaceholder: true,
    });
    expect(out).toContain("// adjust to your addons directory");
  });

  it("is deterministic for the same inputs", () => {
    const opts = {
      id: "kriss-laure",
      dbPrefix: "kl",
      odooVersion: "18.0",
      addonsHost: "addons",
      addonsIsPlaceholder: true,
    } as const;
    expect(renderInitConfig(opts)).toBe(renderInitConfig(opts));
  });
});
