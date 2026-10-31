import { Effect, Path } from "effect";
import type { Cause } from "effect";
import type { SourceFile } from "typescript/unstable/ast";
import { SignatureKind } from "typescript/unstable/async";
import type { Checker, Type } from "typescript/unstable/async";

import {
  CONCURRENT_TYPESCRIPT_REQUESTS,
  nodePosition,
  packageCalleesIn,
  requiredTypeScriptRequest,
  typeScriptRequest,
} from "../../../shared/query-the-typescript-project.ts";
import type { openTypeScriptProjects } from "../../../shared/query-the-typescript-project.ts";
import { absolutePathOf } from "../../../shared/resolve-absolute-paths.ts";
import { ErrorMappedToDone, ErrorMappingsRefused } from "./error-mapping-errors.ts";

const DONE_TYPE_ID = "~effect/Cause/Done" satisfies keyof Cause.Done;
const FAILURE_HANDLER = "onFailure";
const ERROR_MAPPINGS = new Set(["mapError", "mapErrorEager"]);
const BOTH_MAPPINGS = new Set(["mapBoth", "mapBothEager"]);
const MODULE_OF_DECLARATION_FILE = new Map([
  ["effect/dist/effect.d.ts", "Effect"],
  ["effect/dist/stream.d.ts", "Stream"],
  ["effect/dist/channel.d.ts", "Channel"],
  ["effect/dist/sink.d.ts", "Sink"],
]);

const typeMembers = (type: Type) =>
  type.isUnionType()
    ? typeScriptRequest("read union members", () => type.getTypes())
    : Effect.succeed([type]);

const canBeDone = (checker: Checker, type: Type) =>
  typeMembers(type).pipe(
    Effect.flatMap((members) =>
      Effect.forEach(members, (member) =>
        typeScriptRequest("read the Done type id", () =>
          checker.getPropertyOfType(member, DONE_TYPE_ID),
        ),
      ),
    ),
    Effect.map((properties) => properties.some((property) => property !== undefined)),
  );

const returnsDone = (checker: Checker, mapping: Type) =>
  Effect.gen(function* () {
    const signatures = yield* typeScriptRequest("read the mapping's signatures", () =>
      checker.getSignaturesOfType(mapping, SignatureKind.Call),
    );
    const returned = yield* Effect.forEach(signatures, (signature) =>
      requiredTypeScriptRequest("read the mapping's return type", () =>
        checker.getReturnTypeOfSignature(signature),
      ).pipe(Effect.flatMap((type) => canBeDone(checker, type))),
    );
    return returned.some(Boolean);
  });

const failureMappingOf = (checker: Checker, argument: Type, name: string) =>
  Effect.gen(function* () {
    if (!BOTH_MAPPINGS.has(name)) {
      return argument;
    }
    const handler = yield* typeScriptRequest("read the onFailure handler", () =>
      checker.getPropertyOfType(argument, FAILURE_HANDLER),
    );
    return handler === undefined
      ? undefined
      : yield* typeScriptRequest("read the onFailure handler's type", () =>
          checker.getTypeOfSymbol(handler),
        );
  });

const fileViolations = (
  checker: Checker,
  projectDirectory: string,
  sourceFile: SourceFile,
  displayName: string,
) =>
  Effect.gen(function* () {
    const callees = yield* packageCalleesIn(checker, projectDirectory, sourceFile);
    const mappings = callees.flatMap(({ call, file, name }) => {
      const moduleName = MODULE_OF_DECLARATION_FILE.get(file);
      const isMapping = ERROR_MAPPINGS.has(name) || BOTH_MAPPINGS.has(name);
      const mapping = call.arguments.at(-1);
      const isEffectMapping = moduleName !== undefined && isMapping && mapping !== undefined;
      return isEffectMapping ? [{ call, mapping, name, operation: `${moduleName}.${name}` }] : [];
    });
    const violations = yield* Effect.forEach(
      mappings,
      ({ call, mapping, name, operation }) =>
        Effect.gen(function* () {
          const argument = yield* typeScriptRequest("read the mapping's type", () =>
            checker.getTypeAtLocation(mapping),
          );
          const failureMapping =
            argument === undefined ? undefined : yield* failureMappingOf(checker, argument, name);
          const mapsToDone =
            failureMapping !== undefined && (yield* returnsDone(checker, failureMapping));
          if (!mapsToDone) {
            return [];
          }
          const { line, column } = nodePosition(sourceFile, call);
          return [
            new ErrorMappedToDone({ location: `${displayName}:${line}:${column}`, operation }),
          ];
        }),
      { concurrency: CONCURRENT_TYPESCRIPT_REQUESTS },
    );
    return violations.flat();
  });

export const findErrorMappingsToDone = <OpeningError, OpeningRequirement>(
  projectFile: string,
  openedProjects: Effect.Effect<
    Effect.Success<ReturnType<typeof openTypeScriptProjects>>,
    OpeningError,
    OpeningRequirement
  >,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const projectDirectory = path.dirname(yield* absolutePathOf(projectFile));
    const violations: ErrorMappedToDone[] = [];
    for (const { checker, sourceFiles } of yield* openedProjects) {
      for (const { sourceFile, displayName } of sourceFiles) {
        violations.push(
          ...(yield* fileViolations(checker, projectDirectory, sourceFile, displayName)),
        );
      }
    }
    if (violations.length > 0) {
      return yield* new ErrorMappingsRefused({ violations });
    }
  });
