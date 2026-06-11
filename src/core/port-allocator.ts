import { Effect } from "effect";
import { ConfigValidationError } from "../errors/errors.js";

export type PortHashAlgorithm = "fnv1a32" | "posix-cksum";

/** FNV-1a 32-bit hash; stable basis for port offsets. */
export const fnv1a32 = (input: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

/**
 * POSIX 1003.2 `cksum` CRC: polynomial 0x04C11DB7 fed MSB-first with initial
 * value 0 over the UTF-8 message bytes, then over the message length encoded
 * least-significant byte first with leading zero bytes stripped (zero length
 * contributes no bytes), finally ones-complemented. Bit-for-bit identical to
 * the coreutils/BSD `cksum` binary — this is what reproduces the bash
 * `cksum <<< "$db" | awk '{print $1}'` port derivation.
 */
export const posixCksum = (input: string): number => {
  let crc = 0;
  const feed = (byte: number): void => {
    crc = (crc ^ (byte << 24)) >>> 0;
    for (let bit = 0; bit < 8; bit++) {
      crc = ((crc & 0x80000000) !== 0 ? (crc << 1) ^ 0x04c11db7 : crc << 1) >>> 0;
    }
  };
  const bytes = new TextEncoder().encode(input);
  for (const byte of bytes) feed(byte);
  for (let length = bytes.length; length > 0; length = Math.floor(length / 256)) {
    feed(length & 0xff);
  }
  return ~crc >>> 0;
};

const hashFor = (algorithm: PortHashAlgorithm): ((input: string) => number) =>
  algorithm === "posix-cksum" ? posixCksum : fnv1a32;

export const derivePorts = (options: {
  readonly databaseName: string;
  readonly ports: {
    readonly odooBase: number;
    readonly companionBase: number;
    readonly range: number;
    readonly hashAlgorithm: PortHashAlgorithm;
  };
  readonly companionApps: ReadonlyArray<{ readonly name: string }>;
  readonly envHttpPort: string | undefined;
}): Effect.Effect<
  { readonly odooHttpPort: number; readonly companionPorts: ReadonlyMap<string, number> },
  ConfigValidationError
> => {
  const offset = hashFor(options.ports.hashAlgorithm)(options.databaseName) % options.ports.range;

  let odooHttpPort = options.ports.odooBase + offset;
  if (options.envHttpPort !== undefined) {
    const parsed = Number.parseInt(options.envHttpPort, 10);
    if (
      !Number.isInteger(parsed) ||
      String(parsed) !== options.envHttpPort.trim() ||
      parsed < 1 ||
      parsed > 65535
    ) {
      return Effect.fail(
        new ConfigValidationError({
          issues: [`ODOO_HTTP_PORT must be an integer port, got "${options.envHttpPort}"`],
        }),
      );
    }
    odooHttpPort = parsed;
  }

  const companionPorts = new Map<string, number>();
  options.companionApps.forEach((app, index) => {
    companionPorts.set(app.name, options.ports.companionBase + offset + index);
  });

  return Effect.succeed({ odooHttpPort, companionPorts });
};
