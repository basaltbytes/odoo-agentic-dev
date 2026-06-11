import { Effect, Layer } from "effect";
import { CommandRunner } from "../platform/command-runner.js";
import type { CommandRunnerApi, ExecResult, ExecSpec } from "../platform/command-runner.js";
import { Git } from "../platform/git.js";
import type { GitApi } from "../platform/git.js";
import { StateStore } from "../platform/state-store.js";
import type { StateStoreApi } from "../platform/state-store.js";
import type { EnvironmentRow } from "../core/environment.js";
import type { GitState } from "../core/worktree-context.js";

/**
 * CommandRunner fake: records every call; `script` may return a result per
 * spec (default: exit 0, empty output).
 */
export const makeRecordingRunner = (
  script?: (spec: ExecSpec) => ExecResult | undefined,
): { readonly calls: Array<ExecSpec>; readonly layer: Layer.Layer<CommandRunnerApi> } => {
  const calls: Array<ExecSpec> = [];
  const respond = (spec: ExecSpec): ExecResult => {
    calls.push(spec);
    return script?.(spec) ?? { exitCode: 0, stdout: "", stderr: "" };
  };
  return {
    calls,
    layer: Layer.succeed(CommandRunner, {
      run: (spec) => Effect.sync(() => respond(spec)),
      runInherited: (spec) => Effect.sync(() => respond(spec).exitCode),
    }),
  };
};

export const makeFakeGit = (state: GitState): Layer.Layer<GitApi> =>
  Layer.succeed(Git, { state: () => Effect.succeed(state) });

/**
 * StateStore fake backed by an in-memory Map keyed by compose project. Mirrors
 * the live semantics exactly: upsert preserves createdAt/template fields on
 * existing rows while refreshing everything mutable plus lastUsedAt.
 */
export const makeFakeStateStore = (
  initial: ReadonlyArray<EnvironmentRow> = [],
): { readonly rows: Map<string, EnvironmentRow>; readonly layer: Layer.Layer<StateStoreApi> } => {
  const rows = new Map(initial.map((row) => [row.composeProject, row]));
  return {
    rows,
    layer: Layer.succeed(StateStore, {
      upsert: (env) =>
        Effect.sync(() => {
          const now = env.now ?? new Date().toISOString();
          const existing = rows.get(env.composeProject);
          rows.set(env.composeProject, {
            composeProject: env.composeProject,
            projectId: env.projectId,
            databaseName: env.databaseName,
            rootDir: env.rootDir,
            worktreeName: env.worktreeName,
            branch: env.branch,
            odooHttpPort: env.odooHttpPort,
            shared: env.shared,
            createdAt: existing?.createdAt ?? now,
            lastUsedAt: now,
            templateDb: existing?.templateDb ?? null,
            templateKey: existing?.templateKey ?? null,
          });
        }),
      touch: (composeProject) =>
        Effect.sync(() => {
          const existing = rows.get(composeProject);
          if (existing !== undefined) {
            rows.set(composeProject, { ...existing, lastUsedAt: new Date().toISOString() });
          }
        }),
      get: (composeProject) => Effect.sync(() => rows.get(composeProject)),
      list: (filter) =>
        Effect.sync(() =>
          [...rows.values()]
            .filter((row) => filter.projectId === undefined || row.projectId === filter.projectId)
            .sort((a, b) => a.composeProject.localeCompare(b.composeProject)),
        ),
      remove: (composeProject) =>
        Effect.sync(() => {
          rows.delete(composeProject);
        }),
      setTemplate: (composeProject, meta) =>
        Effect.sync(() => {
          const existing = rows.get(composeProject);
          if (existing !== undefined) {
            rows.set(composeProject, {
              ...existing,
              templateDb: meta?.databaseName ?? null,
              templateKey: meta?.key ?? null,
            });
          }
        }),
    }),
  };
};
