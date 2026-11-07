import { Effect, Path } from "effect";

import { generatedPathsOf } from "../../../../../shared/record-and-grant-permissions-by-path.ts";
import { encodeJson } from "../../../shared/encode-compact-json.ts";
import { installedBinary } from "../../../shared/find-installed-package-binaries.ts";
import { loadedLintConfigIn } from "../../../shared/load-the-lint-config.ts";
import {
  quietToolFailure,
  quietViolations,
} from "../../../shared/print-failures-and-keep-detail-in-the-trace.ts";
import {
  projectConfigFiles,
  TYPESCRIPT_PROJECT_FILE,
} from "../../../shared/query-the-typescript-project.ts";
import { runTool } from "../../../shared/run-tools-and-decode-their-reports.ts";
import { effectViolationsReport } from "./read-effect-tsgo-json-report.ts";

const EFFECT_TSGO = "effect-tsgo";

export const EFFECT_DIAGNOSTIC_SEVERITY = {
  abortControllerInEffect: "error",
  acquireReleaseDisposable: "error",
  allOfMapToForEach: "error",
  anyUnknownInErrorContext: "error",
  apiStabilityLeak: "off",
  asyncFunction: "error",
  catchAllTagDispatchToCatchTag: "error",
  catchAllToMapError: "error",
  catchChainToFirstSuccessOf: "off",
  catchConditionalRefailToCatchIf: "off",
  catchDieToOrDie: "off",
  catchIfTagToCatchTag: "off",
  catchRefailToTapError: "error",
  catchTagToCatchReason: "error",
  catchToIgnore: "off",
  catchToOrElseSucceed: "off",
  catchUnfailableEffect: "error",
  classSelfMismatch: "error",
  cryptoRandomUUID: "error",
  cryptoRandomUUIDInEffect: "error",
  deterministicKeys: "off",
  duplicatePackage: "error",
  effectDoNotation: "off",
  effectFnIife: "error",
  effectFnImplicitAny: "error",
  effectFnOpportunity: "error",
  effectGenUsesAdapter: "error",
  effectInFailure: "error",
  effectInVoidSuccess: "error",
  effectMapFlatten: "error",
  effectMapVoid: "error",
  effectSleepZeroToYieldNow: "error",
  effectSucceedWithUndefined: "error",
  effectSucceedWithVoid: "error",
  effectTryWithoutCatch: "error",
  errorPayloadShadowsName: "error",
  experimentalApiUsage: "error",
  extendsNativeError: "error",
  failCauseToConstructor: "error",
  flatMapConditionalToFilterOrFail: "error",
  flatMapIdentityToFlatten: "error",
  flatMapIgnoredParamToAndThen: "error",
  flatMapToMap: "error",
  flatMapToTap: "error",
  floatingEffect: "error",
  floatingEffectInVitest: "error",
  genericEffectServices: "error",
  globalConsole: "off",
  globalConsoleInEffect: "off",
  globalDate: "off",
  globalDateInEffect: "off",
  globalErrorInEffectCatch: "error",
  globalErrorInEffectFailure: "error",
  globalFetch: "error",
  globalFetchInEffect: "error",
  globalJson: "off",
  globalJsonInEffect: "off",
  globalRandom: "error",
  globalRandomInEffect: "error",
  globalTimers: "off",
  globalTimersInEffect: "off",
  instanceOfSchema: "error",
  layerMergeAllWithDependencies: "error",
  lazyEffect: "error",
  lazyPromiseInEffectSync: "error",
  leakingRequirements: "error",
  manualMetricTapToTrack: "error",
  mapConstToAs: "error",
  mapMapErrorToMapBoth: "error",
  mapSomeCatchNoSuchElement: "error",
  mapSomeToAsSome: "error",
  matchBooleanToIsSuccess: "error",
  matchEffectToMapBoth: "error",
  matchEffectToMatch: "error",
  matchToResultOrOption: "error",
  missedPipeableOpportunity: "off",
  missingEffectContext: "error",
  missingEffectError: "error",
  missingEffectServiceDependency: "off",
  missingLayerContext: "error",
  missingPipeableSignature: "off",
  missingReturnYieldStar: "error",
  missingStarInYieldEffectGen: "error",
  multipleCatchTag: "error",
  multipleEffectProvide: "error",
  nestedEffectGenYield: "off",
  newPromise: "error",
  newSchemaClass: "off",
  nodeBuiltinImport: "off",
  nonObjectEffectServiceType: "error",
  obsoleteMatchImport: "error",
  obsoleteSchemaImport: "error",
  optionMatchToFromOption: "error",
  outdatedApi: "error",
  overriddenSchemaConstructor: "error",
  preferBarrelImport: "off",
  preferEffectArray: "off",
  preferEffectRecord: "off",
  preferEffectString: "off",
  preferNamespaceImport: "off",
  preferSchemaOverJson: "off",
  preferSchemaTaggedError: "off",
  preferSchemaTypeProperty: "off",
  preferSucceedSomeOrNone: "error",
  preferTypedSchemaDecoder: "error",
  preferUnsafeConstructor: "error",
  processEnv: "off",
  processEnvInEffect: "off",
  promiseInEffectSuccess: "error",
  provideLayerSucceedToProvideService: "error",
  provideMergeAllToArray: "error",
  raceFirstWithSleepToTimeout: "error",
  redundantMapError: "error",
  redundantOrDie: "off",
  redundantSchemaTagIdentifier: "error",
  resultMatchToFromResult: "error",
  returnEffectInGen: "error",
  runEffectInsideEffect: "error",
  runOfExitToRunExit: "error",
  schemaClassMissingBrand: "off",
  schemaClassObjectLiteral: "error",
  schemaLiteralNonFinite: "error",
  schemaNumber: "error",
  schemaOpaqueInstanceMember: "error",
  schemaStructWithTag: "error",
  schemaSync: "error",
  schemaSyncInEffect: "error",
  schemaUnionOfLiterals: "off",
  scopeInLayerEffect: "error",
  serviceNotAsClass: "off",
  strictBooleanExpressions: "off",
  strictEffectProvide: "off",
  suspendFailToFailSync: "error",
  syncToSucceed: "error",
  timeoutCatchTagToTimeoutOrElse: "error",
  tryCatchInEffectGen: "error",
  typeUnionToSchemaUnion: "off",
  unknownInEffectCatch: "error",
  unnecessaryArrowBlock: "off",
  unnecessaryEffectGen: "error",
  unnecessaryFailYieldableError: "error",
  unnecessaryPipe: "error",
  unnecessaryPipeChain: "error",
  unnecessaryTypeofType: "error",
  unsafeEffectTypeAssertion: "off",
  unstableApiUsage: "off",
  yieldInCallArgument: "off",
} as const satisfies Readonly<Record<string, "error" | "off">>;

export const checkEffectDiagnosticsOfProject = (
  project: string,
  generatedFiles: readonly string[] = [],
  directory = ".",
) =>
  Effect.gen(function* () {
    const configuration = yield* encodeJson({
      diagnosticSeverity: EFFECT_DIAGNOSTIC_SEVERITY,
      overrides: generatedFiles.map((file) => ({
        include: [file],
        options: {
          diagnosticSeverity: Object.fromEntries(
            Object.keys(EFFECT_DIAGNOSTIC_SEVERITY).map((name) => [name, "off"]),
          ),
        },
      })),
    });
    const path = yield* Path.Path;
    const checkDirectory = yield* path.fromFileUrl(new URL(".", import.meta.url));
    const binary = yield* installedBinary(checkDirectory, "@effect/tsgo", EFFECT_TSGO);
    yield* runTool(
      EFFECT_TSGO,
      process.execPath,
      [
        binary,
        "diagnostics",
        "--project",
        path.resolve(directory, project),
        "--strict",
        "--format",
        "json",
        "--lspconfig",
        configuration,
      ],
      checkDirectory,
    );
  });

export const effectDiagnosticsIn = (directory: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const generated = [
      ...generatedPathsOf(yield* loadedLintConfigIn(directory).pipe(quietViolations(EFFECT_TSGO))),
    ].map((file) => path.resolve(directory, file));
    const configFiles = yield* projectConfigFiles(
      path.join(directory, TYPESCRIPT_PROJECT_FILE),
    ).pipe(quietViolations(EFFECT_TSGO));
    for (const configFile of configFiles) {
      yield* checkEffectDiagnosticsOfProject(
        path.relative(directory, configFile),
        generated,
        directory,
      ).pipe(
        quietToolFailure(EFFECT_TSGO, (exited) =>
          effectViolationsReport(EFFECT_TSGO, exited.standardOutput),
        ),
      );
    }
  });
