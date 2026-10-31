import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

const unnamed = (usage: string) => ({ message: `${usage} handles failures it does not name` });

export const unnamedRecoveriesNeedAGrant = Task.make(
  "no-unnamed-recovery refuses every operation that turns a failure it does not name into a success, a boolean or a value, in Effect, Stream, Channel, Layer, Sink, Fiber and Pull, whatever the handler returns and however it is imported, wrapped or aliased, and leaves recovery by name, mapping, tapping, observing and other modules alone",
  ruleTest("no-unnamed-recovery", {
    valid: [
      'import { Effect } from "effect"; work.pipe(Effect.catchTag("NotFound", () => Effect.succeed(null)));',
      'import { Effect } from "effect"; work.pipe(Effect.catchTags({ NotFound: () => Effect.void }));',
      'import { Effect } from "effect"; work.pipe(Effect.catchReason("Failure", "NotFound", () => Effect.void));',
      'import { Effect } from "effect"; work.pipe(Effect.mapError((error) => new Wrapped({ error })));',
      'import { Effect } from "effect"; work.pipe(Effect.tapError(report), Effect.tapCause(report), Effect.tapDefect(report));',
      'import { Effect } from "effect"; work.pipe(Effect.onExit(report), Effect.ensuring(cleanup), Effect.onError(report));',
      'import { Effect } from "effect"; work.pipe(Effect.timeout("1 second"), Effect.retry(policy));',
      'import { Fiber } from "effect"; export const joined = (fiber) => Fiber.join(fiber);',
      'import { Stream } from "effect"; work.pipe(Stream.catchTag("NotFound", () => Stream.empty));',
      'import { Effect } from "other"; work.pipe(Effect.catch(() => Effect.void), Effect.exit);',
      'import type { Effect } from "effect"; type Outcome = typeof Effect.exit;',
      'import { type exit } from "effect/Effect"; type Outcome = typeof exit;',
    ],
    invalid: [
      {
        code: 'import { Effect } from "effect"; work.pipe(Effect.catch((error) => Effect.fail(error)));',
        errors: [unnamed("Effect.catch")],
      },
      {
        code: 'import { Effect } from "effect"; export const succeeded = Effect.isSuccess(work);',
        errors: [unnamed("Effect.isSuccess")],
      },
      {
        code: 'import { isFailure } from "effect/Effect"; export const failed = work.pipe(isFailure);',
        errors: [unnamed("Effect.isFailure")],
      },
      {
        code: 'import { Stream } from "effect"; const recover = () => Stream.empty; export const recovered = Stream.fail("failure").pipe(Stream.catch(() => recover()));',
        errors: [unnamed("Stream.catch")],
      },
      {
        code: 'import { Stream } from "effect"; export const recovered = Stream.fail("failure").pipe(Stream.catch(() => { const fallback = Stream.empty; return fallback; }));',
        errors: [unnamed("Stream.catch")],
      },
      {
        code: 'import { Stream } from "effect"; const recover = () => Stream.empty; export const recovered = Stream.fail("failure").pipe(Stream.catch((error) => (error.length > 0 ? recover() : Stream.fail(error))));',
        errors: [unnamed("Stream.catch")],
      },
      {
        code: 'import { Effect } from "effect"; work.pipe(Effect.matchEffect({ onFailure: () => Effect.succeed(0), onSuccess: Effect.succeed }));',
        errors: [unnamed("Effect.matchEffect")],
      },
      {
        code: 'import { Effect } from "effect"; work.pipe(Effect.matchCauseEffect({ onFailure: () => Effect.void, onSuccess: () => Effect.void }));',
        errors: [unnamed("Effect.matchCauseEffect")],
      },
      {
        code: 'import { Effect } from "effect"; const outcome = Effect.exit(work);',
        errors: [unnamed("Effect.exit")],
      },
      {
        code: 'import { Effect } from "effect"; Effect.runPromiseExit(work);',
        errors: [unnamed("Effect.runPromiseExit")],
      },
      {
        code: 'import { Effect } from "effect"; work.pipe(Effect.ignore);',
        errors: [unnamed("Effect.ignore")],
      },
      {
        code: 'import { Effect } from "effect"; Effect.partition(items, check);',
        errors: [unnamed("Effect.partition")],
      },
      {
        code: 'import { Effect } from "effect"; Effect.race(first, second);',
        errors: [unnamed("Effect.race")],
      },
      {
        code: 'import { Fiber } from "effect"; export const awaited = (fiber) => Fiber.await(fiber);',
        errors: [unnamed("Fiber.await")],
      },
      {
        code: 'import { Pull } from "effect"; Pull.matchEffect(pull, handlers);',
        errors: [unnamed("Pull.matchEffect")],
      },
      {
        code: 'import { Layer } from "effect"; const live = make.pipe(Layer.catchCause(() => fallback));',
        errors: [unnamed("Layer.catchCause")],
      },
      {
        code: 'import { Sink } from "effect"; const sink = make.pipe(Sink.orElse(() => fallback));',
        errors: [unnamed("Sink.orElse")],
      },
      {
        code: 'import { Channel } from "effect"; work.pipe(Channel.catchIf(isMissing, recover));',
        errors: [unnamed("Channel.catchIf")],
      },
      {
        code: 'import { exit as outcome } from "effect/Effect"; const settled = outcome(work);',
        errors: [unnamed("Effect.exit")],
      },
      {
        code: 'import * as Effect from "effect/Effect"; work.pipe(Effect.result);',
        errors: [unnamed("Effect.result")],
      },
      {
        code: 'import * as Library from "effect"; work.pipe(Library.Effect.sandbox);',
        errors: [unnamed("Effect.sandbox")],
      },
      {
        code: 'import { Effect } from "effect"; work.pipe(Effect["match"]({ onFailure: () => 0, onSuccess: () => 1 }));',
        errors: [unnamed("Effect.match")],
      },
      {
        code: 'import { Effect } from "effect"; const hidden = Effect.exit satisfies typeof Effect.exit;',
        errors: [unnamed("Effect.exit")],
      },
      {
        code: 'import { catch as recover, empty, fail } from "effect/Stream"; const hidden = recover satisfies typeof recover; export const recovered = fail("failure").pipe(hidden(() => empty));',
        errors: [unnamed("Stream.catch")],
      },
    ],
  }),
);

export const unnamedRecoveriesInStreamsChannelsLayersAndSinks = Task.make(
  "no-unnamed-recovery refuses catch-alls and predicate recoveries in Stream, Channel, Layer and Sink, imported directly, by namespace or spread into a call",
  ruleTest("no-unnamed-recovery", {
    valid: [
      'import { Stream } from "effect"; work.pipe(Stream.catchTags({ NotFound: () => Stream.empty }));',
    ],
    invalid: [
      ...[
        'import { Stream } from "effect"; work.pipe(Stream.catch(() => Stream.empty));',
        'import { Stream } from "effect"; const recover = () => Stream.empty; export const recovered = Stream.fail("failure").pipe(Stream.catch(() => recover()));',
        'import { Stream } from "effect"; export const recovered = Stream.fail("failure").pipe(Stream.catch(() => { const fallback = Stream.empty; return fallback; }));',
        'import { Stream } from "effect"; const recover = () => Stream.empty; export const recovered = Stream.fail("failure").pipe(Stream.catch((error) => (error.length > 0 ? recover() : Stream.fail(error))));',
        'import { Stream } from "effect"; const recover = () => Stream.empty; export const recovered = Stream.fail("failure").pipe(Stream.catch(recover));',
        'import { Stream } from "effect"; const recovery = { recover: Stream.catch };',
      ].map((code) => ({
        code,
        errors: [{ message: "Stream.catch handles failures it does not name" }],
      })),
      {
        code: 'import { Effect } from "effect"; const recover = () => Effect.void; export const recovered = Effect.fail("failure").pipe(Effect.catch(() => recover()));',
        errors: [{ message: "Effect.catch handles failures it does not name" }],
      },
      {
        code: 'import { catch as recover, empty, fail } from "effect/Stream"; const hidden = recover satisfies typeof recover; export const recovered = fail("failure").pipe(hidden(() => empty));',
        errors: [{ message: "Stream.catch handles failures it does not name" }],
      },
      {
        code: 'import { catchCause } from "effect/Stream"; work.pipe(catchCause(...handlers));',
        errors: [{ message: "Stream.catchCause handles failures it does not name" }],
      },
      {
        code: 'import { Stream } from "effect"; work.pipe(Stream.catchDefect(() => Stream.empty));',
        errors: [{ message: "Stream.catchDefect handles failures it does not name" }],
      },
      {
        code: 'import { Stream } from "effect"; work.pipe(Stream.catchIf(isMissing, () => Stream.empty));',
        errors: [
          {
            message: "Stream.catchIf handles failures it does not name",
          },
        ],
      },
      {
        code: 'import { Channel } from "effect"; work.pipe(Channel.catch(() => Channel.empty));',
        errors: [{ message: "Channel.catch handles failures it does not name" }],
      },
      {
        code: 'import * as Channel from "effect/Channel"; work.pipe(Channel.catchCauseFilter(isMissing, recover));',
        errors: [
          {
            message: "Channel.catchCauseFilter handles failures it does not name",
          },
        ],
      },
      {
        code: 'import { Layer } from "effect"; const live = make.pipe(Layer.catch(() => fallback));',
        errors: [{ message: "Layer.catch handles failures it does not name" }],
      },
      {
        code: 'import { Layer } from "effect"; const live = make.pipe(Layer.catchCause(() => fallback));',
        errors: [{ message: "Layer.catchCause handles failures it does not name" }],
      },
      {
        code: 'import { Sink } from "effect"; const sink = make.pipe(Sink.orElse(() => fallback));',
        errors: [{ message: "Sink.orElse handles failures it does not name" }],
      },
      {
        code: 'import { catch as recover } from "effect/Sink"; export const sink = make.pipe(recover(() => fallback));',
        errors: [{ message: "Sink.catch handles failures it does not name" }],
      },
    ],
  }),
);

export const failuresAsResultsNeedAGrant = Task.make(
  "no-failures-as-results refuses Effect.all collecting failures as results and Effect.all given options it can't read, and leaves the default mode, other options and other modules alone",
  ruleTest("no-failures-as-results", {
    valid: [
      'import { Effect } from "effect"; Effect.all(works);',
      'import { Effect } from "effect"; Effect.all(works, { concurrency: "unbounded", discard: true });',
      'import { Effect } from "effect"; Effect.all(works, { mode: "default" });',
      'import { Effect } from "effect"; Effect.all(works, { ["concurrency"]: 2, "discard": true });',
      'import { all } from "effect/Effect"; all(works, { concurrency: 2 });',
      'import { Effect } from "other"; Effect.all(works, { mode: "result" });',
    ],
    invalid: [
      {
        code: 'import { Effect } from "effect"; Effect.all(works, { mode: "result" });',
        errors: [{ message: "Effect.all turns each failure into a result" }],
      },
      {
        code: 'import { all } from "effect/Effect"; all(works, { concurrency: 2, mode });',
        errors: [{ message: "Effect.all turns each failure into a result" }],
      },
      {
        code: 'import { Effect } from "effect"; Effect.all(works, options);',
        errors: [{ message: "Effect.all is given options that are not written inline" }],
      },
      {
        code: 'import { Effect } from "effect"; Effect.all(works, { ...options });',
        errors: [{ message: "Effect.all is given options that are not written inline" }],
      },
      {
        code: 'import { Effect } from "effect"; const MODE = "mode"; export const recovered = Effect.all([Effect.fail("failure")], { [MODE]: "result" }).pipe(Effect.asVoid);',
        errors: [{ message: "Effect.all is given options that are not written inline" }],
      },
    ],
  }),
);

export const failureBearingValuesNeedAGrant = Task.make(
  "no-unnamed-recovery refuses every operation that turns a failure into an outcome value, however that value is used afterwards, and leaves the first-to-finish races and the Result helpers alone, since only a refused operation can turn a failure into a Result",
  ruleTest("no-unnamed-recovery", {
    valid: [
      'import { Effect } from "effect"; export const raced = Effect.raceFirst(Effect.fail("failure"), Effect.void);',
      'import { Effect } from "effect"; export const raced = Effect.raceAllFirst([Effect.fail("failure"), Effect.void]);',
      'import { Result } from "effect"; export const success = (result) => Result.getSuccess(result);',
      'import { Option } from "effect"; export const value = Option.getOrElse(Option.none(), () => "fallback");',
      'import { Result } from "effect"; export const recovered = (result) => Result.orElse(result, () => Result.succeed("fallback"));',
      'import { getOrElse } from "effect/Result"; export const recovered = (result) => getOrElse(result, () => "fallback");',
      'import { Result } from "effect"; export const chosen = (result) => Result.match(result, { onFailure: () => "fallback", onSuccess: () => "ok" });',
    ],
    invalid: [
      {
        code: 'import { Effect } from "effect"; export const program = Effect.fail("failure").pipe(Effect.exit, Effect.asVoid);',
        errors: [unnamed("Effect.exit")],
      },
      {
        code: 'import { Effect } from "effect"; export const program = Effect.result(Effect.fail("failure")).pipe(Effect.asVoid);',
        errors: [unnamed("Effect.result")],
      },
      {
        code: 'import { Effect } from "effect"; export const program = Effect.fail("failure").pipe(Effect.matchEffect({ onFailure: () => Effect.void, onSuccess: () => Effect.void }));',
        errors: [unnamed("Effect.matchEffect")],
      },
      {
        code: 'import { Effect } from "effect"; export const program = Effect.fail("failure").pipe(Effect.match({ onFailure: () => "fallback", onSuccess: () => "value" }));',
        errors: [unnamed("Effect.match")],
      },
      {
        code: 'import { Effect, Result } from "effect"; export const program = Effect.fail("failure").pipe(Effect.result, Effect.map((result) => Result.getOrElse(result, () => "fallback")));',
        errors: [unnamed("Effect.result")],
      },
      {
        code: 'import { Stream } from "effect"; export const program = Stream.fail("failure").pipe(Stream.result, Stream.runDrain);',
        errors: [unnamed("Stream.result")],
      },
      {
        code: 'import { Effect } from "effect"; export const program = Effect.fail("failure").pipe(Effect.flip, Effect.asVoid);',
        errors: [unnamed("Effect.flip")],
      },
      {
        code: 'import { Effect, Schedule } from "effect"; export const recovered = Effect.fail("failure").pipe(Effect.repeatOrElse(Schedule.recurs(0), () => Effect.succeed(0)));',
        errors: [unnamed("Effect.repeatOrElse")],
      },
      {
        code: 'import { Effect } from "effect"; export const raced = Effect.race(Effect.fail("failure"), Effect.void);',
        errors: [unnamed("Effect.race")],
      },
      {
        code: 'import { Effect } from "effect"; export const raced = Effect.raceAll([Effect.fail("failure"), Effect.void]);',
        errors: [unnamed("Effect.raceAll")],
      },
      {
        code: 'import { Stream } from "effect"; export const streamed = Stream.race(Stream.fail("failure"), Stream.make("fallback")).pipe(Stream.runDrain);',
        errors: [unnamed("Stream.race")],
      },
      {
        code: 'import { Stream } from "effect"; export const streamed = Stream.raceAll(Stream.fail("failure"), Stream.make("fallback"));',
        errors: [unnamed("Stream.raceAll")],
      },
    ],
  }),
);

export const timeoutsPassWithoutAGrant = Task.make(
  "no-unnamed-recovery leaves timeouts alone, since they handle only the deadline and keep every failure",
  ruleTest("no-unnamed-recovery", {
    valid: [
      'import { Effect } from "effect"; export const bounded = (work) => work.pipe(Effect.timeout("1 second"));',
      'import { Effect } from "effect"; export const bounded = (work) => work.pipe(Effect.timeoutOption("1 second"));',
      'import { Effect } from "effect"; export const bounded = (work) => Effect.timeoutOrElse(work, { duration: "1 second", orElse: () => Effect.void });',
      'import { Stream } from "effect"; export const bounded = (stream) => stream.pipe(Stream.timeoutOrElse({ duration: "1 second", orElse: () => Stream.empty }));',
      'import { timeoutOption } from "effect/Effect"; export const bounded = (work) => timeoutOption(work, "1 second");',
    ],
    invalid: [],
  }),
);

export const failuresStoredOrObservedNeedAGrant = Task.make(
  "no-unnamed-recovery refuses every operation that runs work and stores or hands over its outcome, so a failure ends up in a Deferred, a Queue, a PubSub, an observer or a polled Exit instead of failing the caller, including a fiber's or runtime's outcome members read through any receiver or destructured",
  ruleTest("no-unnamed-recovery", {
    valid: [
      'import { Deferred, Effect } from "effect"; export const settled = (deferred) => Effect.flatMap(Deferred.await(deferred), Effect.succeed);',
      'import { Deferred } from "effect"; export const finished = (deferred) => Deferred.succeed(deferred, 1);',
      'import { Queue } from "effect"; export const next = (queue) => Queue.take(queue);',
    ],
    invalid: [
      {
        code: 'import { Deferred, Effect } from "effect"; export const recovered = Effect.gen(function* () { const deferred = yield* Deferred.make(); return yield* Deferred.complete(deferred, Effect.fail("failure")); });',
        errors: [unnamed("Deferred.complete")],
      },
      {
        code: 'import { Deferred, Effect } from "effect"; export const recovered = Effect.gen(function* () { const deferred = yield* Deferred.make(); return yield* Deferred.into(Effect.fail("failure"), deferred); });',
        errors: [unnamed("Deferred.into")],
      },
      {
        code: 'import { Effect, Queue } from "effect"; export const recovered = Effect.gen(function* () { const queue = yield* Queue.unbounded(); return yield* Queue.into(Effect.fail("failure"), queue); });',
        errors: [unnamed("Queue.into")],
      },
      {
        code: 'import { Effect, Queue, Stream } from "effect"; export const recovered = Effect.gen(function* () { const queue = yield* Queue.unbounded(); yield* Stream.runIntoQueue(Stream.fail("failure"), queue); });',
        errors: [unnamed("Stream.runIntoQueue")],
      },
      {
        code: 'import { Channel } from "effect"; export const fed = (channel, queue) => Channel.runIntoQueue(channel, queue);',
        errors: [unnamed("Channel.runIntoQueue")],
      },
      {
        code: 'import { Stream } from "effect"; export const queued = (stream) => Stream.toQueue(stream, { capacity: 1 });',
        errors: [unnamed("Stream.toQueue")],
      },
      {
        code: 'import { Stream } from "effect"; export const published = (stream, pubsub) => Stream.runIntoPubSub(stream, pubsub);',
        errors: [unnamed("Stream.runIntoPubSub")],
      },
      {
        code: 'import { Queue } from "effect"; export const polled = (queue) => Queue.poll(queue);',
        errors: [unnamed("Queue.poll")],
      },
      {
        code: 'import { takeUnsafe } from "effect/Queue"; export const taken = (queue) => takeUnsafe(queue);',
        errors: [unnamed("Queue.takeUnsafe")],
      },
      {
        code: 'import { Effect, Exit, Result } from "effect"; export const recovered = Effect.gen(function* () { const fiber = yield* Effect.forkChild(Effect.fail("failure")); const exit = yield* Effect.callback((resume) => { fiber.addObserver((value) => { resume(Effect.succeed(value)); }); }); return Result.match(Exit.filterValue(exit), { onFailure: () => "fallback", onSuccess: () => "ok" }); });',
        errors: [unnamed("Effect.forkChild"), unnamed("addObserver")],
      },
      {
        code: 'import { Effect, Exit, Option } from "effect"; export const recovered = Effect.gen(function* () { const fiber = yield* Effect.forkChild(Effect.fail("failure")); yield* Effect.yieldNow; const exit = fiber.pollUnsafe(); return exit === undefined ? "pending" : Option.getOrElse(Exit.getSuccess(exit), () => "fallback"); });',
        errors: [unnamed("Effect.forkChild"), unnamed("pollUnsafe")],
      },
      {
        code: 'import { Effect } from "effect"; export const observed = (record) => { const { addObserver } = Effect.runFork(work); return addObserver(record); };',
        errors: [unnamed("addObserver"), unnamed("Effect.runFork")],
      },
      {
        code: 'import { Effect } from "effect"; export const settled = (record) => Effect.runCallback(work, { onExit: record });',
        errors: [unnamed("Effect.runCallback")],
      },
      {
        code: "export const settled = (runtime, work) => runtime.runPromiseExit(work);",
        errors: [unnamed("runPromiseExit")],
      },
      {
        code: 'export const settled = (runtime, work) => runtime["runSyncExit"](work);',
        errors: [unnamed("runSyncExit")],
      },
    ],
  }),
);

export const failuresLeavingTheCallerNeedAGrant = Task.make(
  "no-unnamed-recovery refuses forking work, whose failure no longer fails the caller, and every runner that hands a failure to JavaScript as a rejection, a throw or an observed fiber, including a runtime's runner members and the fiber collections' runners, and leaves observers of work that still fails its caller alone",
  ruleTest("no-unnamed-recovery", {
    valid: [
      'import { Deferred, Effect } from "effect"; export const signalled = (done, work) => work.pipe(Effect.onExit((exit) => Deferred.succeed(done, exit)));',
      'import { Deferred, Effect } from "effect"; export const signalled = (done, work) => work.pipe(Effect.tapCause(() => Deferred.succeed(done, "fallback")));',
      'import { Effect } from "effect"; export const stopped = (work) => work.pipe(Effect.ensuring(Effect.log("stopped")));',
    ],
    invalid: [
      {
        code: 'import { Deferred, Effect, Exit, Result } from "effect"; export const recovered = Effect.gen(function* () { const done = yield* Deferred.make(); yield* Effect.forkChild(Effect.fail("failure").pipe(Effect.onExit((exit) => Deferred.succeed(done, exit)))); const exit = yield* Deferred.await(done); return Result.getOrElse(Exit.filterValue(exit), () => "fallback"); });',
        errors: [unnamed("Effect.forkChild")],
      },
      {
        code: 'import { Deferred, Effect } from "effect"; export const recovered = Effect.gen(function* () { const done = yield* Deferred.make(); yield* Effect.forkChild(Effect.fail("failure").pipe(Effect.tapCause(() => Deferred.succeed(done, "fallback")))); return yield* Deferred.await(done); });',
        errors: [unnamed("Effect.forkChild")],
      },
      {
        code: 'import { Effect } from "effect"; export const background = (work) => work.pipe(Effect.forkScoped);',
        errors: [unnamed("Effect.forkScoped")],
      },
      {
        code: 'import { forkIn } from "effect/Effect"; export const background = (work, scope) => forkIn(work, scope);',
        errors: [unnamed("Effect.forkIn")],
      },
      {
        code: 'import { Effect } from "effect"; export const recover = () => Effect.runPromise(Effect.fail("failure")).catch(() => "fallback");',
        errors: [unnamed("Effect.runPromise")],
      },
      {
        code: 'import { Effect } from "effect"; export const recovered = Effect.promise(() => Effect.runPromise(Effect.fail("failure")).catch(() => "fallback"));',
        errors: [unnamed("Effect.runPromise")],
      },
      {
        code: 'import { Effect } from "effect"; export const recover = () => { try { return Effect.runSync(Effect.fail("failure")); } catch { return "fallback"; } };',
        errors: [unnamed("Effect.runSync")],
      },
      {
        code: 'import { Effect } from "effect"; export const started = (context, work) => [Effect.runForkWith(context)(work), Effect.runPromiseWith(context)(work), Effect.runSyncWith(context)(work)];',
        errors: [
          unnamed("Effect.runForkWith"),
          unnamed("Effect.runPromiseWith"),
          unnamed("Effect.runSyncWith"),
        ],
      },
      {
        code: 'export const recover = (runtime, work) => runtime.runPromise(work).catch(() => "fallback");',
        errors: [unnamed("runPromise")],
      },
      {
        code: 'export const recover = (runtime, work) => { const { runSync } = runtime; try { return runSync(work); } catch { return "fallback"; } };',
        errors: [unnamed("runSync")],
      },
      {
        code: "export const started = (runtime, work) => runtime.runFork(work);",
        errors: [unnamed("runFork")],
      },
      {
        code: 'import { FiberSet } from "effect"; export const background = (set, work) => FiberSet.run(set, work);',
        errors: [unnamed("FiberSet.run")],
      },
      {
        code: 'import { FiberMap, FiberHandle } from "effect"; export const runners = (map, handle) => [FiberMap.runtime(map), FiberHandle.runtimePromise(handle)];',
        errors: [unnamed("FiberMap.runtime"), unnamed("FiberHandle.runtimePromise")],
      },
    ],
  }),
);

export const workRunApartFromItsCallerNeedsAGrant = Task.make(
  "no-unnamed-recovery refuses every operation that runs work apart from its caller, so the work's failure reaches the caller only if nothing ends the run first: stream and channel callbacks, pools that acquire in the background, conversions of a stream into a JavaScript iterable or readable stream, and main runners, however a runner is imported or reached, and leaves observers of work that still fails its caller alone",
  ruleTest("no-unnamed-recovery", {
    valid: [
      'import { Effect } from "effect"; export const observed = (report) => Effect.fail("failure").pipe(Effect.onExit(report), Effect.tapCause(report), Effect.tapError(report), Effect.ensuring(Effect.void));',
      'import { Layer } from "effect"; export const launched = (layer) => Layer.launch(layer);',
      'import { Stream } from "effect"; export const read = (iterable, onError) => Stream.fromAsyncIterable(iterable, onError);',
    ],
    invalid: [
      {
        code: 'import { Effect, Queue, Stream } from "effect"; export const recovered = Stream.callback((queue) => Stream.runForEach(Stream.fail("failure"), (value) => Queue.offer(queue, value)).pipe(Effect.tapCause(() => Queue.end(queue)))).pipe(Stream.runCollect);',
        errors: [unnamed("Stream.callback")],
      },
      {
        code: 'import { Channel, Effect, Queue } from "effect"; export const recovered = Channel.callback((queue) => Effect.fail("failure").pipe(Effect.tapCause(() => Queue.end(queue)))).pipe(Channel.runCollect);',
        errors: [unnamed("Channel.callback")],
      },
      {
        code: 'import { Effect, Queue, Stream } from "effect"; export const recovered = Stream.callback((queue) => Effect.fail("failure").pipe(Effect.ensuring(Queue.end(queue)))).pipe(Stream.runCollect);',
        errors: [unnamed("Stream.callback")],
      },
      {
        code: 'import { Effect, Queue, Stream } from "effect"; export const recovered = Stream.callback((queue) => Effect.gen(function* () { yield* Queue.end(queue); return yield* Effect.fail("failure"); })).pipe(Stream.runCollect);',
        errors: [unnamed("Stream.callback")],
      },
      {
        code: 'import { callbackArray } from "effect/Channel"; export const bridged = (register) => callbackArray(register);',
        errors: [unnamed("Channel.callbackArray")],
      },
      {
        code: 'import { Deferred, Effect, Pool } from "effect"; export const recovered = Effect.scoped(Effect.gen(function* () { const done = yield* Deferred.make(); yield* Pool.make({ acquire: Effect.fail("failure").pipe(Effect.tapCause(() => Deferred.succeed(done, "fallback"))), size: 1 }); return yield* Deferred.await(done); }));',
        errors: [unnamed("Pool.make")],
      },
      {
        code: 'import { Deferred, Effect, Pool } from "effect"; export const recovered = Effect.scoped(Effect.gen(function* () { const done = yield* Deferred.make(); yield* Pool.makeWithTTL({ acquire: Effect.fail("failure").pipe(Effect.ensuring(Deferred.succeed(done, "fallback"))), min: 1, max: 1, timeToLive: "1 second" }); return yield* Deferred.await(done); }));',
        errors: [unnamed("Pool.makeWithTTL")],
      },
      {
        code: 'import { BunRuntime } from "@effect/platform-bun"; import { Effect } from "effect"; export const recovered = Effect.callback((resume) => { BunRuntime.runMain(Effect.fail("failure"), { disableErrorReporting: true, teardown: (_exit, onExit) => { resume(Effect.succeed("fallback")); onExit(0); } }); });',
        errors: [unnamed("runMain")],
      },
      {
        code: 'import { runMain as start } from "@effect/platform-node/NodeRuntime"; export const started = (program) => start(program);',
        errors: [unnamed("runMain from @effect/platform-node/NodeRuntime")],
      },
      {
        code: 'import { BunRuntime } from "@effect/platform-bun"; const { runMain } = BunRuntime; export const started = (program) => runMain(program);',
        errors: [unnamed("runMain")],
      },
      {
        code: 'import { Runtime } from "effect"; export const runMain = Runtime.makeRunMain(({ fiber }) => fiber);',
        errors: [unnamed("Runtime.makeRunMain")],
      },
      {
        code: 'import { Stream } from "effect"; export const iterated = (stream) => [Stream.toAsyncIterable(stream), Stream.toReadableStream(stream)];',
        errors: [unnamed("Stream.toAsyncIterable"), unnamed("Stream.toReadableStream")],
      },
    ],
  }),
);
