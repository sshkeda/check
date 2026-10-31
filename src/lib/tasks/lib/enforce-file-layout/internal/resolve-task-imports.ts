import { Effect, FileSystem } from "effect";
import { parseSync, Visitor } from "oxc-parser";
import type { ExportSpecifier, Expression, ParseResult } from "oxc-parser";

import {
  TASK_MAIN_MEMBER,
  TASK_MAKE_MEMBER,
  TASK_PACKAGE,
} from "../../../../../shared/bans-each-permission-lifts.ts";
import {
  directoryOf,
  isRootSupportFile,
  isScript,
  isTopLevelScript,
} from "../../../shared/classify-files-by-role.ts";
import { resolveModuleRequest } from "../../../shared/resolve-module-requests.ts";

const exportNameOf = (name: ExportSpecifier["local"]) =>
  name.type === "Identifier" ? name.name : name.value;

const candidateImportRoots = (parsed: ParseResult) => {
  const names = new Set<string>();
  const remember = (expression: Expression) => {
    if (expression.type === "Identifier") {
      names.add(expression.name);
      return;
    }
    const isTaskMember =
      expression.type === "MemberExpression" &&
      !expression.computed &&
      expression.property.type === "Identifier" &&
      [TASK_MAKE_MEMBER, TASK_MAIN_MEMBER].includes(expression.property.name);
    if (!isTaskMember) {
      return;
    }
    const { object } = expression;
    const root = object.type === "MemberExpression" ? object.object : object;
    if (root.type === "Identifier") {
      names.add(root.name);
    }
  };
  new Visitor({
    CallExpression(node) {
      remember(node.callee);
    },
    VariableDeclarator({ init: initializer }) {
      if (initializer !== null) {
        remember(initializer);
      }
    },
  }).visit(parsed.program);
  return names;
};

export const taskImportsIn = (file: string, text: string, directory: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const projectRoot = yield* fileSystem.realPath(directory);
    const taskExportFrom = (
      importingFile: string,
      request: string,
      members: readonly string[],
      seen: ReadonlySet<string> = new Set(),
    ): Effect.Effect<
      readonly string[] | undefined,
      | Effect.Error<ReturnType<typeof fileSystem.readFileString>>
      | Effect.Error<ReturnType<typeof resolveModuleRequest>>,
      Effect.Services<ReturnType<typeof resolveModuleRequest>>
    > =>
      Effect.gen(function* () {
        if (request === TASK_PACKAGE) {
          return members;
        }
        const target = yield* resolveModuleRequest({
          importingFile,
          request,
          customConditions: [],
          projectDirectory: directory,
        });
        if (target === undefined) {
          return;
        }
        const isTaskDependency =
          target.packageName === TASK_PACKAGE && target.packageRoot !== projectRoot;
        if (isTaskDependency) {
          return members;
        }
        const key = `${target.file}\0${members.join(".")}`;
        if (seen.has(key)) {
          return;
        }
        const followed = new Set([...seen, key]);
        const parsed = parseSync(target.file, yield* fileSystem.readFileString(target.file));
        const [name, ...rest] = members;
        if (name === undefined) {
          return;
        }
        for (const statement of parsed.program.body) {
          if (statement.type === "ExportNamedDeclaration") {
            if (statement.exportKind === "type") {
              continue;
            }
            const specifier = statement.specifiers.find(
              (entry) => exportNameOf(entry.exported) === name && entry.exportKind !== "type",
            );
            if (specifier !== undefined) {
              const localName = exportNameOf(specifier.local);
              if (statement.source !== null) {
                return yield* taskExportFrom(
                  target.file,
                  statement.source.value,
                  [localName, ...rest],
                  followed,
                );
              }
              for (const declaration of parsed.module.staticImports) {
                const binding = declaration.entries.find(
                  (entry) => !entry.isType && entry.localName.value === localName,
                );
                if (binding !== undefined) {
                  const importedMembers =
                    binding.importName.kind === "NamespaceObject"
                      ? rest
                      : [binding.importName.name ?? "", ...rest];
                  return yield* taskExportFrom(
                    target.file,
                    declaration.moduleRequest.value,
                    importedMembers,
                    followed,
                  );
                }
              }
            }
          }
          const isValueStarExport =
            statement.type === "ExportAllDeclaration" && statement.exportKind !== "type";
          if (isValueStarExport) {
            const exported =
              statement.exported === null ? undefined : exportNameOf(statement.exported);
            const forwardsName = exported === undefined || exported === name;
            if (forwardsName) {
              const found = yield* taskExportFrom(
                target.file,
                statement.source.value,
                exported === undefined ? members : rest,
                followed,
              );
              if (found !== undefined) {
                return found;
              }
            }
          }
        }
        return yield* Effect.undefined;
      });
    const imports = new Map<string, readonly string[]>();
    const parsed = parseSync(file, text);
    const candidates = candidateImportRoots(parsed);
    for (const declaration of parsed.module.staticImports) {
      for (const entry of declaration.entries) {
        const isCandidate = !entry.isType && candidates.has(entry.localName.value);
        if (!isCandidate) {
          continue;
        }
        const members =
          entry.importName.kind === "NamespaceObject" ? [] : [entry.importName.name ?? ""];
        const reference = yield* taskExportFrom(file, declaration.moduleRequest.value, members);
        if (reference !== undefined) {
          imports.set(entry.localName.value, reference);
        }
      }
    }
    return imports;
  });

export const isTaskLayoutFile = (file: string) =>
  isScript(file) &&
  (isTopLevelScript(file) || (directoryOf(file) === "" && !isRootSupportFile(file)));
