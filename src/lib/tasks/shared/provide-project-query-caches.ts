import { Layer } from "effect";

import { ModuleResolversLive } from "./create-the-module-resolver.ts";
import { TypeScriptProjectListingsLive } from "./query-the-typescript-project.ts";
import { ModuleResolutionsLive } from "./resolve-module-requests.ts";

export const ProjectQueryCachesLive = Layer.mergeAll(
  ModuleResolversLive,
  ModuleResolutionsLive,
  TypeScriptProjectListingsLive,
);
