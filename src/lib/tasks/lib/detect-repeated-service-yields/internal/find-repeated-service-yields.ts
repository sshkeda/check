import { Array as Arrays, Effect } from "effect";
import type { Node, SourceFile } from "typescript/unstable/ast";
import {
  isFunctionLikeDeclaration,
  isIdentifier,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isYieldExpression,
} from "typescript/unstable/ast/is";
import { SymbolFlags } from "typescript/unstable/async";
import type { Checker, Symbol as CheckerSymbol } from "typescript/unstable/async";

import {
  nodePosition,
  resolvedSymbols,
  typeScriptRequest,
} from "../../../shared/query-the-typescript-project.ts";
import type { openTypeScriptProjects } from "../../../shared/query-the-typescript-project.ts";
import { RepeatedServiceYield, RepeatedServiceYields } from "./repeated-service-yield-errors.ts";

const SERVICE_PROPERTIES = ["~effect/Context/Service", "key", "Service", "Identifier"] as const;

const yieldedReference = (node: Node): Node | undefined => {
  if (isParenthesizedExpression(node)) {
    return yieldedReference(node.expression);
  }
  if (isIdentifier(node)) {
    return node;
  }
  if (isPropertyAccessExpression(node)) {
    return node.name;
  }
  return undefined;
};

const generatorYieldGroups = (sourceFile: SourceFile) => {
  const groups: (readonly { readonly yieldExpression: Node; readonly reference: Node }[])[] = [];
  const visit = (node: Node, serviceYields?: (typeof groups)[number][number][]): void => {
    if (isFunctionLikeDeclaration(node)) {
      const isGeneratorWithBody = node.asteriskToken !== undefined && node.body !== undefined;
      if (isGeneratorWithBody) {
        node.forEachChild((child) => {
          if (child !== node.body) {
            visit(child);
          }
        });
        const generatorYields: (typeof groups)[number][number][] = [];
        node.body.forEachChild((child) => {
          visit(child, generatorYields);
        });
        if (generatorYields.length > 1) {
          groups.push(generatorYields);
        }
        return;
      }
      node.forEachChild((child) => {
        visit(child);
      });
      return;
    }
    const isDelegatingYieldWithOperand =
      serviceYields !== undefined &&
      isYieldExpression(node) &&
      node.asteriskToken !== undefined &&
      node.expression !== undefined;
    if (isDelegatingYieldWithOperand) {
      const reference = yieldedReference(node.expression);
      if (reference) {
        serviceYields.push({ yieldExpression: node, reference });
      }
    }
    node.forEachChild((child) => {
      visit(child, serviceYields);
    });
  };
  sourceFile.forEachChild((child) => {
    visit(child);
  });
  return groups;
};

const serviceTag = (checker: Checker, symbol: CheckerSymbol) =>
  Effect.gen(function* () {
    if ((symbol.flags & (SymbolFlags.Class | SymbolFlags.Variable)) === 0) {
      return false;
    }
    const symbolType = yield* typeScriptRequest("read a service type", () =>
      checker.getTypeOfSymbol(symbol),
    );
    if (symbolType === undefined) {
      return false;
    }
    const properties = yield* Effect.forEach(SERVICE_PROPERTIES, (property) =>
      typeScriptRequest("read a service property", () =>
        checker.getPropertyOfType(symbolType, property),
      ),
    );
    return properties.every((property) => property !== undefined);
  });

const fileViolations = (
  checker: Checker,
  sourceFile: SourceFile,
  displayName: string,
  serviceTags: Map<number, boolean>,
) =>
  Effect.gen(function* () {
    const violations: RepeatedServiceYield[] = [];
    for (const serviceYields of generatorYieldGroups(sourceFile)) {
      const symbols = yield* resolvedSymbols(
        checker,
        serviceYields.map((serviceYield) => serviceYield.reference),
      );
      const firstYields = new Map<number, Node>();
      for (const [symbol, serviceYield] of Arrays.zip(symbols, serviceYields)) {
        if (symbol === undefined) {
          continue;
        }
        const firstYield = firstYields.get(symbol.id);
        if (firstYield === undefined) {
          firstYields.set(symbol.id, serviceYield.yieldExpression);
          continue;
        }
        const isServiceTag = serviceTags.get(symbol.id) ?? (yield* serviceTag(checker, symbol));
        serviceTags.set(symbol.id, isServiceTag);
        if (!isServiceTag) {
          continue;
        }
        const repeated = nodePosition(sourceFile, serviceYield.yieldExpression);
        const first = nodePosition(sourceFile, firstYield);
        violations.push(
          new RepeatedServiceYield({
            location: `${displayName}:${repeated.line}:${repeated.column}`,
            service: symbol.name,
            firstYield: `${first.line}:${first.column}`,
          }),
        );
      }
    }
    return violations;
  });

export const findRepeatedServiceYields = <OpeningError, OpeningRequirement>(
  _projectFile: string,
  openedProjects: Effect.Effect<
    Effect.Success<ReturnType<typeof openTypeScriptProjects>>,
    OpeningError,
    OpeningRequirement
  >,
) =>
  Effect.gen(function* () {
    const serviceTags = new Map<number, boolean>();
    const violations: RepeatedServiceYield[] = [];
    for (const { checker, sourceFiles } of yield* openedProjects) {
      for (const { sourceFile, displayName } of sourceFiles) {
        violations.push(...(yield* fileViolations(checker, sourceFile, displayName, serviceTags)));
      }
    }
    if (violations.length > 0) {
      return yield* new RepeatedServiceYields({ violations });
    }
  }).pipe(Effect.scoped);
