import { Effect } from "effect";
import type { Schema } from "effect";
import { NodeFlags, SyntaxKind } from "typescript/unstable/ast";
import type { Identifier, Node, SourceFile } from "typescript/unstable/ast";
import {
  isCallExpression,
  isClassDeclaration,
  isExportDeclaration,
  isExportSpecifier,
  isIdentifier,
  isImportClause,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isImportSpecifier,
  isImportTypeNode,
  isNamespaceExport,
  isNamespaceImport,
  isPropertyAccessExpression,
  isQualifiedName,
  isStringLiteralLikeNode,
  isTypeQueryNode,
  isTypeReferenceNode,
  isVariableDeclaration,
} from "typescript/unstable/ast/is";
import type { Checker, NodeHandle } from "typescript/unstable/async";

import {
  CONCURRENT_TYPESCRIPT_REQUESTS,
  followedImportAliases,
  nodePosition,
  parentOf,
  resolvedSymbols,
  typeScriptRequest,
  valueSymbolAt,
} from "../../../shared/query-the-typescript-project.ts";
import type { openTypeScriptProjects } from "../../../shared/query-the-typescript-project.ts";
import { SchemaUsedOnlyAsType } from "./declared-use-errors.ts";

const SCHEMA_TYPE_ID = "~effect/Schema/Schema" satisfies keyof Schema.Top;
const DEFAULT_EXPORT_NAME = "default";

const nodesIn = <Found extends Node>(root: Node, isWanted: (node: Node) => node is Found) => {
  const found: Found[] = [];
  const visit = (node: Node) => {
    if (isWanted(node)) {
      found.push(node);
    }
    node.forEachChild(visit);
  };
  root.forEachChild(visit);
  return found;
};

const ancestorsOf = (node: Node): readonly Node[] => {
  const parent = parentOf(node);
  return parent === undefined ? [] : [parent, ...ancestorsOf(parent)];
};

const isTypeRead = (node: Node) =>
  isTypeQueryNode(node) || (isImportTypeNode(node) && node.isTypeOf);

const identifiersOf = (name: Node) => (isIdentifier(name) ? [name] : nodesIn(name, isIdentifier));

const lastIdentifierOf = (name: Node): Identifier | undefined => {
  if (isQualifiedName(name)) {
    return name.right;
  }
  return isIdentifier(name) ? name : undefined;
};

const isInsideItsOwnClass = (reference: Identifier) =>
  ancestorsOf(reference).some(
    (ancestor) => isClassDeclaration(ancestor) && ancestor.name?.text === reference.text,
  );

const typeReadIdentifiersIn = (sourceFile: SourceFile) => [
  ...nodesIn(sourceFile, isTypeQueryNode).flatMap((read) => identifiersOf(read.exprName)),
  ...nodesIn(sourceFile, isImportTypeNode).flatMap(({ isTypeOf, qualifier }) => {
    const readsAQualifiedType = isTypeOf && qualifier !== undefined;
    return readsAQualifiedType ? identifiersOf(qualifier) : [];
  }),
  ...nodesIn(sourceFile, isTypeReferenceNode).flatMap(({ typeName }) => {
    const reference = lastIdentifierOf(typeName);
    const isReadFromOutsideItsClass = reference !== undefined && !isInsideItsOwnClass(reference);
    return isReadFromOutsideItsClass ? [reference] : [];
  }),
];

const renamesIn = (sourceFile: SourceFile) => [
  ...[...nodesIn(sourceFile, isImportSpecifier), ...nodesIn(sourceFile, isExportSpecifier)].flatMap(
    ({ propertyName, name }) => {
      const isRenamed =
        propertyName !== undefined && isIdentifier(propertyName) && isIdentifier(name);
      return isRenamed ? [{ from: propertyName.text, to: name.text }] : [];
    },
  ),
  ...nodesIn(sourceFile, isImportClause).flatMap((clause) =>
    clause.name === undefined ? [] : [{ from: DEFAULT_EXPORT_NAME, to: clause.name.text }],
  ),
  ...nodesIn(sourceFile, isImportEqualsDeclaration).flatMap((declaration) => {
    const target = lastIdentifierOf(declaration.moduleReference);
    return target === undefined ? [] : [{ from: target.text, to: declaration.name.text }];
  }),
];

const namesAliasing = (
  names: ReadonlySet<string>,
  renames: readonly { readonly from: string; readonly to: string }[],
): ReadonlySet<string> => {
  const reached = new Set([
    ...names,
    ...renames.filter(({ from }) => names.has(from)).map(({ to }) => to),
  ]);
  return reached.size === names.size ? names : namesAliasing(reached, renames);
};

const isNamespaceMemberRead = (reference: Identifier) => {
  const { parent } = reference;
  const isMemberAccess =
    isPropertyAccessExpression(parent) &&
    (parent.expression === reference || parent.name === reference);
  const isQualifiedMember =
    isQualifiedName(parent) && (parent.left === reference || parent.right === reference);
  return isMemberAccess || isQualifiedMember;
};

const modulesReadWholeIn = (sourceFile: SourceFile, identifiers: readonly Identifier[]) => {
  const modulesReadWhole = nodesIn(sourceFile, isImportDeclaration).flatMap(
    ({ importClause, moduleSpecifier }) => {
      const namespace = importClause?.namedBindings;
      const isNamespaceImported = namespace !== undefined && isNamespaceImport(namespace);
      if (!isNamespaceImported) {
        return [];
      }
      const isUsedAsValue = identifiers.some(
        (reference) =>
          reference !== namespace.name &&
          reference.text === namespace.name.text &&
          !isNamespaceMemberRead(reference),
      );
      return isUsedAsValue ? [moduleSpecifier] : [];
    },
  );
  const modulesExportedWhole = nodesIn(sourceFile, isExportDeclaration).flatMap(
    ({ exportClause, moduleSpecifier }) => {
      const isExportStarAs =
        exportClause !== undefined &&
        isNamespaceExport(exportClause) &&
        moduleSpecifier !== undefined;
      return isExportStarAs ? [moduleSpecifier] : [];
    },
  );
  const modulesImported = nodesIn(sourceFile, isCallExpression).flatMap(
    ({ expression, arguments: [specifier] }) => {
      const isNamedImport =
        expression.kind === SyntaxKind.ImportKeyword &&
        specifier !== undefined &&
        isStringLiteralLikeNode(specifier);
      return isNamedImport ? [specifier] : [];
    },
  );
  return [...modulesReadWhole, ...modulesExportedWhole, ...modulesImported];
};

const schemaNameOf = (node: Node) => {
  if (isClassDeclaration(node)) {
    return node.name;
  }
  const isNamedConst =
    isVariableDeclaration(node) &&
    isIdentifier(node.name) &&
    (node.parent.flags & NodeFlags.BlockScoped) === NodeFlags.Const;
  return isNamedConst ? node.name : undefined;
};

const handleKeyOf = (declaration: NodeHandle) => `${declaration.path}\0${declaration.index}`;

const symbolsAt = (checker: Checker, references: readonly Identifier[]) =>
  resolvedSymbols(checker, references).pipe(
    Effect.flatMap((resolved) =>
      Effect.forEach(references, (reference, index) =>
        valueSymbolAt(checker, reference, Effect.succeed(resolved[index])),
      ),
    ),
    Effect.flatMap((symbols) => followedImportAliases(checker, symbols)),
  );

export const findTypeOnlySchemas = (
  projects: Effect.Success<ReturnType<typeof openTypeScriptProjects>>,
) =>
  Effect.gen(function* () {
    const files = projects.flatMap(({ checker, allSourceFiles }) =>
      allSourceFiles.map((file) => ({ checker, ...file })),
    );
    const fileAt = new Map(
      projects.flatMap(({ sourceFiles }) =>
        sourceFiles.map((file) => [file.sourceFile.path, file] as const),
      ),
    );

    const schemasOfEachProject = yield* Effect.forEach(projects, ({ checker, sourceFiles }) =>
      Effect.gen(function* () {
        const typeRead = yield* resolvedSymbols(
          checker,
          sourceFiles.flatMap(({ sourceFile }) => typeReadIdentifiersIn(sourceFile)),
        );
        const variables = [
          ...new Map(
            typeRead.flatMap((symbol) => {
              const declaration = symbol?.valueDeclaration;
              const isProjectVariable =
                symbol !== undefined &&
                declaration !== undefined &&
                (declaration.kind === SyntaxKind.VariableDeclaration ||
                  declaration.kind === SyntaxKind.ClassDeclaration) &&
                fileAt.has(declaration.path);
              return isProjectVariable
                ? [[handleKeyOf(declaration), { symbol, declaration }] as const]
                : [];
            }),
          ).values(),
        ];
        const types = yield* typeScriptRequest("read the types of type-read variables", () =>
          checker.getTypeOfSymbol(variables.map(({ symbol }) => symbol)),
        );
        const typed = variables.flatMap((variable, index) => {
          const type = types[index];
          return type === undefined ? [] : [{ ...variable, type }];
        });
        const schemaTypeIds = yield* Effect.forEach(
          typed,
          ({ type }) =>
            typeScriptRequest("read the schema type id", () =>
              checker.getPropertyOfType(type, SCHEMA_TYPE_ID),
            ),
          { concurrency: CONCURRENT_TYPESCRIPT_REQUESTS },
        );
        const declared = yield* Effect.forEach(
          typed.filter((_entry, index) => schemaTypeIds[index] !== undefined),
          ({ declaration }) =>
            typeScriptRequest("read a schema declaration", () => declaration.resolve()).pipe(
              Effect.map((node) => ({ declaration, node })),
            ),
          { concurrency: CONCURRENT_TYPESCRIPT_REQUESTS },
        );
        return declared.flatMap(({ declaration, node }) => {
          const file = fileAt.get(declaration.path);
          const name = node === undefined ? undefined : schemaNameOf(node);
          const isSchemaInTheProject =
            file !== undefined && node !== undefined && name !== undefined;
          if (!isSchemaInTheProject) {
            return [];
          }
          return [
            [
              handleKeyOf(declaration),
              {
                name: name.text,
                location: `${file.displayName}:${nodePosition(file.sourceFile, node).line}`,
                path: declaration.path,
                start: node.pos,
                end: node.end,
              },
            ] as const,
          ];
        });
      }),
    );
    const schemas = new Map(schemasOfEachProject.flat());

    if (schemas.size === 0) {
      return [];
    }
    const enclosingSchemaOf = (path: string, reference: Node) =>
      [...schemas]
        .filter(
          ([, schema]) =>
            schema.path === path && schema.start <= reference.pos && reference.end <= schema.end,
        )
        .toSorted(([, left], [, right]) => right.start - left.start)
        .map(([key]) => key)
        .at(0);
    const referenceNames = namesAliasing(
      new Set([...schemas.values()].map(({ name }) => name)),
      files.flatMap(({ sourceFile }) => renamesIn(sourceFile)),
    );
    const valueUses = new Map<string, (string | undefined)[]>();
    const readWhole = new Set<string>();
    const identifiersIn = new Map(
      files.map(({ sourceFile }) => [sourceFile, nodesIn(sourceFile, isIdentifier)] as const),
    );
    const modulesReadWholeBy = new Map(
      [...identifiersIn].map(
        ([sourceFile, identifiers]) =>
          [sourceFile, modulesReadWholeIn(sourceFile, identifiers)] as const,
      ),
    );
    for (const { checker, allSourceFiles } of projects) {
      for (const { sourceFile } of allSourceFiles) {
        const references = (identifiersIn.get(sourceFile) ?? []).filter(
          (reference) =>
            referenceNames.has(reference.text) &&
            !(
              (isVariableDeclaration(reference.parent) || isClassDeclaration(reference.parent)) &&
              reference.parent.name === reference
            ),
        );
        if (references.length === 0) {
          continue;
        }
        const symbols = yield* symbolsAt(checker, references);
        for (const [index, reference] of references.entries()) {
          const declaration = symbols[index]?.valueDeclaration;
          const key = declaration === undefined ? undefined : handleKeyOf(declaration);
          const isSchemaReference = key !== undefined && schemas.has(key);
          if (!isSchemaReference) {
            continue;
          }
          const ancestors = ancestorsOf(reference);
          const isAliasOrTypeRead = ancestors.some(
            (node) =>
              isImportDeclaration(node) ||
              isImportEqualsDeclaration(node) ||
              isExportDeclaration(node) ||
              isTypeRead(node) ||
              isTypeReferenceNode(node),
          );
          if (isAliasOrTypeRead) {
            continue;
          }
          valueUses.set(key, [
            ...(valueUses.get(key) ?? []),
            enclosingSchemaOf(sourceFile.path, reference),
          ]);
        }
      }
      const modules = allSourceFiles.flatMap(
        ({ sourceFile }) => modulesReadWholeBy.get(sourceFile) ?? [],
      );
      if (modules.length === 0) {
        continue;
      }
      const moduleSymbols = yield* typeScriptRequest("resolve modules read whole", () =>
        checker.getSymbolAtLocation(modules),
      );
      const moduleExports = yield* Effect.forEach(
        moduleSymbols.filter((symbol) => symbol !== undefined),
        (symbol) =>
          typeScriptRequest("list a module's exports", () => checker.getExportsOfModule(symbol)),
        { concurrency: CONCURRENT_TYPESCRIPT_REQUESTS },
      );
      for (const symbol of yield* followedImportAliases(checker, moduleExports.flat())) {
        if (symbol?.valueDeclaration !== undefined) {
          readWhole.add(handleKeyOf(symbol.valueDeclaration));
        }
      }
    }

    const keepTypeOnlyUntilStable = (kept: ReadonlySet<string>): ReadonlySet<string> => {
      const stillTypeOnly = new Set(
        [...kept].filter((key) =>
          (valueUses.get(key) ?? []).every(
            (enclosing) => enclosing !== undefined && kept.has(enclosing),
          ),
        ),
      );
      return stillTypeOnly.size === kept.size ? kept : keepTypeOnlyUntilStable(stillTypeOnly);
    };
    const typeOnly = keepTypeOnlyUntilStable(
      new Set([...schemas.keys()].filter((key) => !readWhole.has(key))),
    );
    return [...schemas]
      .filter(([key]) => typeOnly.has(key))
      .map(([, { location, name }]) => new SchemaUsedOnlyAsType({ location, schemaName: name }));
  });
