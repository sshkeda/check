import { Effect, Option, Path } from "effect";
import { Visitor } from "oxc-parser";
import type {
  ParseResult,
  Directive,
  ArrowFunctionExpression,
  Function as FunctionNode,
  JSXElementName,
  JSXIdentifier,
  JSXNamespacedName,
  Statement,
} from "oxc-parser";

import {
  fileNameOf,
  isEntryFileName,
  isWithin,
} from "../../../../../shared/match-file-names-and-path-prefixes.ts";
import {
  SCRIPTS_DIRECTORY,
  SOURCE_DIRECTORY,
} from "../../../../../shared/test-home-directories.ts";
import {
  directoryOf,
  isTopLevelScript,
  isDeclarationFile,
  isTestEntryFile,
  isUnderTestDirectory,
} from "../../../shared/classify-files-by-role.ts";
import { lineNumbersIn } from "../../../shared/count-the-line-of-an-offset.ts";
import { ownedFilesAmong } from "../../../shared/list-owned-files.ts";
import { projectSymbolsIn } from "../../../shared/query-the-typescript-project.ts";
import type { openTypeScriptProjects } from "../../../shared/query-the-typescript-project.ts";
import { absolutePathOf } from "../../../shared/resolve-absolute-paths.ts";
import {
  ExportPlacementViolations,
  PackageEntryWithoutSource,
  ScriptOnlyExport,
  TestNotRun,
  TestOnlyExport,
  UnusedExport,
} from "./export-placement-errors.ts";
import { findMisplacedFiles } from "./find-misplaced-files.ts";
import { DEFAULT_EXPORT, EVERY_EXPORT, findTheImporterGraph } from "./find-the-importer-graph.ts";
import { bindingNamesOf, parameterNamesOf } from "./list-binding-names.ts";

const UNRESOLVABLE_IMPORTS_ARE_REPORTED_BY_THE_IMPORT_BOUNDARY_CHECK = Effect.succeedNone;

const rootOfJsxName = (name: JSXElementName): JSXIdentifier | JSXNamespacedName =>
  name.type === "JSXMemberExpression" ? rootOfJsxName(name.object) : name;

const declaredNamesOf = (statement: Directive | Statement): readonly string[] => {
  const declaration =
    statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
  if (declaration === null) {
    return [];
  }
  if (declaration.type === "VariableDeclaration") {
    return declaration.declarations.flatMap((declarator) => bindingNamesOf(declarator.id));
  }
  const declaresNamedBinding =
    declaration.type === "FunctionDeclaration" ||
    declaration.type === "ClassDeclaration" ||
    declaration.type === "TSDeclareFunction";
  if (declaresNamedBinding) {
    return declaration.id === null ? [] : [declaration.id.name];
  }
  if (declaration.type !== "ExportDefaultDeclaration") {
    return [];
  }
  const defaultExported = declaration.declaration;
  const isDefaultFunctionOrClass =
    defaultExported.type === "FunctionDeclaration" || defaultExported.type === "ClassDeclaration";
  if (!isDefaultFunctionOrClass) {
    return [];
  }
  return defaultExported.id === null ? [] : [defaultExported.id.name];
};

const parsedFile = (
  parsed: ParseResult,
  text: string,
  symbolIdsAt: ReturnType<ReturnType<typeof projectSymbolsIn>>,
) =>
  Effect.gen(function* () {
    const body = parsed.program.body;
    const statementAt = (offset: number, low = 0, high = body.length): number => {
      if (low >= high) {
        return -1;
      }
      const middle = (low + high) >>> 1;
      if (offset < (body[middle]?.start ?? offset)) {
        return statementAt(offset, low, middle);
      }
      return offset < (body[middle]?.end ?? offset)
        ? middle
        : statementAt(offset, middle + 1, high);
    };
    const statementOfLocal = new Map(
      [...body.entries()].flatMap(([index, statement]) =>
        declaredNamesOf(statement).map((name) => [name, index] as const),
      ),
    );
    const exportedStatement = (
      entry: (typeof parsed.module.staticExports)[number]["entries"][number],
    ) =>
      entry.localName.name === null
        ? statementAt(entry.start)
        : statementOfLocal.get(entry.localName.name);
    const lineAt = lineNumbersIn(text);
    const exports = new Map<
      string,
      { statement: ReturnType<typeof exportedStatement>; line: number }
    >();
    const localNameOfExport = new Map<string, string>();
    const exportsOfStatement = new Map<number, string[]>();
    for (const declaration of parsed.module.staticExports) {
      for (const entry of declaration.entries) {
        const exportedName =
          entry.exportName.kind === "Default" ? DEFAULT_EXPORT : entry.exportName.name;
        const localName = entry.localName.name;
        if (exportedName === null) {
          continue;
        }
        const statement = exportedStatement(entry);
        exports.set(exportedName, { statement, line: lineAt(entry.start) });
        if (localName !== null) {
          localNameOfExport.set(exportedName, localName);
        }
        if (statement !== undefined) {
          exportsOfStatement.set(statement, [
            ...(exportsOfStatement.get(statement) ?? []),
            exportedName,
          ]);
        }
      }
    }
    const identifiers: { name: string; start: number }[] = [];
    const shorthandStarts = new Set<number>();
    const notReferences = new Set<number>();
    const skippedRanges: { start: number; end: number }[] = [];
    const scopes: {
      readonly start: number;
      readonly end: number;
      readonly names: Set<string>;
    }[] = [];
    const declarations: {
      readonly start: number;
      readonly names: readonly string[];
    }[] = [];
    const addScope = (
      node: { readonly start: number; readonly end: number },
      names: readonly string[],
    ) => scopes.push({ start: node.start, end: node.end, names: new Set(names) });
    const functionScope = (node: ArrowFunctionExpression | FunctionNode) =>
      addScope(node, node.params.flatMap(parameterNamesOf));
    new Visitor({
      Identifier(node) {
        identifiers.push({ name: node.name, start: node.start });
      },
      MemberExpression(node) {
        if (!node.computed) {
          notReferences.add(node.property.start);
        }
      },
      JSXOpeningElement(node) {
        const rootName = rootOfJsxName(node.name);
        if (rootName.type === "JSXIdentifier") {
          identifiers.push({ name: rootName.name, start: rootName.start });
        }
      },
      Property(node) {
        if (!node.computed) {
          if (node.shorthand) {
            shorthandStarts.add(node.value.start);
          } else {
            notReferences.add(node.key.start);
          }
        }
      },
      MethodDefinition(node) {
        if (!node.computed) {
          notReferences.add(node.key.start);
        }
      },
      PropertyDefinition(node) {
        if (!node.computed) {
          notReferences.add(node.key.start);
        }
      },
      TSPropertySignature(node) {
        if (!node.computed) {
          notReferences.add(node.key.start);
        }
      },
      TSMethodSignature(node) {
        if (!node.computed) {
          notReferences.add(node.key.start);
        }
      },
      TSQualifiedName(node) {
        notReferences.add(node.right.start);
      },
      ImportDeclaration(node) {
        skippedRanges.push(node);
      },
      ExportNamedDeclaration(node) {
        if (node.declaration === null) {
          skippedRanges.push(node);
        }
      },
      FunctionDeclaration(node) {
        functionScope(node);
        declarations.push({
          start: node.start,
          names: node.id === null ? [] : [node.id.name],
        });
      },
      FunctionExpression(node) {
        functionScope(node);
        if (node.id !== null) {
          addScope(node, [node.id.name]);
        }
      },
      ArrowFunctionExpression(node) {
        functionScope(node);
      },
      ClassDeclaration(node) {
        declarations.push({
          start: node.start,
          names: node.id === null ? [] : [node.id.name],
        });
      },
      ClassExpression(node) {
        if (node.id !== null) {
          addScope(node, [node.id.name]);
        }
      },
      CatchClause(node) {
        addScope(node, bindingNamesOf(node.param));
      },
      BlockStatement(node) {
        addScope(node, []);
      },
      StaticBlock(node) {
        addScope(node, []);
      },
      SwitchStatement(node) {
        addScope(node, []);
      },
      ForStatement(node) {
        addScope(node, []);
      },
      ForInStatement(node) {
        addScope(node, []);
      },
      ForOfStatement(node) {
        addScope(node, []);
      },
      VariableDeclaration(node) {
        declarations.push({
          start: node.start,
          names: node.declarations.flatMap((declarator) => bindingNamesOf(declarator.id)),
        });
      },
    }).visit(parsed.program);
    const innermostScopeOf = (offset: number) =>
      scopes
        .filter((scope) => scope.start < offset && offset < scope.end)
        .toSorted((first, second) => second.start - first.start)[0];
    for (const declaration of declarations) {
      const scope = innermostScopeOf(declaration.start);
      if (scope === undefined) {
        continue;
      }
      for (const name of declaration.names) {
        scope.names.add(name);
      }
    }
    const isShadowed = (name: string, offset: number) =>
      scopes.some((scope) => scope.start <= offset && offset < scope.end && scope.names.has(name));
    const referencesByStatement = body.map(() => new Set<string>());
    const candidates = identifiers.filter(
      (identifier) =>
        !notReferences.has(identifier.start) &&
        !skippedRanges.some(
          (range) => range.start <= identifier.start && identifier.start < range.end,
        ),
    );
    if (symbolIdsAt === undefined) {
      for (const identifier of candidates) {
        if (!isShadowed(identifier.name, identifier.start)) {
          referencesByStatement[statementAt(identifier.start)]?.add(identifier.name);
        }
      }
    } else {
      const exportedLocals = new Set(localNameOfExport.values());
      const candidatesNamed = Map.groupBy(candidates, (identifier) => identifier.name);
      const declarationOf = new Map(
        [...exportedLocals].flatMap((name) => {
          const declaring = statementOfLocal.get(name);
          const declared = candidatesNamed
            .get(name)
            ?.find((identifier) => statementAt(identifier.start) === declaring);
          return declared === undefined ? [] : [[name, declared.start] as const];
        }),
      );
      const referencing = candidates.filter((identifier) => exportedLocals.has(identifier.name));
      const ids = yield* symbolIdsAt([
        ...[...declarationOf].map(([name, start]) => ({
          start,
          end: start + name.length,
          shorthand: false,
        })),
        ...referencing.map((identifier) => ({
          start: identifier.start,
          end: identifier.start + identifier.name.length,
          shorthand: shorthandStarts.has(identifier.start),
        })),
      ]);
      const declaredIds = new Map(
        [...declarationOf.keys()].map((name, index) => [name, ids[index]?.id] as const),
      );
      for (const [index, identifier] of referencing.entries()) {
        const id = ids[declarationOf.size + index]?.id;
        const refersToTheTopLevelDeclaration =
          id !== undefined && id === declaredIds.get(identifier.name);
        if (refersToTheTopLevelDeclaration) {
          referencesByStatement[statementAt(identifier.start)]?.add(identifier.name);
        }
      }
    }
    return {
      exports,
      referencesByStatement,
      localNameOfExport,
      exportsOfStatement,
    };
  });

const violationOfAnExportUsedOnlyBy = (
  users: readonly string[],
  exported: { readonly location: string; readonly exportName: string },
) =>
  users.some((user) => isWithin(user, SCRIPTS_DIRECTORY))
    ? new ScriptOnlyExport({
        ...exported,
        isUsedByTests: users.some((user) => isUnderTestDirectory(user)),
      })
    : new TestOnlyExport(exported);

export const findExportPlacementViolations = <Failure, Requirements>(
  projectFile: string,
  openedProjects: Effect.Effect<
    Effect.Success<ReturnType<typeof openTypeScriptProjects>>,
    Failure,
    Requirements
  >,
) =>
  Effect.gen(function* () {
    const opened = yield* openedProjects;
    const resolvedGraph = yield* findTheImporterGraph(projectFile).pipe(
      Effect.asSome,
      Effect.catchTag(
        "ImportUnresolvableInTheImportBoundaryCheck",
        () => UNRESOLVABLE_IMPORTS_ARE_REPORTED_BY_THE_IMPORT_BOUNDARY_CHECK,
      ),
    );
    if (Option.isNone(resolvedGraph)) {
      return;
    }
    const graph = resolvedGraph.value;
    const {
      paths,
      entrySources,
      reach,
      exportsAreReadFromOutside,
      roots,
      reachable,
      moduleDirectories,
    } = graph;
    const projectDirectory = (yield* Path.Path).dirname(yield* absolutePathOf(projectFile));
    const ownedPaths = yield* ownedFilesAmong(projectDirectory, paths);
    const owned = new Set(ownedPaths);
    const symbolIdsIn = projectSymbolsIn(projectDirectory, opened);
    const files = new Map(
      yield* Effect.forEach(graph.files, ([file, uses]) =>
        parsedFile(uses.parsed, uses.text, symbolIdsIn(file)).pipe(
          Effect.map((parsed) => [file, { ...parsed, ...uses }] as const),
        ),
      ),
    );
    const runByScripts = reach(
      paths.filter((path) => isTopLevelScript(path)),
      (use) => use.kind !== "type",
    );

    const builtByScripts = new Set(
      [...files].flatMap(([file, parsed]) =>
        isWithin(file, SCRIPTS_DIRECTORY)
          ? parsed.uses.filter((use) => use.kind === "build").map((use) => use.file)
          : [],
      ),
    );
    const isServedOnlyToScripts = (file: string) =>
      isWithin(file, SOURCE_DIRECTORY) &&
      !builtByScripts.has(file) &&
      !(directoryOf(file) === SOURCE_DIRECTORY && isEntryFileName(fileNameOf(file)));

    const users = new Map<string, Map<string, Set<string>>>();
    const usersOf = (file: string, name: string) => {
      const byName = users.get(file) ?? new Map<string, Set<string>>();
      users.set(file, byName);
      const found = byName.get(name) ?? new Set<string>();
      byName.set(name, found);
      return found;
    };
    const isExportedFrom = (file: string, name: string) =>
      files.get(file)?.exports.has(name) ?? false;
    const everyExportUsers = new Map<string, Set<string>>();
    const everyExportUsersOf = (file: string) => {
      const found = everyExportUsers.get(file) ?? new Set<string>();
      everyExportUsers.set(file, found);
      return found;
    };
    const markUse = (file: string, name: string, user: string) => {
      if (name === EVERY_EXPORT) {
        everyExportUsersOf(file).add(user);
      } else {
        usersOf(file, name).add(user);
      }
    };
    for (const [file, parsed] of files) {
      for (const use of parsed.uses) {
        for (const name of use.names) {
          markUse(use.file, name, file);
        }
      }
    }
    for (const root of roots) {
      markUse(root, EVERY_EXPORT, root);
    }
    const allUsersOf = (file: string, name: string): ReadonlySet<string> => {
      const named = users.get(file)?.get(name);
      const everyUser = isExportedFrom(file, name) ? everyExportUsers.get(file) : undefined;
      if (everyUser === undefined) {
        return named ?? new Set();
      }
      return named === undefined ? everyUser : new Set([...named, ...everyUser]);
    };

    for (const [file, parsed] of files) {
      const inherits: { readonly from: string; readonly to: string }[] = [];
      const statementsReferencing = new Map<string, number[]>();
      for (const [index, references] of parsed.referencesByStatement.entries()) {
        for (const reference of references) {
          const statements = statementsReferencing.get(reference) ?? [];
          statements.push(index);
          statementsReferencing.set(reference, statements);
        }
      }
      for (const [name, exported] of parsed.exports) {
        const localName = parsed.localNameOfExport.get(name);
        if (localName === undefined) {
          continue;
        }
        for (const index of statementsReferencing.get(localName) ?? []) {
          if (exported.statement === index) {
            continue;
          }
          const exportingNames = (parsed.exportsOfStatement.get(index) ?? []).filter(
            (exportingName) => exportingName !== name,
          );
          if (exportingNames.length === 0) {
            usersOf(file, name).add(file);
          }
          for (const from of exportingNames) {
            inherits.push({ from, to: name });
          }
        }
      }
      const inheritUsersUntilStable = () => {
        const inheritChanges = inherits.map(({ from, to }) => {
          const target = usersOf(file, to);
          const addedUsers = [...allUsersOf(file, from)].filter((user) => !target.has(user));
          for (const user of addedUsers) {
            target.add(user);
          }
          return addedUsers.length > 0;
        });
        if (inheritChanges.includes(true)) {
          inheritUsersUntilStable();
        }
      };
      inheritUsersUntilStable();
    }

    const exportViolations: (ScriptOnlyExport | TestOnlyExport | UnusedExport)[] = [];
    for (const [file, parsed] of files) {
      const isExemptFromExportChecks =
        !owned.has(file) ||
        isUnderTestDirectory(file) ||
        exportsAreReadFromOutside(file) ||
        isDeclarationFile(file);
      if (isExemptFromExportChecks) {
        continue;
      }
      for (const [name, { line }] of parsed.exports) {
        const location = `${file}:${line}`;
        const recordedUsers = [...allUsersOf(file, name)];
        const everyUser = recordedUsers.filter((user) => reachable.has(user));
        const [unreachableUser] = recordedUsers
          .filter((user) => user !== file && !reachable.has(user))
          .toSorted();
        const elsewhere = everyUser.filter((user) => user !== file);
        const usedInOwnFile = everyUser.includes(file);
        const isUnusedOrUsedOnlyByTestsAndScripts =
          elsewhere.every(
            (user) =>
              isUnderTestDirectory(user) ||
              (isWithin(user, SCRIPTS_DIRECTORY) && isServedOnlyToScripts(file)),
          ) &&
          !(usedInOwnFile && elsewhere.length > 0) &&
          (elsewhere.length === 0 || !isWithin(file, SCRIPTS_DIRECTORY));
        if (isUnusedOrUsedOnlyByTestsAndScripts) {
          exportViolations.push(
            elsewhere.length === 0
              ? new UnusedExport({
                  location,
                  exportName: name,
                  ...(unreachableUser === undefined ? {} : { unreachableUser }),
                })
              : violationOfAnExportUsedOnlyBy(elsewhere, { location, exportName: name }),
          );
        }
      }
    }
    const violations = [
      ...entrySources
        .filter(({ sources }) => sources.length === 0)
        .map(({ entry }) => new PackageEntryWithoutSource({ entry })),
      ...ownedPaths
        .filter((file) => isTestEntryFile(file) && !runByScripts.has(file))
        .map((file) => new TestNotRun({ location: file })),
      ...exportViolations,
      ...findMisplacedFiles({
        paths,
        importersOf: graph.importersOf,
        moduleDirectories,
        fixedFiles: new Set([
          ...roots,
          ...paths.filter(
            (file) => !owned.has(file) || isDeclarationFile(file) || isUnderTestDirectory(file),
          ),
        ]),
      }),
    ];
    if (violations.length > 0) {
      return yield* new ExportPlacementViolations({ violations });
    }
  }).pipe(Effect.scoped);
