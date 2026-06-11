import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { PortProbe, PortProbeLive } from "../../src/platform/port-probe.js";
import { makeFakePortProbe } from "../../src/testing/fake-adapters.js";
import { runWith } from "../helpers.js";

const probeWithLive = (port: number): Promise<boolean> =>
  runWith(PortProbeLive)(
    Effect.gen(function* () {
      const probe = yield* PortProbe;
      return yield* probe.isFree(port);
    }),
  );

/** Hold a real listener on an ephemeral loopback port for the test's duration. */
const withHeldPort = async (use: (port: number) => Promise<void>): Promise<void> => {
  const server = createServer();
  const port = await new Promise<number>((resolve) => {
    server.listen({ port: 0, host: "127.0.0.1" }, () => {
      resolve((server.address() as { port: number }).port);
    });
  });
  try {
    await use(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

describe("PortProbeLive", () => {
  it("reports a held port as busy and a released port as free", async () => {
    let held = 0;
    await withHeldPort(async (port) => {
      held = port;
      expect(await probeWithLive(port)).toBe(false);
    });
    expect(await probeWithLive(held)).toBe(true);
  });
});

describe("makeFakePortProbe", () => {
  it("answers from the scripted busy set", async () => {
    const layer = makeFakePortProbe(new Set([18100]));
    const isFree = (port: number) =>
      runWith(layer)(
        Effect.gen(function* () {
          const probe = yield* PortProbe;
          return yield* probe.isFree(port);
        }),
      );
    expect(await isFree(18100)).toBe(false);
    expect(await isFree(18101)).toBe(true);
  });
});
