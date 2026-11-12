import { expect } from "bun:test";

import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path } from "effect";
import type { Duration } from "effect";
import type { API } from "typescript/unstable/async";

import { encodeJson } from "../../src/lib/tasks/shared/encode-compact-json.ts";
import { typeScriptRequest } from "../../src/lib/tasks/shared/query-the-typescript-project.ts";
import {
  openedApi,
  TypeScriptApiLaunch,
} from "../../src/lib/tasks/shared/watch-the-typescript-api-process.ts";
import { FORMAT_CONFIG_TEXT, linkNodeModulesWithCheck } from "../shared/checked-project.ts";
import { failureAsValue } from "../shared/failure-as-value.ts";
import { encodeIndentedJson } from "../shared/indented-json.ts";
import { runTaskFile } from "../shared/run-task-files.ts";

const WATCHDOG = "2 minutes";

const EXECUTABLE = 0o755;

const NO_REAL_EXECUTABLE = "-";

const REAP_ATTEMPTS = 100;

const FAKE_TYPESCRIPT_API = `import { appendFileSync, closeSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";
const [mode, trigger, exePathModule, realProcesses, ...clientArguments] = process.argv.slice(2);
const real = mode === "proxy"
  ? spawn((await import(exePathModule)).default(), clientArguments, { stdio: ["pipe", "pipe", "inherit"] })
  : undefined;
if (real !== undefined) {
  appendFileSync(realProcesses, real.pid + "\\n");
}
real?.stdout.pipe(process.stdout);
let unread = Buffer.alloc(0);
let requests = 0;
const answer = (id, result) => {
  const body = JSON.stringify({ jsonrpc: "2.0", id, result });
  writeSync(1, "Content-Length: " + Buffer.byteLength(body) + "\\r\\n\\r\\n" + body);
};
const stop = () => {
  if (mode === "close-output") {
    closeSync(1);
  }
  if (mode === "exit") {
    process.exit(23);
  }
  if (mode === "proxy") {
    real.once("exit", () => process.exit(23));
    real.kill("SIGKILL");
  }
};
const handle = (frame, message) => {
  if (real !== undefined) {
    if (message.method === trigger) {
      stop();
      return;
    }
    real.stdin.write(frame);
    return;
  }
  if (message.method === "initialize") {
    answer(message.id, { useCaseSensitiveFileNames: true, currentDirectory: "/" });
    return;
  }
  if (message.method === "updateSnapshot") {
    answer(message.id, { snapshot: 1, projects: [] });
    return;
  }
  requests += 1;
  if (requests === Number(trigger)) {
    stop();
  }
};
process.stdin.on("data", (chunk) => {
  unread = Buffer.concat([unread, chunk]);
  for (;;) {
    const headerEnd = unread.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) {
      return;
    }
    const length = Number(/Content-Length: (\\d+)/i.exec(unread.subarray(0, headerEnd).toString())[1]);
    const frameEnd = headerEnd + 4 + length;
    if (unread.length < frameEnd) {
      return;
    }
    const frame = unread.subarray(0, frameEnd);
    const message = JSON.parse(unread.subarray(headerEnd + 4, frameEnd).toString());
    unread = unread.subarray(frameEnd);
    handle(frame, message);
  }
});
`;

const pidsIn = (fileSystem: FileSystem.FileSystem, file: string) =>
  fileSystem
    .readFileString(file)
    .pipe(Effect.map((text) => text.split("\n").filter((line) => line !== "")));

const livingOf = (pids: readonly string[]) =>
  pids.length === 0
    ? Effect.succeed("")
    : Task.exec("sh", ["-c", `ps -o pid= -p ${pids.join(",")} || true`]).pipe(
        Effect.map((listed) => listed.trim()),
      );

const KILL_AND_AWAIT_EVERY_LISTED_PROCESS = `pids=$(cat "$@" | tr "\\n" " ")
if [ -z "$pids" ]; then exit 0; fi
kill -KILL $pids 2>/dev/null
attempt=0
while [ $attempt -lt ${REAP_ATTEMPTS} ] && ps -o pid= -p "$(echo $pids | tr " " ",")" >/dev/null 2>&1; do
  sleep 0.1
  attempt=$((attempt + 1))
done
exit 0
`;

const fakeTypeScriptApi = (mode: string, trigger: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped();
    const fake = path.join(directory, "fake-typescript-api.js");
    const launchedProcesses = path.join(directory, "launched-processes");
    const realProcesses = path.join(directory, "real-processes");
    const tsserverPath = path.join(directory, "tsgo");
    const exePathModule =
      mode === "proxy"
        ? path.resolve("node_modules/typescript/lib/getExePath.js")
        : NO_REAL_EXECUTABLE;
    yield* fileSystem.writeFileString(fake, FAKE_TYPESCRIPT_API);
    yield* fileSystem.writeFileString(launchedProcesses, "");
    yield* fileSystem.writeFileString(realProcesses, "");
    yield* fileSystem.writeFileString(
      tsserverPath,
      `#!/bin/sh\necho $$ >> ${yield* encodeJson(launchedProcesses)}\nexec bun ${yield* encodeJson(fake)} ${mode} ${trigger} ${yield* encodeJson(exePathModule)} ${yield* encodeJson(realProcesses)} "$@"\n`,
    );
    yield* fileSystem.chmod(tsserverPath, EXECUTABLE);
    const launched = pidsIn(fileSystem, launchedProcesses);
    const real = pidsIn(fileSystem, realProcesses);
    yield* Effect.addFinalizer(() =>
      Task.exec("sh", [
        "-c",
        KILL_AND_AWAIT_EVERY_LISTED_PROCESS,
        "kill-and-await",
        launchedProcesses,
        realProcesses,
      ]).pipe(
        Effect.asVoid,
        Effect.catchTags({
          CommandFailed: () => Effect.void,
          CommandNotStarted: () => Effect.void,
          CommandStandardInputFailed: () => Effect.void,
          PlatformError: () => Effect.void,
        }),
      ),
    );
    return {
      tsserverPath,
      launched,
      real,
      living: launched.pipe(Effect.flatMap(livingOf)),
      livingReal: real.pipe(Effect.flatMap(livingOf)),
    };
  });

const parsed = (api: API, file: string) =>
  failureAsValue(typeScriptRequest(`parse ${file}`, () => api.parseConfigFile(file))).pipe(
    Effect.map((failure) => failure.message),
  );

const failuresOfConcurrentAndLaterParses = (
  tsserverPath: string,
  concurrentFiles: readonly string[],
  requestDeadline: `${number} ${Duration.Unit}` = "10 minutes",
) =>
  Effect.gen(function* () {
    const api = yield* openedApi(new Map());
    const concurrent = yield* Effect.forEach(concurrentFiles, (file) => parsed(api, file), {
      concurrency: "unbounded",
    });
    const later = yield* parsed(api, "/project/later.json");
    return { concurrent, later };
  }).pipe(
    Effect.scoped,
    Effect.provideService(TypeScriptApiLaunch, { tsserverPath, requestDeadline }),
  );

const failedToParse = (file: string, reason: string) =>
  `the TypeScript API failed to parse ${file}: ${reason}`;

export const pendingRequestsFailWhenTheProcessExits = Task.make({
  name: "when the TypeScript API process exits while requests wait, every waiting and later request fails with its exit code, nothing starts it again and no process is left",
  timeout: WATCHDOG,
  run: Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* fakeTypeScriptApi("exit", "3");
      const files = ["/project/a.json", "/project/b.json", "/project/c.json"];
      const { concurrent, later } = yield* failuresOfConcurrentAndLaterParses(
        fake.tsserverPath,
        files,
      );
      const exited = "the TypeScript API process exited with code 23";
      expect(concurrent).toEqual(files.map((file) => failedToParse(file, exited)));
      expect(later).toBe(failedToParse("/project/later.json", exited));
      expect(yield* fake.launched).toHaveLength(1);
      expect(yield* fake.living).toBe("");
    }),
  ),
});

export const pendingRequestsFailWhenTheProcessClosesItsOutput = Task.make({
  name: "when the TypeScript API process closes its output but stays alive, every waiting and later request fails, nothing starts it again and the process is stopped",
  timeout: WATCHDOG,
  run: Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* fakeTypeScriptApi("close-output", "2");
      const files = ["/project/a.json", "/project/b.json"];
      const { concurrent, later } = yield* failuresOfConcurrentAndLaterParses(
        fake.tsserverPath,
        files,
      );
      const closed = "the TypeScript API process closed its output";
      expect(concurrent).toEqual(files.map((file) => failedToParse(file, closed)));
      expect(later).toBe(failedToParse("/project/later.json", closed));
      expect(yield* fake.launched).toHaveLength(1);
      expect(yield* fake.living).toBe("");
    }),
  ),
});

export const closingNeverWaitsOnSnapshotReleases = Task.make({
  name: "closing a TypeScript API that still holds a snapshot finishes even though its process exits on any further request, and leaves no process",
  timeout: WATCHDOG,
  run: Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* fakeTypeScriptApi("exit", "1");
      yield* Effect.gen(function* () {
        const api = yield* openedApi(new Map());
        yield* typeScriptRequest("load the project", () =>
          api.updateSnapshot({ openProjects: ["/project/tsconfig.json"] }),
        );
      }).pipe(
        Effect.scoped,
        Effect.provideService(TypeScriptApiLaunch, {
          tsserverPath: fake.tsserverPath,
          requestDeadline: "10 minutes",
        }),
      );
      expect(yield* fake.launched).toHaveLength(1);
      expect(yield* fake.living).toBe("");
    }),
  ),
});

export const unansweredRequestsFailAtTheDeadline = Task.make({
  name: "a TypeScript API request with no answer by the request deadline fails naming the deadline, later requests fail without a new process, and the silent process is stopped",
  timeout: WATCHDOG,
  run: Effect.scoped(
    Effect.gen(function* () {
      const fake = yield* fakeTypeScriptApi("silent", "1");
      const { concurrent, later } = yield* failuresOfConcurrentAndLaterParses(
        fake.tsserverPath,
        ["/project/a.json"],
        "200 millis",
      );
      const unanswered = "the TypeScript API process did not answer within 200 millis";
      expect(concurrent).toEqual([failedToParse("/project/a.json", unanswered)]);
      expect(later).toBe(failedToParse("/project/later.json", unanswered));
      expect(yield* fake.launched).toHaveLength(1);
      expect(yield* fake.living).toBe("");
    }),
  ),
});

const sourceModule = (file: string) => new URL(`../../src/${file}`, import.meta.url).href;

export const typedChecksFailWhenTheApiProcessDiesMidRun = Task.make({
  name: "the directives and checker-queries tasks of a run whose TypeScript API process dies after loading the project fail naming its exit code instead of waiting forever",
  timeout: WATCHDOG,
  run: Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fake = yield* fakeTypeScriptApi("proxy", "getSourceFile");
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const taskStateDirectory = yield* fileSystem.makeTempDirectoryScoped();
      yield* linkNodeModulesWithCheck(directory);
      const launch = yield* encodeJson({
        tsserverPath: fake.tsserverPath,
        requestDeadline: "10 minutes",
      });
      const files = {
        ".gitignore": "node_modules\nrun.ts\noxlint.config.ts\noxfmt.config.ts\n",
        "oxlint.config.ts": `import { lintConfig } from "@sshkeda/check";\nexport default lintConfig({});\n`,
        "oxfmt.config.ts": FORMAT_CONFIG_TEXT,
        "package.json": `${yield* encodeIndentedJson({ name: path.basename(directory), type: "module" })}\n`,
        "tsconfig.json": `${yield* encodeIndentedJson({ compilerOptions: { strict: true, noEmit: true, types: [] }, files: ["index.ts"] })}\n`,
        "index.ts": "export const ANSWER = 42;\n",
        "run.ts": [
          'import { Task } from "@sshkeda/task";',
          'import { Effect } from "effect";',
          `import { runChecksOverOneTypeScriptProject } from ${yield* encodeJson(sourceModule("lib/tasks/internal/run-checks-over-one-typescript-project.ts"))};`,
          `import { findRepeatedServiceYields } from ${yield* encodeJson(sourceModule("lib/tasks/lib/detect-repeated-service-yields/index.ts"))};`,
          `import { findDisableDirectivesInLintedFilesOf } from ${yield* encodeJson(sourceModule("lib/tasks/lib/refuse-disable-directives/internal/find-disable-directives.ts"))};`,
          `import { ProjectQueryCachesLive } from ${yield* encodeJson(sourceModule("lib/tasks/shared/provide-project-query-caches.ts"))};`,
          `import { TypeScriptApiLaunch } from ${yield* encodeJson(sourceModule("lib/tasks/shared/watch-the-typescript-api-process.ts"))};`,
          `const withTheFakeApi = (effect) => effect.pipe(Effect.provide(ProjectQueryCachesLive), Effect.provideService(TypeScriptApiLaunch, ${launch}));`,
          'const directives = Task.make({ name: "directives", run: withTheFakeApi(findDisableDirectivesInLintedFilesOf(".")) });',
          'const checkerQueries = Task.make({ name: "checker-queries", run: withTheFakeApi(runChecksOverOneTypeScriptProject("tsconfig.json", { "service-yields": findRepeatedServiceYields })) });',
          'export default Task.make({ name: "typed-checks", run: Task.allSettled([directives, checkerQueries]) });',
          "",
        ].join("\n"),
      };
      for (const [file, text] of Object.entries(files)) {
        yield* fileSystem.writeFileString(path.join(directory, file), text);
      }
      yield* Task.exec("git", ["init", "--quiet"], { cwd: directory });
      yield* Task.exec("git", ["add", "index.ts", "tsconfig.json", "package.json"], {
        cwd: directory,
      });
      const printed = yield* runTaskFile("bun run.ts", { cwd: directory, taskStateDirectory }).pipe(
        Effect.as(""),
        Effect.catchTag("CommandFailed", (failure) =>
          Effect.succeed(`${failure.standardOutput}${failure.standardError}`),
        ),
      );
      const exited =
        "the TypeScript API failed to read a source file: the TypeScript API process exited with code 23";
      expect(printed).toMatch(new RegExp(`^\\[directives\\] .*${exited}`, "mu"));
      expect(printed).toMatch(new RegExp(`^\\[checker-queries\\] .*${exited}`, "mu"));
      expect(yield* fake.living).toBe("");
      const launched = yield* fake.launched;
      expect(launched.length).toBeGreaterThan(0);
      expect(yield* fake.real).toHaveLength(launched.length);
      expect(yield* fake.livingReal).toBe("");
    }),
  ),
});
