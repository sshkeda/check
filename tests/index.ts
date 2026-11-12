import { Task } from "@sshkeda/task";
import { Effect } from "effect";

import * as literalLintConfigCall from "./internal/accepts-only-a-literal-lint-config-call.ts";
import * as globScanning from "./internal/allows-glob-matching-but-not-scanning.ts";
import * as bannedMembers from "./internal/bans-only-members-their-objects-have.ts";
import * as permissionBanSamples from "./internal/checks-every-ban-sample.ts";
import * as packageScope from "./internal/checks-only-the-package-that-runs-it.ts";
import * as permissionBanRestrictions from "./internal/confines-permission-bans.ts";
import * as stdioConfinement from "./internal/confines-stdio-to-granted-files.ts";
import * as inferrableAnnotations from "./internal/detects-inferrable-annotations.ts";
import * as repeatedServiceYields from "./internal/detects-repeated-service-yields.ts";
import * as effectFailureHandling from "./internal/enforces-effect-failure-handling.ts";
import * as effectLanguageServiceRules from "./internal/enforces-effect-language-service-rules.ts";
import * as effectNativeRestrictions from "./internal/enforces-effect-native-restrictions.ts";
import * as effectServices from "./internal/enforces-effect-service-boundaries.ts";
import * as fileLayout from "./internal/enforces-file-layout.ts";
import * as fileTypes from "./internal/enforces-file-types.ts";
import * as scriptsModuleLayout from "./internal/enforces-scripts-module-layout.ts";
import * as formatConfig from "./internal/formats-with-the-format-config-from-check.ts";
import * as generatedFiles from "./internal/grants-generated-files.ts";
import * as permissionsByFile from "./internal/grants-permissions-by-file.ts";
import * as testImportBoundaries from "./internal/imports-tests-only-from-scripts.ts";
import * as packedTarball from "./internal/installs-packed-tarball-in-a-consumer.ts";
import * as taskStateOutOfHome from "./internal/keeps-task-state-out-of-home.ts";
import * as compiledFileCoverage from "./internal/lints-every-compiled-file.ts";
import * as typeScriptConfigRequirements from "./internal/names-each-unmet-tsconfig-requirement.ts";
import * as ownCheck from "./internal/passes-its-own-check.ts";
import * as exportPlacement from "./internal/places-exports-in-the-narrowest-directory.ts";
import * as standaloneRuleCoverage from "./internal/preserves-oxlint-rule-coverage.ts";
import * as quietFailures from "./internal/prints-quiet-check-failures.ts";
import * as errorMappingsToDone from "./internal/refuses-error-mappings-to-done.ts";
import * as fileLocationGrants from "./internal/refuses-file-location-grants.ts";
import * as hiddenImports from "./internal/refuses-hidden-imports.ts";
import * as importBoundaries from "./internal/refuses-imports-across-boundaries.ts";
import * as layerProvides from "./internal/refuses-layer-provides-outside-program-starts.ts";
import * as typeOnlySchemas from "./internal/refuses-schemas-used-only-as-types.ts";
import * as syncCalls from "./internal/refuses-sync-calls-in-every-file.ts";
import * as assertions from "./internal/refuses-test-runners-and-assertions-outside-test-home.ts";
import * as testingHelpers from "./internal/refuses-testing-helpers-outside-test-files.ts";
import * as unobservedForkFailures from "./internal/refuses-unobserved-fork-failures.ts";
import * as identifierNaming from "./internal/rejects-abbreviated-names.ts";
import * as bunModuleImports from "./internal/rejects-bun-module-imports.ts";
import * as sharedHolders from "./internal/rejects-captured-writes-inside-effect-callbacks.ts";
import * as commentRestrictions from "./internal/rejects-comments.ts";
import * as testTimeouts from "./internal/rejects-deadlines-inside-tests.ts";
import * as declaredValues from "./internal/rejects-declared-values.ts";
import * as droppedFailuresOutsideEffect from "./internal/rejects-dropped-failures-in-layers-streams-and-options.ts";
import * as duplicateFunctions from "./internal/rejects-duplicate-functions.ts";
import * as dynamicRuntimeCalls from "./internal/rejects-dynamic-runtime-calls.ts";
import * as fixedFallbacks from "./internal/rejects-fixed-fallbacks.ts";
import * as globalErrorFailureTypes from "./internal/rejects-global-error-failure-types.ts";
import * as instantRetries from "./internal/rejects-instant-retries.ts";
import * as letAndMutableRef from "./internal/rejects-let-and-mutable-ref.ts";
import * as indexLogic from "./internal/rejects-logic-in-index-files.ts";
import * as signatureRestrictions from "./internal/rejects-loose-type-annotations.ts";
import * as manualTagRestrictions from "./internal/rejects-manual-tags.ts";
import * as moduleEscapes from "./internal/rejects-module-escapes.ts";
import * as namespaceAliases from "./internal/rejects-namespace-aliases.ts";
import * as nodeBuiltinImports from "./internal/rejects-node-builtin-imports.ts";
import * as permissionEscapes from "./internal/rejects-permission-escapes.ts";
import * as reExports from "./internal/rejects-re-exports.ts";
import * as recoveredExists from "./internal/rejects-recovered-file-system-exists.ts";
import * as retiredWords from "./internal/rejects-retired-words.ts";
import * as scheduleRestrictions from "./internal/rejects-schedules-without-signals.ts";
import * as shebangLines from "./internal/rejects-shebang-lines.ts";
import * as typeDeclarations from "./internal/rejects-type-and-interface-declarations.ts";
import * as uncalledCheckedMembers from "./internal/rejects-uncalled-checked-members.ts";
import * as unnamedCompoundConditions from "./internal/rejects-unnamed-compound-conditions.ts";
import * as unnamedFallbacks from "./internal/rejects-unnamed-fallbacks.ts";
import * as unnamedRecovery from "./internal/rejects-unnamed-recovery.ts";
import * as vagueErrorClassNames from "./internal/rejects-vague-error-class-names.ts";
import * as vagueFileNames from "./internal/rejects-vague-file-names.ts";
import * as whileLoops from "./internal/rejects-while-loops.ts";
import * as causesReportedOnce from "./internal/reports-each-cause-once.ts";
import * as duplicatePackageOnce from "./internal/reports-each-duplicate-package-once.ts";
import * as failureReports from "./internal/reports-each-failure-with-its-tag.ts";
import * as restrictedImportsOnce from "./internal/reports-each-restricted-import-once.ts";
import * as unusedCodeGrants from "./internal/reports-unused-code-grants.ts";
import * as literalConstants from "./internal/requires-exact-literal-constants.ts";
import * as inlineModuleUrls from "./internal/requires-inline-module-urls.ts";
import * as serviceLayers from "./internal/requires-separate-service-layers.ts";
import * as consumerChecks from "./internal/runs-every-check-in-a-consumer.ts";
import * as sharedTypeScriptProject from "./internal/shares-one-typescript-project-per-run.ts";
import * as nestedWorktrees from "./internal/skips-nested-git-worktrees.ts";
import * as checkCommand from "./internal/starts-check-as-a-command.ts";
import * as pickedLintRules from "./internal/turns-on-the-picked-lint-rules.ts";
import { stageCheckUnderNodeModules } from "./shared/checked-project.ts";

export const ci = Task.make({
  name: "ci",
  run: Effect.andThen(
    stageCheckUnderNodeModules,
    Task.allSettled(
      [
        fileLocationGrants,
        testImportBoundaries,
        standaloneRuleCoverage,
        globScanning,
        ownCheck,
        retiredWords,
        vagueFileNames,
        indexLogic,
        hiddenImports,
        inlineModuleUrls,
        exportPlacement,
        effectFailureHandling,
        effectServices,
        consumerChecks,
        identifierNaming,
        commentRestrictions,
        manualTagRestrictions,
        repeatedServiceYields,
        serviceLayers,
        errorMappingsToDone,
        unobservedForkFailures,
        dynamicRuntimeCalls,
        effectLanguageServiceRules,
        effectNativeRestrictions,
        scheduleRestrictions,
        instantRetries,
        nodeBuiltinImports,
        generatedFiles,
        permissionsByFile,
        permissionEscapes,
        quietFailures,
        permissionBanRestrictions,
        signatureRestrictions,
        vagueErrorClassNames,
        globalErrorFailureTypes,
        inferrableAnnotations,
        fileLayout,
        scriptsModuleLayout,
        fileTypes,
        duplicateFunctions,
        failureReports,
        literalConstants,
        packedTarball,
        taskStateOutOfHome,
        bannedMembers,
        moduleEscapes,
        namespaceAliases,
        uncalledCheckedMembers,
        unnamedFallbacks,
        recoveredExists,
        fixedFallbacks,
        unusedCodeGrants,
        unnamedRecovery,
        droppedFailuresOutsideEffect,
        bunModuleImports,
        literalLintConfigCall,
        importBoundaries,
        layerProvides,
        stdioConfinement,
        syncCalls,
        testTimeouts,
        compiledFileCoverage,
        testingHelpers,
        assertions,
        restrictedImportsOnce,
        permissionBanSamples,
        packageScope,
        typeScriptConfigRequirements,
        typeDeclarations,
        declaredValues,
        reExports,
        unnamedCompoundConditions,
        letAndMutableRef,
        sharedHolders,
        whileLoops,
        shebangLines,
        sharedTypeScriptProject,
        formatConfig,
        causesReportedOnce,
        duplicatePackageOnce,
        typeOnlySchemas,
        pickedLintRules,
        nestedWorktrees,
        checkCommand,
      ],
      { concurrency: 6 },
    ),
  ),
});
