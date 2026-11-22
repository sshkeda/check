import { Context, Deferred, Effect, Option, Predicate, Schema } from "effect";
import type { Duration } from "effect";
import { API } from "typescript/unstable/async";
import type { InternalAPI } from "typescript/unstable/async";

import {
  TypeScriptApiFailed,
  TypeScriptApiProcessStopped,
} from "./project-config-and-tool-errors.ts";

const TYPESCRIPT_REQUEST_DEADLINE = "10 minutes";

const EXIT_DEADLINE = "10 seconds";

const STARTING = "start";

const CLIENT_CHANGED = "the TypeScript API client no longer exposes the process Check watches";

const CLOSED = "the TypeScript API was closed";

const OUTPUT_CLOSED = "the TypeScript API process closed its output";

const TERMINATING_SIGNAL = "SIGKILL";

const API_CLIENT_FIELD = "client";

const CLIENT_PROCESS_FIELD = "process";

export const TypeScriptApiLaunch = Context.Reference<{
  readonly tsserverPath?: string;
  readonly requestDeadline: `${number} ${Duration.Unit}`;
}>("@sshkeda/check/TypeScriptApiLaunch", {
  defaultValue: () => ({ requestDeadline: TYPESCRIPT_REQUEST_DEADLINE }),
});

const CLIENT_MEMBERS = [
  "connect",
  "apiRequest",
  "close",
] as const satisfies readonly (keyof ConstructorParameters<typeof InternalAPI>[0])[];

const TYPESCRIPT_API_CLIENT = Schema.declare(
  (value): value is ConstructorParameters<typeof InternalAPI>[0] =>
    CLIENT_MEMBERS.every((member) => Predicate.hasProperty(value, member)),
);

const PROCESS_MEMBERS = ["once", "on", "kill", "stdout", "exitCode", "signalCode"] as const;

const OUTPUT_MEMBERS = ["once", "destroyed"] as const;

const isWatchableProcess = Schema.is(
  Schema.declare(
    (
      value,
    ): value is {
      readonly stdout: {
        readonly destroyed: boolean;
        once(event: "close", listener: () => void): void;
      } | null;
      readonly exitCode: number | null;
      readonly signalCode: NodeJS.Signals | null;
      once(
        event: "exit",
        listener: (code: number | null, signal: NodeJS.Signals | null) => void,
      ): void;
      on(event: "error", listener: (error: Error) => void): void;
      kill(signal: NodeJS.Signals): boolean;
    } => {
      const hasProcessMembers = PROCESS_MEMBERS.every((member) =>
        Predicate.hasProperty(value, member),
      );
      const output = Predicate.hasProperty(value, "stdout") ? value.stdout : undefined;
      const hasOutputMembers =
        output === null || OUTPUT_MEMBERS.every((member) => Predicate.hasProperty(output, member));
      return hasProcessMembers && hasOutputMembers;
    },
  ),
);

const stopWith = (
  stopped: Deferred.Deferred<never, TypeScriptApiProcessStopped>,
  child: { kill(signal: NodeJS.Signals): boolean },
  reason: string,
) => {
  Deferred.doneUnsafe(stopped, Effect.fail(new TypeScriptApiProcessStopped({ reason })));
  child.kill(TERMINATING_SIGNAL);
};

const exitReason = (code: number | null, signal: NodeJS.Signals | null, outputClosed: boolean) => {
  if (code !== null) {
    return `the TypeScript API process exited with code ${code}`;
  }
  return outputClosed ? OUTPUT_CLOSED : `the TypeScript API process exited on signal ${signal}`;
};

const watchedProcess = (
  client: ConstructorParameters<typeof InternalAPI>[0],
  stopped: Deferred.Deferred<never, TypeScriptApiProcessStopped>,
  exited: Deferred.Deferred<void>,
) => {
  const child: unknown = client[CLIENT_PROCESS_FIELD];
  if (!isWatchableProcess(child)) {
    return Option.none();
  }
  const output = { closed: false };
  const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    stopWith(stopped, child, exitReason(code, signal, output.closed));
    Deferred.doneUnsafe(exited, Effect.void);
  };
  const onOutputClosed = () => {
    output.closed = true;
    child.kill(TERMINATING_SIGNAL);
  };
  child.once("exit", onExit);
  child.on("error", (error) => {
    stopWith(stopped, child, `the TypeScript API process failed: ${error.message}`);
  });
  child.stdout?.once("close", onOutputClosed);
  const hasExited = child.exitCode !== null || child.signalCode !== null;
  if (hasExited) {
    onExit(child.exitCode, child.signalCode);
  }
  if (child.stdout?.destroyed === true) {
    onOutputClosed();
  }
  return Option.some(child);
};

const startupFailed = (reason: string) => new TypeScriptApiFailed({ operation: STARTING, reason });

const startupStep = <Value>(step: () => Promise<Value>) =>
  Effect.tryPromise({ try: step, catch: (cause) => startupFailed(String(cause)) });

const answered = <Answer>(
  stopped: Deferred.Deferred<never, TypeScriptApiProcessStopped>,
  child: Parameters<typeof stopWith>[1],
  requestDeadline: `${number} ${Duration.Unit}`,
  request: () => Promise<Answer>,
) =>
  Effect.gen(function* () {
    if (yield* Deferred.isDone(stopped)) {
      return yield* Deferred.await(stopped);
    }
    return yield* Effect.raceFirst(Effect.promise(request), Deferred.await(stopped)).pipe(
      Effect.timeoutOrElse({
        duration: requestDeadline,
        orElse: () =>
          Effect.sync(() => {
            stopWith(
              stopped,
              child,
              `the TypeScript API process did not answer within ${requestDeadline}`,
            );
          }).pipe(Effect.andThen(Deferred.await(stopped))),
      }),
    );
  });

const startedSession = (sourceTextOverrides: ReadonlyMap<string, string>) =>
  Effect.gen(function* () {
    const { requestDeadline, ...spawnOptions } = yield* TypeScriptApiLaunch;
    const api = new API(
      sourceTextOverrides.size === 0
        ? spawnOptions
        : { ...spawnOptions, fs: { readFile: (fileName) => sourceTextOverrides.get(fileName) } },
    );
    const client = yield* Schema.decodeUnknownEffect(TYPESCRIPT_API_CLIENT)(
      api[API_CLIENT_FIELD],
    ).pipe(Effect.mapError(() => startupFailed(CLIENT_CHANGED)));
    const stopped = yield* Deferred.make<never, TypeScriptApiProcessStopped>();
    const exited = yield* Deferred.make<void>();
    yield* startupStep(() => client.connect());
    const watched = yield* Effect.try({
      try: () => watchedProcess(client, stopped, exited),
      catch: (cause) => startupFailed(String(cause)),
    });
    if (Option.isNone(watched)) {
      yield* startupStep(() => client.close());
      return yield* startupFailed(CLIENT_CHANGED);
    }
    const child = watched.value;
    const runPromise = Effect.runPromiseWith(yield* Effect.context());
    const send = client.apiRequest.bind(client);
    client.apiRequest = <Answer>(...request: Parameters<typeof send>) =>
      runPromise(answered(stopped, child, requestDeadline, () => send<Answer>(...request)));
    return { api, client, child, stopped, exited };
  });

const closedSession = ({
  client,
  child,
  stopped,
  exited,
}: Effect.Success<ReturnType<typeof startedSession>>) =>
  Effect.gen(function* () {
    stopWith(stopped, child, CLOSED);
    yield* Effect.promise(() => client.close());
    yield* Deferred.await(exited).pipe(Effect.timeoutOption(EXIT_DEADLINE));
  });

export const openedApi = (sourceTextOverrides: ReadonlyMap<string, string>) =>
  Effect.acquireRelease(startedSession(sourceTextOverrides), closedSession).pipe(
    Effect.map(({ api }) => api),
  );
