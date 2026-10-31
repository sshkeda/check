import { ResolverFactory } from "oxc-resolver";

const RUNTIME_CONDITION_NAMES = ["bun", "import", "node", "default"] as const;

const TYPES_CONDITION_NAME = "types";

const resolversByConditions = new Map<string, ResolverFactory>();

const moduleResolverWith = (conditionNames: readonly string[]) => {
  const key = conditionNames.join("\0");
  const resolver =
    resolversByConditions.get(key) ??
    new ResolverFactory({
      extensions: [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".json"],
      extensionAlias: {
        ".js": [".ts", ".tsx", ".js"],
        ".jsx": [".tsx", ".jsx"],
        ".mjs": [".mts", ".mjs"],
        ".cjs": [".cts", ".cjs"],
      },
      tsconfig: "auto",
      builtinModules: true,
      conditionNames: [...conditionNames],
    });
  resolversByConditions.set(key, resolver);
  return resolver;
};

export const conditionNamesWith = (customConditions: readonly string[]) => [
  ...customConditions,
  TYPES_CONDITION_NAME,
  ...RUNTIME_CONDITION_NAMES,
];

export const moduleResolverFor = (customConditions: readonly string[]) =>
  moduleResolverWith(conditionNamesWith(customConditions));

export const runtimeModuleResolver = () => moduleResolverWith(RUNTIME_CONDITION_NAMES);
