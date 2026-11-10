import type { Expression, ParseResult } from "oxc-parser";

import {
  TASK_MAKE_MEMBER,
  TASK_NAMESPACE_EXPORT,
  TASK_PACKAGE,
} from "../../../../../shared/bans-each-permission-lifts.ts";

const TASK_GROUP_MEMBERS = ["all", "allSettled"] as const;

const MEMBERS_THAT_MAKE_TASKS: ReadonlySet<string> = new Set([
  TASK_MAKE_MEMBER,
  ...TASK_GROUP_MEMBERS,
]);

const withoutWrappers = (expression: Expression): Expression => {
  const isTransparentWrapper =
    expression.type === "ParenthesizedExpression" ||
    expression.type === "TSAsExpression" ||
    expression.type === "TSSatisfiesExpression" ||
    expression.type === "TSTypeAssertion" ||
    expression.type === "TSNonNullExpression";
  return isTransparentWrapper ? withoutWrappers(expression.expression) : expression;
};

const importedMemberPath = (
  expression: Expression,
  imports: ReadonlyMap<string, readonly string[]>,
): readonly string[] | undefined => {
  const unwrapped = withoutWrappers(expression);
  if (unwrapped.type === "Identifier") {
    return imports.get(unwrapped.name);
  }
  const isStaticMember =
    unwrapped.type === "MemberExpression" &&
    !unwrapped.computed &&
    unwrapped.property.type === "Identifier";
  if (!isStaticMember) {
    return;
  }
  const object = importedMemberPath(unwrapped.object, imports);
  return object === undefined ? undefined : [...object, unwrapped.property.name];
};

export const makesATaskInItsDefaultExport = (parsed: ParseResult) => {
  const exported = parsed.program.body.find(
    (statement) => statement.type === "ExportDefaultDeclaration",
  );
  const declaration =
    exported?.type === "ExportDefaultDeclaration" ? exported.declaration : undefined;
  const isNotAnExpression =
    declaration === undefined ||
    declaration.type === "FunctionDeclaration" ||
    declaration.type === "ClassDeclaration" ||
    declaration.type === "TSInterfaceDeclaration";
  const value = isNotAnExpression ? undefined : withoutWrappers(declaration);
  if (value?.type !== "CallExpression") {
    return false;
  }
  const literalTaskImports = new Map(
    parsed.module.staticImports
      .filter((statement) => statement.moduleRequest.value === TASK_PACKAGE)
      .flatMap((statement) => statement.entries)
      .filter((entry) => !entry.isType)
      .map(
        (entry) =>
          [
            entry.localName.value,
            entry.importName.kind === "NamespaceObject" ? [] : [entry.importName.name ?? ""],
          ] as const,
      ),
  );
  const member = importedMemberPath(value.callee, literalTaskImports) ?? [];
  const isTaskMember = member.slice(0, -1).join(".") === TASK_NAMESPACE_EXPORT;
  return isTaskMember && MEMBERS_THAT_MAKE_TASKS.has(member.at(-1) ?? "");
};
