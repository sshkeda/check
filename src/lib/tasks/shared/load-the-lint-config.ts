import { Effect, FileSystem, Path, Result } from "effect";
import type { ArrayExpressionElement, Expression } from "oxc-parser";

import { MalformedGrant } from "../../../shared/permission-grant-errors.ts";
import {
  GENERATED,
  recordedGrantsOf,
} from "../../../shared/record-and-grant-permissions-by-path.ts";
import { LINT_CONFIG, parsedConfigFileIn } from "./parse-config-files-that-import-from-check.ts";
import {
  LintConfigArgumentNotLiteral,
  LintConfigKeyRepeated,
  LintConfigRefused,
} from "./project-config-and-tool-errors.ts";

const literalStringOf = (node: ArrayExpressionElement) => {
  if (node?.type !== "Literal") {
    return;
  }
  const { value } = node;
  return typeof value === "string" ? value : undefined;
};

const literalKeysOf = (node: Expression) =>
  node.type === "ObjectExpression"
    ? node.properties.flatMap((property) => {
        if (property.type !== "Property") {
          return [];
        }
        const isPlainKeyValueProperty =
          property.kind === "init" && !property.computed && !property.method && !property.shorthand;
        if (!isPlainKeyValueProperty) {
          return [];
        }
        if (property.key.type === "Identifier") {
          return [{ name: property.key.name, value: property.value, start: property.start }];
        }
        const literalKeyValue = property.key.type === "Literal" ? property.key.value : undefined;
        return typeof literalKeyValue === "string"
          ? [{ name: literalKeyValue, value: property.value, start: property.start }]
          : [];
      })
    : [];

const isLiteralObject = (node: Expression, isLiteralValue: (value: Expression) => boolean) =>
  node.type === "ObjectExpression" &&
  literalKeysOf(node).length === node.properties.length &&
  literalKeysOf(node).every((key) => isLiteralValue(key.value));

const isLiteralStringObject = (node: Expression) =>
  isLiteralObject(node, (value) => literalStringOf(value) !== undefined);

const isLiteralGrantList = (node: Expression) =>
  node.type === "ArrayExpression" &&
  node.elements.every((element) => {
    const isStringObject = element?.type === "ObjectExpression" && isLiteralStringObject(element);
    return isStringObject || literalStringOf(element) !== undefined;
  });

const isLiteralLintConfigArgument = (node: Expression) =>
  isLiteralObject(node, (entry) => isLiteralObject(entry, isLiteralGrantList));

const literalGrantItemOf = (element: ArrayExpressionElement) => {
  if (element?.type === "ObjectExpression") {
    return [
      Object.fromEntries(
        literalKeysOf(element).flatMap(({ name, value }) => {
          const literal = literalStringOf(value);
          return literal === undefined ? [] : [[name, literal]];
        }),
      ),
    ];
  }
  const literal = literalStringOf(element);
  return literal === undefined ? [] : [literal];
};

const literalPermissionsOf = (node: Expression) =>
  Object.fromEntries(
    literalKeysOf(node).map((entry) => [
      entry.name,
      Object.fromEntries(
        literalKeysOf(entry.value).map((list) => [
          list.name,
          list.value.type === "ArrayExpression"
            ? list.value.elements.flatMap((element) => [...literalGrantItemOf(element)])
            : [],
        ]),
      ),
    ]),
  );

const objectsIn = (node: ArrayExpressionElement): readonly Expression[] => {
  if (node?.type === "ArrayExpression") {
    return node.elements.flatMap((element) => objectsIn(element));
  }
  if (node?.type !== "ObjectExpression") {
    return [];
  }
  return [node, ...literalKeysOf(node).flatMap(({ value }) => objectsIn(value))];
};

const repeatedKeysIn = (argument: Expression) =>
  objectsIn(argument).flatMap((object) => {
    const keys = literalKeysOf(object);
    const names = keys.map(({ name }) => name);
    return keys
      .filter(({ name }, index) => names.indexOf(name, names.indexOf(name) + 1) === index)
      .map(({ name, start }) => ({ key: name, start }));
  });

export const lintConfigOf = (parsed: Effect.Success<ReturnType<typeof parsedConfigFileIn>>) => {
  if (Result.isFailure(parsed)) {
    return { violations: parsed.failure };
  }
  const { call, violations, lineOf } = parsed.success;
  if (call === undefined) {
    return { violations };
  }
  const [argument] = call.arguments;
  const isLiteralArgument =
    argument !== undefined &&
    argument.type !== "SpreadElement" &&
    isLiteralLintConfigArgument(argument);
  if (!isLiteralArgument) {
    return {
      violations: [
        ...violations,
        new LintConfigArgumentNotLiteral({ location: lineOf(call.start) }),
      ],
    };
  }
  const repeatedKeys = repeatedKeysIn(argument).map(
    ({ key, start }) => new LintConfigKeyRepeated({ location: lineOf(start), key }),
  );
  if (violations.length + repeatedKeys.length > 0) {
    return { violations: [...violations, ...repeatedKeys] };
  }
  return { permissionsByPath: literalPermissionsOf(argument) };
};

export const loadedLintConfigIn = (directory: string) =>
  Effect.gen(function* () {
    const parsed = lintConfigOf(yield* parsedConfigFileIn(directory, LINT_CONFIG));
    if ("violations" in parsed) {
      return yield* new LintConfigRefused({ violations: parsed.violations });
    }
    const recorded = recordedGrantsOf(parsed.permissionsByPath);
    if (recorded.grants === undefined) {
      return yield* new LintConfigRefused({ violations: recorded.violations });
    }
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fileGrants = recorded.grants.flatMap((grant) =>
      grant.allow
        .filter((permission) => permission === GENERATED)
        .map((permission) => ({ file: grant.path, permission })),
    );
    const violations = yield* Effect.forEach(fileGrants, ({ file, permission }) =>
      Effect.gen(function* () {
        const absolute = path.join(directory, file);
        const exists = yield* fileSystem.exists(absolute);
        const isFile = exists && (yield* fileSystem.stat(absolute)).type === "File";
        return isFile
          ? []
          : [
              new MalformedGrant({
                issuePath: file,
                issueMessage: `grants ${permission}, but is not an existing file`,
              }),
            ];
      }),
    );
    if (violations.flat().length > 0) {
      return yield* new LintConfigRefused({ violations: violations.flat() });
    }
    return recorded.grants;
  });
