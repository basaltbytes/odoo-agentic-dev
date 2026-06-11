import { createServer } from "node:net";
import { Context, Effect, Layer } from "effect";

export interface PortProbeApi {
  /** Bind test on 127.0.0.1. Never fails: any bind error means "not free". */
  readonly isFree: (port: number) => Effect.Effect<boolean>;
}

export const PortProbe = Context.Service<PortProbeApi>("odoo-agentic-dev/PortProbe");

export const PortProbeLive = Layer.succeed(PortProbe, {
  isFree: (port) =>
    Effect.callback<boolean>((resume) => {
      const server = createServer();
      server.once("error", () => resume(Effect.succeed(false)));
      server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
        server.close(() => resume(Effect.succeed(true)));
      });
    }),
});
