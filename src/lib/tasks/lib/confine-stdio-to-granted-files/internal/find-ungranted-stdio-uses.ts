import { Effect, Path } from "effect";
import type { Node, SourceFile } from "typescript/unstable/ast";
import {
  isBindingElement,
  isComputedPropertyName,
  isElementAccessExpression,
  isIdentifier,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isPropertyAccessExpression,
  isStringLiteral,
} from "typescript/unstable/ast/is";
import { isStringLiteralType, isTypeParameter, isUnionType } from "typescript/unstable/async";
import type { Checker, Type } from "typescript/unstable/async";

import { loadedLintConfigIn } from "../../../shared/load-the-lint-config.ts";
import {
  CONCURRENT_TYPESCRIPT_REQUESTS,
  nodePosition,
  parentOf,
  requiredTypeScriptRequest,
  typeScriptRequest,
} from "../../../shared/query-the-typescript-project.ts";
import type { openTypeScriptProjects } from "../../../shared/query-the-typescript-project.ts";
import {
  StdioArgumentsReadWithoutGrant,
  StdioTerminalWriteWithoutGrant,
  StdioUsesRefused,
} from "./stdio-use-errors.ts";

const STDIO_TYPE_ID = "~effect/Stdio";

const PERMISSION_OF_STDIO_MEMBER = new Map<string, "readsConfig" | "writesToTheTerminal">([
  ["args", "readsConfig"],
  ["stdout", "writesToTheTerminal"],
  ["stderr", "writesToTheTerminal"],
]);

const literalKeyText = (key: Node) => {
  const isNamedOrLiteralKey =
    isIdentifier(key) ||
    isStringLiteral(key) ||
    isNoSubstitutionTemplateLiteral(key) ||
    isNumericLiteral(key);
  return isNamedOrLiteralKey ? key.text : undefined;
};

const literalRead = (receiver: Node, text: string | undefined) => {
  const namesAGrantedMember = text !== undefined && PERMISSION_OF_STDIO_MEMBER.has(text);
  return namesAGrantedMember ? { receiver, member: text, key: undefined } : undefined;
};

const keyExpressionRead = (receiver: Node, key: Node) => {
  const text = isIdentifier(key) ? undefined : literalKeyText(key);
  if (text !== undefined) {
    return literalRead(receiver, text);
  }
  return { receiver, member: undefined, key };
};

const possibleStdioRead = (node: Node) => {
  if (isPropertyAccessExpression(node)) {
    return literalRead(node.expression, node.name.text);
  }
  if (isElementAccessExpression(node)) {
    return keyExpressionRead(node.expression, node.argumentExpression);
  }
  if (!isBindingElement(node)) {
    return;
  }
  const pattern = parentOf(node);
  const isInObjectPattern = pattern !== undefined && isObjectBindingPattern(pattern);
  if (!isInObjectPattern) {
    return;
  }
  const key = node.propertyName ?? node.name;
  if (key === undefined) {
    return;
  }
  if (isComputedPropertyName(key)) {
    return keyExpressionRead(pattern, key.expression);
  }
  return literalRead(pattern, literalKeyText(key));
};

const possibleStdioReadsIn = (sourceFile: SourceFile) => {
  const reads: NonNullable<ReturnType<typeof possibleStdioRead>>[] = [];
  const visit = (node: Node): void => {
    const read = possibleStdioRead(node);
    if (read !== undefined) {
      reads.push(read);
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return reads;
};

const unionMembersOf = (type: Type) =>
  isUnionType(type)
    ? typeScriptRequest("read the members of a union", () => type.getTypes())
    : Effect.succeed([type]);

const stdioMembersNamedBy = (checker: Checker, key: Node) =>
  Effect.gen(function* () {
    const type = yield* typeScriptRequest("read the type of a key", () =>
      checker.getTypeAtLocation(key),
    );
    if (type === undefined) {
      return [];
    }
    const constraint = isTypeParameter(type)
      ? yield* typeScriptRequest("read the constraint of a key", () =>
          checker.getBaseConstraintOfType(type),
        )
      : type;
    if (constraint === undefined) {
      return [];
    }
    return (yield* unionMembersOf(constraint)).flatMap((member) => {
      const namesAGrantedMember =
        isStringLiteralType(member) && PERMISSION_OF_STDIO_MEMBER.has(member.value);
      return namesAGrantedMember ? [member.value] : [];
    });
  });

const hasStdioTypeId = (checker: Checker, type: Type) =>
  Effect.gen(function* () {
    const apparent = yield* requiredTypeScriptRequest("read an apparent type", () =>
      checker.getApparentType(type),
    );
    const typeId = yield* typeScriptRequest("read the Stdio type id", () =>
      checker.getPropertyOfType(apparent, STDIO_TYPE_ID),
    );
    return typeId !== undefined;
  });

const isStdio = (checker: Checker, receiver: Node) =>
  Effect.gen(function* () {
    const type = yield* requiredTypeScriptRequest("read the type a Stdio member is read on", () =>
      checker.getTypeAtLocation(receiver),
    );
    const present = yield* requiredTypeScriptRequest("read a non-nullable type", () =>
      checker.getNonNullableType(type),
    );
    const members = yield* unionMembersOf(present);
    const stdioMembers = yield* Effect.filter(members, (member) => hasStdioTypeId(checker, member));
    return stdioMembers.length > 0;
  });

const stdioMembersRead = (
  checker: Checker,
  read: NonNullable<ReturnType<typeof possibleStdioRead>>,
) =>
  Effect.gen(function* () {
    const members =
      read.member === undefined ? yield* stdioMembersNamedBy(checker, read.key) : [read.member];
    if (members.length === 0) {
      return [];
    }
    return (yield* isStdio(checker, read.receiver)) ? members : [];
  });

const violationOf = (member: string, location: string) => {
  const writesToTheTerminal = member === "stdout" || member === "stderr";
  return writesToTheTerminal
    ? new StdioTerminalWriteWithoutGrant({ location, member })
    : new StdioArgumentsReadWithoutGrant({ location });
};

export const findUngrantedStdioUses = <OpeningError, OpeningRequirement>(
  projectFile: string,
  openedProjects: Effect.Effect<
    Effect.Success<ReturnType<typeof openTypeScriptProjects>>,
    OpeningError,
    OpeningRequirement
  >,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const grants = yield* loadedLintConfigIn(path.dirname(projectFile));
    const isGranted = (displayName: string, member: string) => {
      const permission = PERMISSION_OF_STDIO_MEMBER.get(member);
      return grants.some(
        (grant) =>
          grant.path === displayName &&
          permission !== undefined &&
          grant.allow.some((allowed) => allowed === permission),
      );
    };
    const violations: StdioUsesRefused["violations"][number][] = [];
    for (const { checker, sourceFiles } of yield* openedProjects) {
      const reads = sourceFiles.flatMap(({ sourceFile, displayName }) =>
        possibleStdioReadsIn(sourceFile).map((read) => {
          const location = nodePosition(sourceFile, read.receiver);
          return {
            read,
            displayName,
            location: `${displayName}:${location.line}:${location.column}`,
          };
        }),
      );
      const found = yield* Effect.forEach(
        reads,
        ({ read, displayName, location }) =>
          Effect.map(stdioMembersRead(checker, read), (members) =>
            members
              .filter((member) => !isGranted(displayName, member))
              .map((member) => violationOf(member, location)),
          ),
        { concurrency: CONCURRENT_TYPESCRIPT_REQUESTS },
      );
      violations.push(...found.flat());
    }
    if (violations.length > 0) {
      return yield* new StdioUsesRefused({ violations });
    }
  });
