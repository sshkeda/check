import { Context, Effect, Layer } from "effect";
import { ResolverFactory } from "oxc-resolver";

const RUNTIME_CONDITION_NAMES = ["bun", "import", "node", "default"] as const;

const TYPES_CONDITION_NAME = "types";

const newModuleResolver = (conditionNames: readonly string[]) =>
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

const makeModuleResolvers = Effect.sync(() => {
  const resolversByConditions = new Map<string, ResolverFactory>();
  return {
    resolverWith: (conditionNames: readonly string[]) => {
      const key = conditionNames.join("\0");
      const resolver = resolversByConditions.get(key) ?? newModuleResolver(conditionNames);
      resolversByConditions.set(key, resolver);
      return resolver;
    },
  };
});

class ModuleResolvers extends Context.Service<
  ModuleResolvers,
  Effect.Success<typeof makeModuleResolvers>
>()("@sshkeda/check/ModuleResolvers") {}

export const ModuleResolversLive = Layer.effect(ModuleResolvers, makeModuleResolvers);

export const conditionNamesWith = (customConditions: readonly string[]) => [
  ...customConditions,
  TYPES_CONDITION_NAME,
  ...RUNTIME_CONDITION_NAMES,
];

export const moduleResolverFor = (customConditions: readonly string[]) =>
  ModuleResolvers.use(({ resolverWith }) =>
    Effect.sync(() => resolverWith(conditionNamesWith(customConditions))),
  );

export const runtimeModuleResolver = ModuleResolvers.use(({ resolverWith }) =>
  Effect.sync(() => resolverWith(RUNTIME_CONDITION_NAMES)),
);
