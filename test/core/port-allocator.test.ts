import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { derivePorts, fnv1a32, posixCksum } from "../../src/core/port-allocator.js";
import { ConfigValidationError } from "../../src/errors/errors.js";
import { runSyncFailure, runSyncSuccess } from "../helpers.js";

const ports = {
  odooBase: 18069,
  companionBase: 28028,
  range: 1000,
  hashAlgorithm: "fnv1a32",
} as const;

describe("fnv1a32", () => {
  it("is deterministic and 32-bit unsigned", () => {
    expect(fnv1a32("kl_123_payment_flow")).toBe(fnv1a32("kl_123_payment_flow"));
    expect(fnv1a32("a")).not.toBe(fnv1a32("b"));
    expect(fnv1a32("x")).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(fnv1a32("x"))).toBe(true);
  });
});

const LONG_INPUT = `kl_${"very_long_branch_segment_".repeat(12)}`; // 303 bytes: length needs 2 bytes

/** input → uint32, pinned from the macOS/Linux `cksum` binary (POSIX 1003.2 CRC). */
const CKSUM_VECTORS: ReadonlyArray<readonly [string, number]> = [
  ["kl_e2e_demo", 3289475723],
  ["kl_123_payment_flow", 1428013586],
  ["a", 1220704766],
  ["", 4294967295],
  [LONG_INPUT, 1920197004],
];

const cksumBinaryAvailable = (() => {
  const probe = spawnSync("cksum", { input: "" });
  return probe.error === undefined && probe.status === 0;
})();

describe("posixCksum", () => {
  it("matches the pinned POSIX cksum vectors", () => {
    for (const [input, expected] of CKSUM_VECTORS) {
      expect(posixCksum(input), JSON.stringify(input)).toBe(expected);
    }
  });

  it.runIf(cksumBinaryAvailable)("matches the system cksum binary byte for byte", () => {
    for (const [input] of CKSUM_VECTORS) {
      const result = spawnSync("cksum", { input });
      expect(result.status).toBe(0);
      const reported = Number.parseInt(result.stdout.toString().trim().split(/\s+/)[0]!, 10);
      expect(posixCksum(input), JSON.stringify(input)).toBe(reported);
    }
  });
});

describe("derivePorts", () => {
  it("derives odoo and companion ports from the same offset", () => {
    const result = runSyncSuccess(
      derivePorts({
        databaseName: "kl_123_payment_flow",
        ports,
        companionApps: [{ name: "pwa" }, { name: "mock" }],
        envHttpPort: undefined,
      }),
    );
    const offset = fnv1a32("kl_123_payment_flow") % 1000;
    expect(result.odooHttpPort).toBe(18069 + offset);
    expect(result.companionPorts.get("pwa")).toBe(28028 + offset);
    expect(result.companionPorts.get("mock")).toBe(28028 + offset + 1);
  });

  it("is stable across calls", () => {
    const a = runSyncSuccess(
      derivePorts({
        databaseName: "x_db",
        ports,
        companionApps: [],
        envHttpPort: undefined,
      }),
    );
    const b = runSyncSuccess(
      derivePorts({
        databaseName: "x_db",
        ports,
        companionApps: [],
        envHttpPort: undefined,
      }),
    );
    expect(a.odooHttpPort).toBe(b.odooHttpPort);
  });

  it("ODOO_HTTP_PORT env override wins for odoo only", () => {
    const result = runSyncSuccess(
      derivePorts({
        databaseName: "x_db",
        ports,
        companionApps: [{ name: "pwa" }],
        envHttpPort: "9999",
      }),
    );
    expect(result.odooHttpPort).toBe(9999);
    expect(result.companionPorts.get("pwa")).toBe(28028 + (fnv1a32("x_db") % 1000));
  });

  it("rejects a non-integer env port", () => {
    expect(
      runSyncFailure(
        derivePorts({ databaseName: "x_db", ports, companionApps: [], envHttpPort: "abc" }),
      ),
    ).toBeInstanceOf(ConfigValidationError);
  });

  it("ports.hashAlgorithm posix-cksum reproduces the bash `cksum % range` offsets", () => {
    const result = runSyncSuccess(
      derivePorts({
        databaseName: "kl_e2e_demo",
        ports: { ...ports, hashAlgorithm: "posix-cksum" },
        companionApps: [{ name: "pwa" }],
        envHttpPort: undefined,
      }),
    );
    const offset = 3289475723 % 1000; // posixCksum("kl_e2e_demo") % range
    expect(offset).not.toBe(fnv1a32("kl_e2e_demo") % 1000); // the algorithms actually diverge here
    expect(result.odooHttpPort).toBe(18069 + offset);
    expect(result.companionPorts.get("pwa")).toBe(28028 + offset);
  });
});
