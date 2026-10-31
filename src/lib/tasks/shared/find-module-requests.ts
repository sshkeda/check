import { Visitor } from "oxc-parser";
import type {
  Argument,
  Expression,
  ObjectExpression,
  ParseResult,
  TSImportTypeQualifier,
} from "oxc-parser";

const REQUIRE = "require";
const CREATE_REQUIRE = "createRequire";
const RESOLVE = "resolve";
const BUN_GLOBAL = "Bun";
const BUILD = "build";
const ENTRYPOINTS = "entrypoints";
const WORKER_CONSTRUCTORS = new Set(["Worker", "SharedWorker"]);
const MODULE_URL_PROPERTY = "url";
const PRELOAD_OPTION = "preload";
const FILE_URL_TO_PATH = "fileURLToPath";
const URL_PATH_PROPERTIES = new Set(["pathname", "href"]);
const URL_CONSTRUCTOR = "URL";
const IMPORT = "import";
const MODULE_DIRECTORY_PROPERTIES = new Set(["dir", "dirname"]);
const ADDITION = "+";
const URL_QUERY_OR_FRAGMENT = /[?#][\s\S]*$/u;
const QUERY = /\?[\s\S]*$/u;

export const withoutQuery = (specifier: string) => specifier.replace(QUERY, "");

export const MODULE_REQUEST_KINDS = [
  "static",
  "dynamic",
  "require",
  "type",
  "resolve",
  "url",
  "launch",
  "build",
] as const;

export const URL_REQUESTS = new Set<(typeof MODULE_REQUEST_KINDS)[number]>([
  "resolve",
  "url",
  "launch",
]);

export const literalSpecifierOf = (node: Expression | null | undefined): string | undefined => {
  const literalValue = node?.type === "Literal" ? node.value : undefined;
  if (typeof literalValue === "string") {
    return literalValue;
  }
  const isTemplateWithoutExpressions =
    node?.type === "TemplateLiteral" && node.expressions.length === 0;
  const cooked = isTemplateWithoutExpressions ? node.quasis[0]?.value.cooked : undefined;
  return typeof cooked === "string" ? cooked : undefined;
};

const importMetaPropertyOf = (node: Argument | Expression | null | undefined) => {
  const readsImportMetaProperty =
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "MetaProperty" &&
    node.object.meta.name === IMPORT;
  return readsImportMetaProperty ? node.property.name : undefined;
};

const isImportMetaUrl = (node: Argument | Expression | null | undefined) =>
  importMetaPropertyOf(node) === MODULE_URL_PROPERTY;

const calleeName = (callee: Expression) => {
  if (callee.type === "Identifier") {
    return callee.name;
  }
  const readsNamedProperty =
    callee.type === "MemberExpression" && !callee.computed && "name" in callee.property;
  return readsNamedProperty ? callee.property.name : undefined;
};

const isModuleUrl = (node: Expression) =>
  node.type === "NewExpression" &&
  node.callee.type === "Identifier" &&
  node.callee.name === URL_CONSTRUCTOR &&
  isImportMetaUrl(node.arguments[1]);

const isBunBuild = (callee: Expression) =>
  callee.type === "MemberExpression" &&
  !callee.computed &&
  callee.object.type === "Identifier" &&
  callee.object.name === BUN_GLOBAL &&
  callee.property.name === BUILD;

const isCreateRequireCall = (node: Expression | null | undefined) =>
  node?.type === "CallExpression" && calleeName(node.callee) === CREATE_REQUIRE;

const urlConstructionOf = (node: Expression): number | undefined => {
  if (isModuleUrl(node)) {
    return node.start;
  }
  const isFileUrlToPathCall =
    node.type === "CallExpression" && calleeName(node.callee) === FILE_URL_TO_PATH;
  if (isFileUrlToPathCall) {
    const [argument] = node.arguments;
    const isMissingOrSpreadArgument = argument === undefined || argument.type === "SpreadElement";
    return isMissingOrSpreadArgument ? undefined : urlConstructionOf(argument);
  }
  const readsUrlPathProperty =
    node.type === "MemberExpression" &&
    !node.computed &&
    URL_PATH_PROPERTIES.has(node.property.name);
  if (readsUrlPathProperty) {
    return urlConstructionOf(node.object);
  }
  return undefined;
};

const firstNameOf = (qualifier: TSImportTypeQualifier): string =>
  qualifier.type === "Identifier" ? qualifier.name : firstNameOf(qualifier.left);

const staticRequestsIn = (
  parsed: ParseResult,
): {
  readonly specifier: string;
  readonly start: number;
  readonly kind: (typeof MODULE_REQUEST_KINDS)[number];
  readonly namedExport?: string;
}[] => [
  ...parsed.module.staticImports.map((declaration) => ({
    specifier: withoutQuery(declaration.moduleRequest.value),
    start: declaration.moduleRequest.start,
    kind: "static" as const,
  })),
  ...parsed.module.staticExports.flatMap((declaration) =>
    declaration.entries.flatMap((entry) =>
      entry.moduleRequest === null
        ? []
        : [
            {
              specifier: withoutQuery(entry.moduleRequest.value),
              start: entry.moduleRequest.start,
              kind: "static" as const,
            },
          ],
    ),
  ),
];

export const moduleRequestsIn = (parsed: ParseResult) => {
  const requests = staticRequestsIn(parsed);
  const reportedByNoRequireImports = new Set<number>();
  const add = (
    node: Parameters<typeof literalSpecifierOf>[0],
    start: number,
    kind: (typeof requests)[number]["kind"],
    named: { readonly namedExport?: string } = {},
  ) => {
    const specifier = literalSpecifierOf(node);
    if (specifier !== undefined) {
      requests.push({
        specifier: withoutQuery(specifier),
        start: node?.start ?? start,
        kind,
        ...named,
      });
    }
  };
  const createdRequires = new Set<string>();
  new Visitor({
    VariableDeclarator(node) {
      const declared = node.id;
      const bindsCreateRequire = declared.type === "Identifier" && isCreateRequireCall(node.init);
      if (bindsCreateRequire) {
        createdRequires.add(declared.name);
      }
    },
  }).visit(parsed.program);
  const constantObjects = new Map<string, ObjectExpression>();
  const launched = new Set<number>();
  const launch = (node: Argument | null | undefined) => {
    const isMissingOrSpread = node === null || node === undefined || node.type === "SpreadElement";
    if (isMissingOrSpread) {
      return;
    }
    if (node.type === "ArrayExpression") {
      for (const element of node.elements) {
        launch(element);
      }
      return;
    }
    const start = urlConstructionOf(node);
    if (start !== undefined) {
      launched.add(start);
    }
  };
  const optionValue = (options: Argument | undefined, name: string): Expression[] => {
    if (options?.type === "Identifier") {
      const constant = constantObjects.get(options.name);
      return constant === undefined ? [] : optionValue(constant, name);
    }
    if (options?.type === "SpreadElement") {
      return optionValue(options.argument, name);
    }
    if (options?.type === "ParenthesizedExpression") {
      return optionValue(options.expression, name);
    }
    if (options?.type === "ConditionalExpression") {
      return [...optionValue(options.consequent, name), ...optionValue(options.alternate, name)];
    }
    if (options?.type !== "ObjectExpression") {
      return [];
    }
    return options.properties.flatMap((property) => {
      if (property.type === "SpreadElement") {
        return optionValue(property, name);
      }
      const isPropertyForOption =
        !property.computed && property.key.type === "Identifier" && property.key.name === name;
      return isPropertyForOption ? [property.value] : [];
    });
  };
  for (const statement of parsed.program.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    const isConstDeclaration =
      declaration?.type === "VariableDeclaration" && declaration.kind === "const";
    if (!isConstDeclaration) {
      continue;
    }
    for (const { id, init: value } of declaration.declarations) {
      const bindsConstantObject = id.type === "Identifier" && value?.type === "ObjectExpression";
      if (bindsConstantObject) {
        constantObjects.set(id.name, value);
      }
    }
  }
  new Visitor({
    NewExpression(node) {
      const isWorkerConstructor =
        node.callee.type === "Identifier" && WORKER_CONSTRUCTORS.has(node.callee.name);
      if (isWorkerConstructor) {
        const [entry, options] = node.arguments;
        launch(entry);
        for (const preload of optionValue(options, PRELOAD_OPTION)) {
          launch(preload);
        }
      }
    },
    CallExpression(node) {
      if (isBunBuild(node.callee)) {
        const [options] = node.arguments;
        for (const entrypoints of optionValue(options, ENTRYPOINTS)) {
          launch(entrypoints);
        }
      }
    },
  }).visit(parsed.program);
  new Visitor({
    ImportExpression(node) {
      add(node.source, node.start, "dynamic");
    },
    CallExpression(node) {
      const [first] = node.arguments;
      const isMissingOrSpread = first === undefined || first.type === "SpreadElement";
      if (isMissingOrSpread) {
        return;
      }
      const { callee } = node;
      const isBunBuildWithOptionsObject = isBunBuild(callee) && first.type === "ObjectExpression";
      if (isBunBuildWithOptionsObject) {
        for (const property of first.properties) {
          if (property.type !== "Property") {
            continue;
          }
          const { key, value: entrypointsValue } = property;
          const listsEntrypoints =
            !property.computed &&
            key.type === "Identifier" &&
            key.name === ENTRYPOINTS &&
            entrypointsValue.type === "ArrayExpression";
          if (listsEntrypoints) {
            for (const element of entrypointsValue.elements) {
              const isEntrypointNotBuiltFromModuleUrl =
                element !== null &&
                element.type !== "SpreadElement" &&
                urlConstructionOf(element) === undefined;
              if (isEntrypointNotBuiltFromModuleUrl) {
                add(element, element.start, "build");
              }
            }
          }
        }
        return;
      }
      const callsRequire =
        (callee.type === "Identifier" &&
          (callee.name === REQUIRE || createdRequires.has(callee.name))) ||
        isCreateRequireCall(callee);
      const callsImportMetaResolve =
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.property.type === "Identifier" &&
        callee.property.name === RESOLVE &&
        callee.object.type === "MetaProperty";
      const callsTheGlobalRequire =
        callee.type === "Identifier" && callee.name === REQUIRE && !createdRequires.has(REQUIRE);
      if (callsTheGlobalRequire) {
        reportedByNoRequireImports.add(first.start);
      }
      if (callsRequire) {
        add(first, node.start, "require");
      } else if (callsImportMetaResolve) {
        add(first, node.start, "resolve");
      }
    },
    NewExpression(node) {
      const [first, second] = node.arguments;
      const isUrlRelativeToModule =
        node.callee.type === "Identifier" &&
        node.callee.name === URL_CONSTRUCTOR &&
        first !== undefined &&
        first.type !== "SpreadElement" &&
        isImportMetaUrl(second);
      if (isUrlRelativeToModule) {
        const url = literalSpecifierOf(first);
        if (url !== undefined) {
          requests.push({
            specifier: url.replace(URL_QUERY_OR_FRAGMENT, ""),
            start: first.start,
            kind: launched.has(node.start) ? "launch" : "url",
          });
        }
      }
    },
    TSImportType(node) {
      add(
        node.source,
        node.start,
        "type",
        node.qualifier === null ? {} : { namedExport: firstNameOf(node.qualifier) },
      );
    },
    TSExternalModuleReference(node) {
      reportedByNoRequireImports.add(node.expression.start);
      add(node.expression, node.start, "require");
    },
  }).visit(parsed.program);
  return { requests, reportedByNoRequireImports };
};

export const MODULE_URL_USAGES = ["stored", "computed", "base", "other"] as const;

const UNNAMED_FUNCTION = "a function";

const calleeTextOf = (callee: Expression) => {
  if (callee.type === "Identifier") {
    return callee.name;
  }
  const isStaticMemberCallee = callee.type === "MemberExpression" && !callee.computed;
  if (isStaticMemberCallee) {
    return callee.object.type === "Identifier"
      ? `${callee.object.name}.${callee.property.name}`
      : callee.property.name;
  }
  return UNNAMED_FUNCTION;
};

const stored = (start: number) => ({ start, usage: "stored" as const });

const passedTo = (callee: Expression) => (start: number) => ({
  start,
  callee: calleeTextOf(callee),
});

const within = (starts: readonly number[], range: { start: number; end: number }) =>
  starts.some((start) => range.start <= start && start < range.end);

export const moduleUrlMisusesIn = (parsed: ParseResult) => {
  const classified = new Map<
    number,
    | { readonly start: number; readonly callee: string }
    | { readonly start: number; readonly usage: (typeof MODULE_URL_USAGES)[number] }
  >();
  const inline = new Set<number>();
  const moduleUrls: number[] = [];
  const importMetaStarts: number[] = [];
  const derivedBases: {
    readonly start: number;
    readonly end: number;
    readonly url: number;
  }[] = [];
  const directoryPaths: { readonly start: number; readonly property: string }[] = [];
  const classify = (
    node: Argument | Expression | null | undefined,
    misuse: (start: number) => Parameters<typeof classified.set>[1],
  ) => {
    const isImportMetaUrlNode = node !== null && node !== undefined && isImportMetaUrl(node);
    if (isImportMetaUrlNode) {
      classified.set(node.start, misuse(node.start));
    }
  };
  const directoryPath = (start: number, parts: readonly Expression[]) => {
    const property = parts
      .map((part) => importMetaPropertyOf(part))
      .find((name) => name !== undefined && MODULE_DIRECTORY_PROPERTIES.has(name));
    if (property !== undefined) {
      directoryPaths.push({ start, property });
    }
  };
  new Visitor({
    MetaProperty(node) {
      if (node.meta.name === IMPORT) {
        importMetaStarts.push(node.start);
      }
    },
    MemberExpression(node) {
      if (isImportMetaUrl(node)) {
        moduleUrls.push(node.start);
      }
    },
    VariableDeclarator(node) {
      classify(node.init, stored);
    },
    AssignmentExpression(node) {
      classify(node.right, stored);
    },
    Property(node) {
      if (node.value.type === "MemberExpression") {
        classify(node.value, stored);
      }
    },
    CallExpression(node) {
      for (const argument of node.arguments) {
        classify(argument, passedTo(node.callee));
      }
    },
    NewExpression(node) {
      const [path, base] = node.arguments;
      const isUrl = node.callee.type === "Identifier" && node.callee.name === URL_CONSTRUCTOR;
      for (const argument of node.arguments) {
        classify(argument, passedTo(node.callee));
      }
      const isUrlWithBase = isUrl && base !== undefined;
      if (isUrlWithBase) {
        if (isImportMetaUrl(base)) {
          const hasLiteralPath =
            path !== undefined &&
            path.type !== "SpreadElement" &&
            literalSpecifierOf(path) !== undefined;
          if (hasLiteralPath) {
            inline.add(base.start);
          } else {
            classify(base, (start) => ({ start, usage: "computed" }));
          }
        } else {
          derivedBases.push({ start: base.start, end: base.end, url: node.start });
        }
      }
    },
    TemplateLiteral(node) {
      directoryPath(node.start, node.expressions);
    },
    BinaryExpression(node) {
      if (node.operator === ADDITION) {
        directoryPath(node.start, [node.left, node.right]);
      }
    },
  }).visit(parsed.program);
  const misuses = moduleUrls
    .filter((start) => !inline.has(start))
    .map(
      (start): Parameters<typeof classified.set>[1] =>
        classified.get(start) ?? { start, usage: "other" },
    );
  const reported = [...misuses, ...directoryPaths].map(({ start }) => start);
  for (const base of derivedBases) {
    const isUnreportedBaseFromImportMeta =
      within(importMetaStarts, base) && !within(reported, base);
    if (isUnreportedBaseFromImportMeta) {
      misuses.push({ start: base.url, usage: "base" });
    }
  }
  return { misuses, directoryPaths };
};
