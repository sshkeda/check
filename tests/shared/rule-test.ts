import { Task } from "@sshkeda/task";
import { Effect, FileSystem, Path, Schema } from "effect";

import plugin from "../../src/index.ts";
import { PLUGIN } from "./checked-project.ts";
import { oxlintBinary } from "./oxlint-binary.ts";
import { RuleTestMessageIdUnknown, RuleTestTemplateDataMissing } from "./rule-test-errors.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const PLUGIN_NAME = "sshkeda";
const DEFAULT_FILE_NAME = "file.ts";
const LINT_CONFIG = "rule-test.json";
const OXLINT_FOUND_VIOLATIONS = 1;

const OXLINT_REPORT = Schema.fromJsonString(
  Schema.Struct({
    diagnostics: Schema.Array(
      Schema.Struct({
        filename: Schema.String,
        message: Schema.String,
        code: Schema.optionalKey(Schema.String),
        labels: Schema.Array(
          Schema.Struct({
            span: Schema.Struct({ line: Schema.NullOr(Schema.Int) }),
          }),
        ),
      }),
    ),
  }),
);

const PLACEHOLDER = /\{\{\s*(?<name>\w+)\s*\}\}/u;
const PARTS_PER_PLACEHOLDER = 2;

const byFile = (left: { readonly file: string }, right: { readonly file: string }) =>
  left.file.localeCompare(right.file);

const expectedError = (
  rule: string,
  ruleId: string,
  expected:
    | { readonly message: string }
    | { readonly messageId: string; readonly data?: Readonly<Record<string, string>> },
) =>
  Effect.gen(function* () {
    if ("message" in expected) {
      return { ruleId, message: expected.message, isLocated: true };
    }
    const template = plugin.rules[rule]?.meta?.messages?.[expected.messageId];
    if (template === undefined) {
      return yield* new RuleTestMessageIdUnknown({ rule, messageId: expected.messageId });
    }
    const { data } = expected;
    if (data === undefined) {
      return { ruleId, messageId: expected.messageId, isLocated: true };
    }
    const parts = template.split(PLACEHOLDER);
    const filled = yield* Effect.forEach(parts, (part, index) => {
      if (index % PARTS_PER_PLACEHOLDER === 0) {
        return Effect.succeed(part);
      }
      const value = data[part];
      return value === undefined
        ? Effect.fail(
            new RuleTestTemplateDataMissing({
              rule,
              messageId: expected.messageId,
              placeholder: part,
            }),
          )
        : Effect.succeed(value);
    });
    return { ruleId, messageId: expected.messageId, message: filled.join(""), isLocated: true };
  });

const expectingNoErrors = (
  ruleCase:
    | string
    | {
        readonly code: string;
        readonly filename?: string;
        readonly workingDirectory?: string;
        readonly options?: readonly Schema.Json[];
      },
) => (typeof ruleCase === "string" ? { code: ruleCase, errors: [] } : { ...ruleCase, errors: [] });

export const bannedUsage = (code: string) => ({ code, errors: [{ messageId: "banned" }] });

const ruleObservations = (
  rule: string,
  tests: {
    readonly valid: readonly Parameters<typeof expectingNoErrors>[0][];
    readonly invalid: readonly (Exclude<Parameters<typeof expectingNoErrors>[0], string> & {
      readonly errors: readonly (Parameters<typeof expectedError> extends [
        string,
        string,
        infer Expected,
      ]
        ? Expected
        : never)[];
    })[];
  },
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
    const ruleId = `${PLUGIN_NAME}/${rule}`;
    const cases = [...tests.valid.map((ruleCase) => expectingNoErrors(ruleCase)), ...tests.invalid];
    const casesWithFiles = cases.map((ruleCase, index) => {
      const filename = ruleCase.filename ?? DEFAULT_FILE_NAME;
      return {
        ruleCase,
        file: path.isAbsolute(filename) ? filename : path.join(`case-${index}`, filename),
      };
    });
    const rulesOf = (options: readonly Schema.Json[] | undefined) => ({
      [ruleId]: options === undefined ? "error" : ["error", ...options],
    });
    const lintedResults = (
      linted: readonly (typeof casesWithFiles)[number][],
      configFields: Readonly<Record<string, Schema.Json>>,
      workingDirectory: string,
    ) =>
      Effect.gen(function* () {
        for (const {
          file,
          ruleCase: { code },
        } of linted) {
          yield* fileSystem.makeDirectory(path.dirname(path.resolve(directory, file)), {
            recursive: true,
          });
          yield* fileSystem.writeFileString(path.resolve(directory, file), code);
        }
        yield* fileSystem.writeFileString(
          path.join(directory, LINT_CONFIG),
          yield* encodeJson({
            categories: { correctness: "off" },
            jsPlugins: [{ name: PLUGIN_NAME, specifier: PLUGIN }],
            ...configFields,
          }),
        );
        const printed = yield* Task.exec(
          "bun",
          [
            yield* oxlintBinary,
            "--config",
            path.join(directory, LINT_CONFIG),
            "--format",
            "json",
            "--",
            ...linted.map(({ file }) => path.resolve(directory, file)),
          ],
          { cwd: workingDirectory },
        ).pipe(
          Effect.catchTag("CommandFailed", (failure) =>
            failure.code === OXLINT_FOUND_VIOLATIONS
              ? Effect.succeed(failure.standardOutput)
              : Effect.fail(failure),
          ),
        );
        const { diagnostics } = yield* Schema.decodeEffect(OXLINT_REPORT)(printed);
        const messages = plugin.rules[rule]?.meta?.messages ?? {};
        const messageIdOf = (message: string) =>
          Object.entries(messages).find(([, template]) => {
            const pattern = template
              .split(PLACEHOLDER)
              .map((part, index) =>
                index % PARTS_PER_PLACEHOLDER === 0 ? RegExp.escape(part) : String.raw`[\s\S]*`,
              )
              .join("");
            return new RegExp(`^${pattern}$`, "u").test(message);
          })?.[0];
        return linted.map(({ file }) => {
          const filePath = path.resolve(directory, file);
          return {
            file,
            messages: diagnostics
              .filter(
                (diagnostic) =>
                  path.resolve(workingDirectory, diagnostic.filename) ===
                  filePath.replaceAll("\\", "/"),
              )
              .map((diagnostic) => ({
                ruleId:
                  diagnostic.code?.replace(
                    /^(?<plugin>[^()]+)\((?<name>.*)\)$/u,
                    "$<plugin>/$<name>",
                  ) ?? null,
                message: diagnostic.message,
                messageId: messageIdOf(diagnostic.message),
                line: diagnostic.labels.find(({ span }) => span.line !== null)?.span.line ?? 0,
              })),
          };
        });
      });
    const isLintedAlone = ({ file, ruleCase }: (typeof casesWithFiles)[number]) =>
      path.isAbsolute(file) || ruleCase.workingDirectory !== undefined;
    const lintedAlone = casesWithFiles.filter((ruleCase) => isLintedAlone(ruleCase));
    const inDirectory = casesWithFiles.filter((ruleCase) => !isLintedAlone(ruleCase));
    const results = [
      ...(inDirectory.length === 0
        ? []
        : yield* lintedResults(
            inDirectory,
            {
              overrides: inDirectory.map(({ file, ruleCase: { options } }) => ({
                files: [file],
                rules: rulesOf(options),
              })),
            },
            directory,
          )),
      ...(yield* Effect.forEach(lintedAlone, (ruleCase) =>
        lintedResults(
          [ruleCase],
          { rules: rulesOf(ruleCase.ruleCase.options) },
          ruleCase.ruleCase.workingDirectory ?? directory,
        ),
      )).flat(),
    ];
    const reported = results
      .map(({ file, messages }) => ({
        file,
        errors: messages.map(({ ruleId: reportedRuleId, message, messageId, line }) => ({
          ruleId: reportedRuleId,
          message,
          ...(messageId === undefined ? {} : { messageId }),
          isLocated: line > 0,
        })),
      }))
      .toSorted(byFile);
    const expected = yield* Effect.forEach(casesWithFiles, ({ file, ruleCase: { errors } }) =>
      Effect.forEach(errors, (error) => expectedError(rule, ruleId, error)).pipe(
        Effect.map((expectedErrors) => ({ file, errors: expectedErrors })),
      ),
    );
    return { reported, expected: expected.toSorted(byFile) };
  }).pipe(Effect.scoped);

export const ruleTestWith =
  (
    assertObservations: (observations: Effect.Success<ReturnType<typeof ruleObservations>>) => void,
  ) =>
  (...parameters: Parameters<typeof ruleObservations>) =>
    ruleObservations(...parameters).pipe(
      Effect.tap((observations) =>
        Effect.sync(() => {
          assertObservations(observations);
        }),
      ),
      Effect.asVoid,
    );

export const wordInName = (name: string, word: string) => ({
  messageId: "name",
  data: { name, word },
});
