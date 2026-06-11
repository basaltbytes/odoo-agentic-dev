import { Effect } from "effect";
import { ConfigValidationError } from "../errors/errors.js";

/** FNV-1a 32-bit hash; stable basis for port offsets. */
export const fnv1a32 = (input: string): number => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
};

export const derivePorts = (options: {
  readonly databaseName: string;
  readonly ports: {
    readonly odooBase: number;
    readonly companionBase: number;
    readonly range: number;
  };
  readonly companionApps: ReadonlyArray<{ readonly name: string }>;
  readonly envHttpPort: string | undefined;
}): Effect.Effect<
  { readonly odooHttpPort: number; readonly companionPorts: ReadonlyMap<string, number> },
  ConfigValidationError
> => {
  const offset = fnv1a32(options.databaseName) % options.ports.range;

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
