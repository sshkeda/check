import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Schema } from "effect";

export const runTaskFile = (
  command: string,
  options: {
    readonly cwd: string;
    readonly taskStateDirectory: string;
    readonly env?: Readonly<Record<string, string>>;
  },
) =>
  Task.exec("sh", ["-c", `${command} 2>&1`], {
    cwd: options.cwd,
    env: {
      SSHKEDA_TASK_WORKERS: "1",
      ...options.env,
      SSHKEDA_TASK_STATE_DIRECTORY: options.taskStateDirectory,
    },
  });

const RUN_DIRECTORY_LINE = /^run: (?<directory>\S+\/)$/mu;

const TRACE_FILE_NAME = "trace.jsonl";

export const traceFileOf = (printed: string) =>
  `${RUN_DIRECTORY_LINE.exec(printed)?.groups?.["directory"] ?? ""}${TRACE_FILE_NAME}`;

const SPAN_ATTRIBUTE = Schema.Struct({
  key: Schema.String,
  value: Schema.Struct({ stringValue: Schema.optionalKey(Schema.String) }),
});

const TRACE_LINE = Schema.fromJsonString(
  Schema.Struct({
    resourceSpans: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          scopeSpans: Schema.Array(
            Schema.Struct({
              spans: Schema.Array(Schema.Struct({ attributes: Schema.Array(SPAN_ATTRIBUTE) })),
            }),
          ),
        }),
      ),
    ),
  }),
);

const decodeTraceLine = Schema.decodeEffect(TRACE_LINE);

const attributeOf = (
  attributes: readonly (typeof SPAN_ATTRIBUTE.Type)[],
  key: string,
): string | undefined => attributes.find((attribute) => attribute.key === key)?.value.stringValue;

export const taskStatesOf = (printed: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const trace = yield* fileSystem.readFileString(traceFileOf(printed));
    const lines = yield* Effect.forEach(
      trace.split("\n").filter((line) => line !== ""),
      (line) => decodeTraceLine(line),
    );
    return lines
      .flatMap(({ resourceSpans = [] }) => resourceSpans)
      .flatMap(({ scopeSpans }) => scopeSpans)
      .flatMap(({ spans }) => spans)
      .filter(({ attributes }) => attributeOf(attributes, "sshkeda_task.span.role") === "task")
      .map(({ attributes }) => ({
        task: attributeOf(attributes, "sshkeda_task.task"),
        state: attributeOf(attributes, "sshkeda_task.state"),
      }));
  });
