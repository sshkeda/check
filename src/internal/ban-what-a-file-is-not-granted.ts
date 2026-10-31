import { defineRule } from "@oxlint/plugins";
import type { Context, ESTree, SourceCode, Visitor } from "@oxlint/plugins";
import { Schema } from "effect";

import {
  BANS_NO_GRANT_LIFTS,
  bansNoGrantLifts,
  CREATE_REQUIRE_VALUE_USAGE,
  CREATED_REQUIRE_USAGE,
  IMPORT_META,
  moduleSpecifiersOfGlobalObject,
  PERMISSION_BANS,
} from "../shared/bans-each-permission-lifts.ts";
import type { importsBan } from "../shared/bans-each-permission-lifts.ts";
import { decodeRuleOptions, ruleOptionsJsonSchema } from "./describe-and-decode-rule-options.ts";
import {
  bansByKind,
  importBansEquivalentToGlobalMembers,
  isBannedByANodeBuiltinRule,
  moduleBansMatcher,
  modulePatternMatcher,
} from "./match-banned-modules-and-globals.ts";
import {
  effectModuleReference,
  DEFAULT_EXPORT,
  importedExpression,
  importsOnlyTypes,
  isGlobalReference,
  isMemberExpressionObject,
  isReferencePosition,
  isValueOperandOfTypeScriptOrExport,
  memberName,
  moduleExportName,
  propertyKeyName,
  resolvedVariable,
  staticKeyName,
  unwrappedExpression,
} from "./resolve-what-an-expression-imports.ts";

const importBansMatcher = (importBans: readonly ReturnType<typeof importsBan>[]) => {
  const entries = importBans.map((ban) => ({
    matchesModule: modulePatternMatcher(ban.modulePattern),
    importNames: ban.importNames,
  }));
  return (specifier: string, name: string) =>
    entries.find((entry) => entry.importNames.includes(name) && entry.matchesModule(specifier));
};

const dottedPath = (path: readonly string[]) => path.join(".");

const specifierImportedName = (specifier: ESTree.ImportDeclaration["specifiers"][number]) => {
  if (specifier.type !== "ImportSpecifier") {
    return;
  }
  return moduleExportName(specifier.imported);
};

const WHOLE_MODULE_IMPORTS = new Set(["ImportDefaultSpecifier", "ImportNamespaceSpecifier"]);

const isWholeModuleImportOf = (
  node: ESTree.Node,
  sourceCode: SourceCode,
  moduleSpecifiers: readonly string[],
) => {
  const definition = resolvedVariable(node, sourceCode)?.defs[0]?.node;
  if (definition?.parent?.type !== "ImportDeclaration") {
    return false;
  }
  const importsWholeModule =
    WHOLE_MODULE_IMPORTS.has(definition.type) ||
    (definition.type === "ImportSpecifier" && specifierImportedName(definition) === DEFAULT_EXPORT);
  return importsWholeModule && moduleSpecifiers.includes(definition.parent.source.value);
};

const isImportMeta = (node: ESTree.Node) =>
  node.type === "MetaProperty" && node.meta.name === "import" && node.property.name === "meta";

const constantInitializer = (node: ESTree.Node, sourceCode: SourceCode) => {
  const definitions = resolvedVariable(node, sourceCode)?.defs ?? [];
  const declarator = definitions.length === 1 ? definitions[0]?.node : undefined;
  const isConstantDeclarator =
    declarator?.type === "VariableDeclarator" &&
    declarator.id.type === "Identifier" &&
    declarator.parent.type === "VariableDeclaration" &&
    declarator.parent.kind === "const";
  return isConstantDeclarator ? (declarator.init ?? undefined) : undefined;
};

const constantKeyName = (
  key: ESTree.Node,
  sourceCode: SourceCode,
  followedAliases: Set<ESTree.Node> = new Set(),
): string | undefined => {
  const unwrapped = unwrappedExpression(key);
  if (unwrapped.type !== "Identifier") {
    return staticKeyName(unwrapped);
  }
  const initializer = constantInitializer(unwrapped, sourceCode);
  const isFollowedOrMissing = initializer === undefined || followedAliases.has(initializer);
  if (isFollowedOrMissing) {
    return;
  }
  followedAliases.add(initializer);
  return constantKeyName(initializer, sourceCode, followedAliases);
};

const memberNameOrConstantKey = (node: ESTree.MemberExpression, sourceCode: SourceCode) =>
  memberName(node) ?? (node.computed ? constantKeyName(node.property, sourceCode) : undefined);

const propertyKeyNameOrConstantKey = (property: ESTree.Node, sourceCode: SourceCode) => {
  const name = propertyKeyName(property);
  const isComputedProperty =
    name === undefined && property.type === "Property" && property.computed;
  return isComputedProperty ? constantKeyName(property.key, sourceCode) : name;
};

const isGlobalObjectReference = (
  expression: ESTree.Node,
  sourceCode: SourceCode,
  globalObject: string,
  followedAliases: Set<ESTree.Node> = new Set(),
): boolean => {
  const node = unwrappedExpression(expression);
  if (globalObject === IMPORT_META) {
    return isImportMeta(node);
  }
  if (isGlobalReference(node, sourceCode, globalObject)) {
    return true;
  }
  const moduleSpecifiers = moduleSpecifiersOfGlobalObject(globalObject);
  const isWholeModuleImport =
    moduleSpecifiers.length > 0 &&
    node.type === "Identifier" &&
    isWholeModuleImportOf(node, sourceCode, moduleSpecifiers);
  if (isWholeModuleImport) {
    return true;
  }
  const aliased = constantInitializer(node, sourceCode);
  const isUnfollowedAlias = aliased !== undefined && !followedAliases.has(aliased);
  return (
    isUnfollowedAlias &&
    isGlobalObjectReference(
      aliased,
      sourceCode,
      globalObject,
      new Set([...followedAliases, aliased]),
    )
  );
};

const mergedVisitors = (visitors: readonly Visitor[]): Visitor => {
  const handlers = new Map<string, ((node: never) => void)[]>();
  for (const visitor of visitors) {
    for (const [key, handler] of Object.entries(visitor)) {
      if (handler !== undefined) {
        handlers.set(key, [...(handlers.get(key) ?? []), handler]);
      }
    }
  }
  return Object.fromEntries(
    Array.from(handlers, ([key, keyHandlers]) => [
      key,
      (node: never) => {
        for (const handler of keyHandlers) {
          handler(node);
        }
      },
    ]),
  );
};

const TYPESCRIPT_WRAPPERS: ReadonlySet<string> = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);

const outermostTypeScriptWrapper = (node: ESTree.Node): ESTree.Node => {
  const { parent } = node;
  const isWrapped =
    parent !== null &&
    TYPESCRIPT_WRAPPERS.has(parent.type) &&
    "expression" in parent &&
    parent.expression === node;
  return isWrapped ? outermostTypeScriptWrapper(parent) : node;
};

const createdRequireVisitors = (
  context: Context,
  createdRequires: readonly {
    readonly matchesModule: (specifier: string) => boolean;
    readonly importNames: readonly string[];
    readonly exceptMemberNames: readonly string[];
  }[],
  report: (node: ESTree.Node, usage: string) => void,
): Visitor => {
  const { sourceCode } = context;
  const createdRequireBanOf = (node: ESTree.Node) => {
    const imported = importedExpression(node, sourceCode);
    if (imported === undefined) {
      return;
    }
    const name = dottedPath(imported.members);
    return createdRequires.find(
      (ban) => ban.importNames.includes(name) && ban.matchesModule(imported.module),
    );
  };
  const isExceptedMemberOf = (
    node: ESTree.Node,
    ban: NonNullable<ReturnType<typeof createdRequireBanOf>>,
  ) => {
    const outer = outermostTypeScriptWrapper(node);
    const { parent } = outer;
    const isObjectOfAMember = parent?.type === "MemberExpression" && parent.object === outer;
    if (!isObjectOfAMember) {
      return false;
    }
    const name = memberNameOrConstantKey(parent, sourceCode);
    return name !== undefined && ban.exceptMemberNames.includes(name);
  };
  const usesOnlyExceptedMembers = (
    call: ESTree.Node,
    ban: NonNullable<ReturnType<typeof createdRequireBanOf>>,
  ) => {
    if (isExceptedMemberOf(call, ban)) {
      return true;
    }
    const declarator = outermostTypeScriptWrapper(call).parent;
    const isUnexportedConstantBinding =
      declarator?.type === "VariableDeclarator" &&
      declarator.id.type === "Identifier" &&
      declarator.parent.type === "VariableDeclaration" &&
      declarator.parent.kind === "const" &&
      declarator.parent.parent.type !== "ExportNamedDeclaration";
    if (!isUnexportedConstantBinding) {
      return false;
    }
    const declared = sourceCode.getDeclaredVariables(declarator)[0];
    return (declared?.references ?? [])
      .filter((reference) => reference.identifier !== declarator.id)
      .every((reference) => isExceptedMemberOf(reference.identifier, ban));
  };
  const checkReference = (node: ESTree.Node) => {
    const ban = createdRequireBanOf(node);
    if (ban === undefined) {
      return;
    }
    const outer = outermostTypeScriptWrapper(node);
    const call = outer.parent;
    const isCalled = call?.type === "CallExpression" && call.callee === outer;
    if (!isCalled) {
      report(node, CREATE_REQUIRE_VALUE_USAGE);
      return;
    }
    if (!usesOnlyExceptedMembers(call, ban)) {
      report(call, CREATED_REQUIRE_USAGE);
    }
  };
  return createdRequires.length === 0
    ? {}
    : {
        Identifier(node) {
          const isValueReference =
            isReferencePosition(node) ||
            isMemberExpressionObject(node) ||
            isValueOperandOfTypeScriptOrExport(node, node.parent);
          if (isValueReference) {
            checkReference(node);
          }
        },
        MemberExpression(node) {
          checkReference(node);
        },
      };
};

const compiledBans = (bans: Parameters<typeof bansByKind>[0]) => {
  const bansOfEachKind = bansByKind(bans);
  const createdRequires = bansOfEachKind.createdRequire.map((ban) => ({
    matchesModule: modulePatternMatcher(ban.modulePattern),
    importNames: ban.importNames,
    exceptMemberNames: ban.exceptMemberNames,
  }));
  const isBannedModule = moduleBansMatcher(bansOfEachKind.module);
  const bannedImport = importBansMatcher([
    ...bansOfEachKind.imports,
    ...importBansEquivalentToGlobalMembers(bans),
  ]);
  const globalMembers = bansOfEachKind.globalMembers.flatMap((ban) =>
    ban.memberNames.map((name) => ({ globalObject: ban.globalObject, memberName: name })),
  );
  const effectMemberBans = bansOfEachKind.effectMembers.flatMap((ban) =>
    ban.memberPathPrefixes.map((memberPathPrefix) => ({
      effectModule: memberPathPrefix[0],
      dottedPrefix: dottedPath(memberPathPrefix),
      dottedExceptions: ban.exceptExactMemberPaths.map(dottedPath),
    })),
  );
  const effectModules = [...new Set(effectMemberBans.map((ban) => ban.effectModule))];
  const bansDynamicImports = bansOfEachKind.dynamicImport.length > 0;
  const bannedMemberNames = new Set(bansOfEachKind.memberNames.flatMap((ban) => ban.memberNames));

  const isBannedEffectUsage = (usage: string | undefined) =>
    usage !== undefined &&
    effectMemberBans.some(
      (ban) =>
        (usage === ban.dottedPrefix || usage.startsWith(`${ban.dottedPrefix}.`)) &&
        !ban.dottedExceptions.includes(usage),
    );

  return {
    isBannedModule,
    bannedImport,
    globalMembers,
    effectModules,
    bansDynamicImports,
    bannedMemberNames,
    isBannedEffectUsage,
    createdRequires,
  };
};

const banVisitors = (
  context: Context,
  {
    isBannedModule,
    bannedImport,
    globalMembers,
    effectModules,
    bansDynamicImports,
    bannedMemberNames,
    isBannedEffectUsage,
    createdRequires,
  }: ReturnType<typeof compiledBans>,
  messageId: "banned" | "bannedEvenWhenGranted",
): Visitor => {
  const report = (node: ESTree.Node, usage: string) => {
    context.report({ node, messageId, data: { usage } });
  };

  const reportImport = (node: ESTree.Node, specifier: string, name: string) => {
    const ban = bannedImport(specifier, name);
    if (ban === undefined) {
      return false;
    }
    report(node, `${name} from ${specifier}`);
    return true;
  };

  const globalMemberUsage = (object: ESTree.Node, property: string) =>
    globalMembers.find(
      (member) =>
        member.memberName === property &&
        isGlobalObjectReference(object, context.sourceCode, member.globalObject),
    );

  const effectReference = (node: ESTree.Node) => {
    const usage = effectModules
      .map((effectModule) => effectModuleReference(node, context.sourceCode, effectModule))
      .find((candidate) => isBannedEffectUsage(candidate));
    if (usage !== undefined) {
      report(node, usage);
    }
    return usage !== undefined;
  };

  const checkSource = (
    source: ESTree.StringLiteral,
    names: readonly { readonly node: ESTree.Node; readonly name: string | undefined }[],
  ) => {
    if (
      isBannedModule(
        source.value,
        names.map(({ name }) => name),
      )
    ) {
      report(source, source.value);
      return;
    }
    for (const { node, name } of names) {
      if (name !== undefined) {
        reportImport(node, source.value, name);
      }
    }
  };

  const importAndMemberVisitors = {
    ImportDeclaration(node) {
      const valueSpecifiers = node.specifiers.filter(
        (specifier) => specifier.type !== "ImportSpecifier" || specifier.importKind !== "type",
      );
      if (importsOnlyTypes(node, context.sourceCode)) {
        return;
      }
      checkSource(
        node.source,
        valueSpecifiers.map((specifier) => ({
          node: specifier,
          name: specifierImportedName(specifier),
        })),
      );
    },
    ImportExpression(node) {
      const source = staticKeyName(node.source);
      const loadsBannedModule = source !== undefined && isBannedModule(source, []);
      if (loadsBannedModule) {
        report(node.source, source);
      }
      const isLeftToTheModuleBan = source !== undefined && isBannedByANodeBuiltinRule(source);
      const reportsDynamicImport = bansDynamicImports && !isLeftToTheModuleBan;
      if (reportsDynamicImport) {
        report(node, "dynamic import()");
      }
    },
    Identifier(node) {
      effectReference(node);
    },
    MemberExpression(node) {
      if (effectReference(node)) {
        return;
      }
      const property = memberNameOrConstantKey(node, context.sourceCode);
      if (property === undefined) {
        return;
      }
      const member = globalMemberUsage(node.object, property);
      if (member !== undefined) {
        report(node, `${member.globalObject}.${member.memberName}`);
        return;
      }
      const imported = importedExpression(node, context.sourceCode);
      const reportedImport =
        imported !== undefined && reportImport(node, imported.module, dottedPath(imported.members));
      const isUnreportedBannedMemberName = !reportedImport && bannedMemberNames.has(property);
      if (isUnreportedBannedMemberName) {
        report(node, property);
      }
    },
    ObjectPattern(node) {
      const declarator = node.parent;
      const isDestructuredInDeclaration =
        declarator.type === "VariableDeclarator" && declarator.id === node;
      const declaredFrom = isDestructuredInDeclaration ? declarator.init : null;
      const imported =
        declaredFrom === null ? undefined : importedExpression(declaredFrom, context.sourceCode);
      for (const property of node.properties) {
        const key = propertyKeyNameOrConstantKey(property, context.sourceCode);
        if (key === undefined) {
          continue;
        }
        const member = declaredFrom === null ? undefined : globalMemberUsage(declaredFrom, key);
        if (member !== undefined) {
          report(property, `${member.globalObject}.${member.memberName}`);
          continue;
        }
        const reportedImport =
          imported !== undefined &&
          reportImport(property, imported.module, dottedPath([...imported.members, key]));
        const isUnreportedBannedMemberName =
          declaredFrom !== null && !reportedImport && bannedMemberNames.has(key);
        if (isUnreportedBannedMemberName) {
          report(property, key);
        }
      }
    },
  } satisfies Visitor;
  return mergedVisitors([
    createdRequireVisitors(context, createdRequires, report),
    importAndMemberVisitors,
  ]);
};

const BAN_OPTIONS = Schema.Struct({
  bans: Schema.optionalKey(Schema.Literals(["all", BANS_NO_GRANT_LIFTS])),
});

export const permissionBanRule = (permission: keyof typeof PERMISSION_BANS) => {
  const entry = PERMISSION_BANS[permission];
  const { description, message } = entry;
  const liftedByAGrant = compiledBans(entry.bans);
  const liftedByNoGrant = compiledBans(bansNoGrantLifts(permission));
  const liftedByNoGrantBeyondTheGrantableImports = compiledBans(
    bansNoGrantLifts(permission).filter((ban) => ban.kind !== "created-require"),
  );
  const messageEvenWhenGranted =
    "bannedEvenWhenGranted" in entry ? entry.bannedEvenWhenGranted.message : message;

  return defineRule({
    meta: {
      type: "problem",
      docs: { description },
      messages: {
        banned: message,
        bannedEvenWhenGranted: messageEvenWhenGranted,
      },
      schema: ruleOptionsJsonSchema(BAN_OPTIONS),
    },
    create(context) {
      const isGranted =
        decodeRuleOptions(BAN_OPTIONS, context.options)?.bans === BANS_NO_GRANT_LIFTS;
      return mergedVisitors([
        ...(isGranted ? [] : [banVisitors(context, liftedByAGrant, "banned")]),
        banVisitors(
          context,
          isGranted ? liftedByNoGrant : liftedByNoGrantBeyondTheGrantableImports,
          "bannedEvenWhenGranted",
        ),
      ]);
    },
  });
};
