import { describe, expect, it } from "vitest";
import { derivePorts, fnv1a32 } from "../../src/core/port-allocator.js";
import { ConfigValidationError } from "../../src/errors/errors.js";

const ports = { odooBase: 18069, companionBase: 28028, range: 1000 };

describe("fnv1a32", () => {
  it("is deterministic and 32-bit unsigned", () => {
    expect(fnv1a32("kl_123_payment_flow")).toBe(fnv1a32("kl_123_payment_flow"));
    expect(fnv1a32("a")).not.toBe(fnv1a32("b"));
    expect(fnv1a32("x")).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(fnv1a32("x"))).toBe(true);
  });
});

describe("derivePorts", () => {
  it("derives odoo and companion ports from the same offset", () => {
    const result = derivePorts({
      databaseName: "kl_123_payment_flow",
      ports,
      companionApps: [{ name: "pwa" }, { name: "mock" }],
      envHttpPort: undefined,
    });
    const offset = fnv1a32("kl_123_payment_flow") % 1000;
    expect(result.odooHttpPort).toBe(18069 + offset);
    expect(result.companionPorts.get("pwa")).toBe(28028 + offset);
    expect(result.companionPorts.get("mock")).toBe(28028 + offset + 1);
  });

  it("is stable across calls", () => {
    const a = derivePorts({
      databaseName: "x_db",
      ports,
      companionApps: [],
      envHttpPort: undefined,
    });
    const b = derivePorts({
      databaseName: "x_db",
      ports,
      companionApps: [],
      envHttpPort: undefined,
    });
    expect(a.odooHttpPort).toBe(b.odooHttpPort);
  });

  it("ODOO_HTTP_PORT env override wins for odoo only", () => {
    const result = derivePorts({
      databaseName: "x_db",
      ports,
      companionApps: [{ name: "pwa" }],
      envHttpPort: "9999",
    });
    expect(result.odooHttpPort).toBe(9999);
    expect(result.companionPorts.get("pwa")).toBe(28028 + (fnv1a32("x_db") % 1000));
  });

  it("rejects a non-integer env port", () => {
    expect(() =>
      derivePorts({ databaseName: "x_db", ports, companionApps: [], envHttpPort: "abc" }),
    ).toThrow(ConfigValidationError);
  });
});
