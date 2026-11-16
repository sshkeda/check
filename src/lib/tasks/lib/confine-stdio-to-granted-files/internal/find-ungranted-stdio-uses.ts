import { Effect, Path, Schema } from "effect";
import { SyntaxKind } from "typescript/unstable/ast";
import type { ImportDeclaration, Node, SourceFile } from "typescript/unstable/ast";
import {
  isBindingElement,
  isComputedPropertyName,
  isElementAccessExpression,
  isExpressionWithTypeArguments,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isNamespaceImport,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isPropertyAccessExpression,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeNode,
} from "typescript/unstable/ast/is";
import { isStringLiteralType, isTypeParameter, isUnionType } from "typescript/unstable/async";
import type { Checker, Type } from "typescript/unstable/async";

import {
  moduleSpecifiersOfGlobalObject,
  READS_CONFIG,
  WRITES_TO_THE_TERMINAL,
} from "../../../../../shared/bans-each-permission-lifts.ts";
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
  GrantNothingUses,
  StdioArgumentsReadWithoutGrant,
  StdioTerminalWriteWithoutGrant,
  STDIO_PERMISSION,
  StdioUsesRefused,
} from "./stdio-use-errors.ts";

const STDIO_TYPE_ID = "~effect/Stdio";

const PERMISSION_OF_STDIO_MEMBER = new Map<string, typeof STDIO_PERMISSION.Type>([
  ["args", READS_CONFIG],
  ["stdout", WRITES_TO_THE_TERMINAL],
  ["stderr", WRITES_TO_THE_TERMINAL],
]);

const PROCESS = "process";
const PROCESS_MEMBERS_THAT_READ_CONFIG = new Set(["env", "argv"]);
const EFFECT = "effect";
const PERMISSION_OF_MODULE = new Map<string, typeof STDIO_PERMISSION.Type>([
  ["effect/Config", READS_CONFIG],
  ...moduleSpecifiersOfGlobalObject(PROCESS).map((specifier) => [specifier, READS_CONFIG] as const),
  ["effect/Stdio", WRITES_TO_THE_TERMINAL],
]);
const PERMISSION_OF_NAME = new Map<string, typeof STDIO_PERMISSION.Type>([
  ["Config", READS_CONFIG],
  ["Stdio", WRITES_TO_THE_TERMINAL],
]);
const EVERY_STDIO_PERMISSION = [READS_CONFIG, WRITES_TO_THE_TERMINAL] as const;

const isStdioPermission = Schema.is(STDIO_PERMISSION);

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

const processMemberRead = (reference: Node) => {
  const parent = parentOf(reference);
  const isMemberRead =
    parent !== undefined && isPropertyAccessExpression(parent) && parent.expression === reference;
  if (isMemberRead) {
    return parent.name.text;
  }
  const isElementRead =
    parent !== undefined && isElementAccessExpression(parent) && parent.expression === reference;
  if (!isElementRead) {
    return;
  }
  const key = parent.argumentExpression;
  return isIdentifier(key) ? undefined : literalKeyText(key);
};

const readsConfigThroughProcess = (processReference: Node) => {
  const parent = parentOf(processReference);
  const isGlobalMember =
    parent !== undefined && isPropertyAccessExpression(parent) && parent.name === processReference;
  const member = processMemberRead(isGlobalMember ? parent : processReference);
  return member === undefined || PROCESS_MEMBERS_THAT_READ_CONFIG.has(member);
};

const namespacePermissions = (moduleName: string) => {
  if (moduleName === EFFECT) {
    return EVERY_STDIO_PERMISSION;
  }
  const permission = PERMISSION_OF_MODULE.get(moduleName);
  return permission === undefined ? [] : [permission];
};

const importedBindings = (declaration: ImportDeclaration) => {
  const { importClause, moduleSpecifier } = declaration;
  const isNamedModuleImport = importClause !== undefined && isStringLiteral(moduleSpecifier);
  if (!isNamedModuleImport) {
    return [];
  }
  const moduleName = moduleSpecifier.text;
  const isTypeOnlyClause = importClause.phaseModifier === SyntaxKind.TypeKeyword;
  const modulePermission = PERMISSION_OF_MODULE.get(moduleName);
  const bindings = importClause.namedBindings;
  const isNamespace = bindings !== undefined && isNamespaceImport(bindings);
  if (isNamespace) {
    return namespacePermissions(moduleName).map((permission) => ({
      local: bindings.name.text,
      permission,
      isTypeOnly: isTypeOnlyClause,
    }));
  }
  const isNamed = bindings !== undefined && isNamedImports(bindings);
  const named = (isNamed ? bindings.elements : []).flatMap((specifier) => {
    const imported = literalKeyText(specifier.propertyName ?? specifier.name) ?? "";
    const permission = moduleName === EFFECT ? PERMISSION_OF_NAME.get(imported) : modulePermission;
    const isTypeOnly = isTypeOnlyClause || specifier.isTypeOnly;
    return permission === undefined ? [] : [{ local: specifier.name.text, permission, isTypeOnly }];
  });
  const defaultName = importClause.name;
  const hasPermittingDefault = defaultName !== undefined && modulePermission !== undefined;
  const defaultBinding = hasPermittingDefault
    ? [{ local: defaultName.text, permission: modulePermission, isTypeOnly: isTypeOnlyClause }]
    : [];
  return [...named, ...defaultBinding];
};

const sideEffectImportPermission = (declaration: ImportDeclaration) => {
  const specifier = declaration.moduleSpecifier;
  const isSideEffectImport = declaration.importClause === undefined && isStringLiteral(specifier);
  return isSideEffectImport ? PERMISSION_OF_MODULE.get(specifier.text) : undefined;
};

const permissionOfReference = (
  reference: Node,
  permissionOfLocal: ReadonlyMap<string, typeof STDIO_PERMISSION.Type>,
) => {
  if (!isIdentifier(reference)) {
    return;
  }
  if (reference.text !== PROCESS) {
    return permissionOfLocal.get(reference.text);
  }
  return readsConfigThroughProcess(reference) ? READS_CONFIG : undefined;
};

const importDeclarationsIn = (sourceFile: SourceFile) => {
  const declarations: ImportDeclaration[] = [];
  const visit = (node: Node): void => {
    if (isImportDeclaration(node)) {
      declarations.push(node);
      return;
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return declarations;
};

const visitComputedKeysIn = (node: Node, visit: (expression: Node) => void): void => {
  if (isComputedPropertyName(node)) {
    visit(node.expression);
    return;
  }
  node.forEachChild((child) => {
    visitComputedKeysIn(child, visit);
  });
};

const permissionsUsedOutsideStdioReadsIn = (sourceFile: SourceFile) => {
  const used = new Set<typeof STDIO_PERMISSION.Type>();
  const permissionOfLocal = new Map(PERMISSION_OF_NAME);
  for (const declaration of importDeclarationsIn(sourceFile)) {
    const sideEffectPermission = sideEffectImportPermission(declaration);
    if (sideEffectPermission !== undefined) {
      used.add(sideEffectPermission);
    }
    for (const binding of importedBindings(declaration)) {
      if (binding.isTypeOnly) {
        permissionOfLocal.set(binding.local, binding.permission);
      } else {
        used.add(binding.permission);
      }
    }
  }
  const visit = (node: Node): void => {
    if (isImportDeclaration(node)) {
      return;
    }
    if (isExpressionWithTypeArguments(node)) {
      visit(node.expression);
      for (const typeArgument of node.typeArguments ?? []) {
        visitComputedKeysIn(typeArgument, visit);
      }
      return;
    }
    const isErasedType = isTypeNode(node) || isTypeAliasDeclaration(node);
    if (isErasedType) {
      visitComputedKeysIn(node, visit);
      return;
    }
    const permission = permissionOfReference(node, permissionOfLocal);
    if (permission !== undefined) {
      used.add(permission);
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return used;
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
    const stdioGrants = grants.flatMap((grant) =>
      grant.allow.filter(isStdioPermission).map((permission) => ({ path: grant.path, permission })),
    );
    const isGranted = (displayName: string, member: string) => {
      const permission = PERMISSION_OF_STDIO_MEMBER.get(member);
      return stdioGrants.some(
        (grant) => grant.path === displayName && grant.permission === permission,
      );
    };
    const usedPermissions = new Map<string, Set<typeof STDIO_PERMISSION.Type>>();
    const recordUse = (
      displayName: string,
      permission: typeof STDIO_PERMISSION.Type | undefined,
    ) => {
      if (permission === undefined) {
        return;
      }
      const used = usedPermissions.get(displayName) ?? new Set<typeof STDIO_PERMISSION.Type>();
      used.add(permission);
      usedPermissions.set(displayName, used);
    };
    const checkedFiles = new Set<string>();
    const violations: StdioUsesRefused["violations"][number][] = [];
    for (const { checker, sourceFiles } of yield* openedProjects) {
      for (const { sourceFile, displayName } of sourceFiles) {
        checkedFiles.add(displayName);
        const isGrantedFile = stdioGrants.some((grant) => grant.path === displayName);
        if (isGrantedFile) {
          for (const permission of permissionsUsedOutsideStdioReadsIn(sourceFile)) {
            recordUse(displayName, permission);
          }
        }
      }
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
          Effect.map(stdioMembersRead(checker, read), (members) => ({
            displayName,
            location,
            members,
          })),
        { concurrency: CONCURRENT_TYPESCRIPT_REQUESTS },
      );
      for (const { displayName, location, members } of found) {
        for (const member of members) {
          recordUse(displayName, PERMISSION_OF_STDIO_MEMBER.get(member));
          if (!isGranted(displayName, member)) {
            violations.push(violationOf(member, location));
          }
        }
      }
    }
    const unusedGrants = stdioGrants.filter(
      ({ path: grantedPath, permission }) =>
        checkedFiles.has(grantedPath) && usedPermissions.get(grantedPath)?.has(permission) !== true,
    );
    violations.push(
      ...unusedGrants.map(
        ({ path: grantedPath, permission }) =>
          new GrantNothingUses({ location: grantedPath, permission }),
      ),
    );
    if (violations.length > 0) {
      return yield* new StdioUsesRefused({ violations });
    }
  });
