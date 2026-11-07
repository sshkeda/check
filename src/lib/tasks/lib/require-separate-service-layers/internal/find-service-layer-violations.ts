import { Effect } from "effect";
import type { Layer } from "effect";
import { SyntaxKind } from "typescript/unstable/ast";
import type { Node, SourceFile } from "typescript/unstable/ast";
import {
  isBinaryExpression,
  isClassDeclaration,
  isClassExpression,
  isElementAccessExpression,
  isGetAccessorDeclaration,
  isMethodDeclaration,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isStaticKeyword,
} from "typescript/unstable/ast/is";
import { SignatureKind } from "typescript/unstable/async";
import type { Checker, Type } from "typescript/unstable/async";

import {
  CONCURRENT_TYPESCRIPT_REQUESTS,
  nodePosition,
  requiredTypeScriptRequest,
  resolvedSymbols,
  typeMembers,
  typeScriptRequest,
} from "../../../shared/query-the-typescript-project.ts";
import type { openTypeScriptProjects } from "../../../shared/query-the-typescript-project.ts";
import { ServiceLayerNotSeparate, ServiceLayersRefused } from "./service-layer-errors.ts";

const LAYER_TYPE_ID = "~effect/Layer" satisfies keyof Layer.Any;
const SERVICE_TYPE_ID = "~effect/Context/Service";
const LAYER_ASSIGNMENTS = new Set([
  SyntaxKind.EqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.AmpersandAmpersandEqualsToken,
]);

const hasTypeProperty = (checker: Checker, type: Type, name: string) =>
  typeScriptRequest("read a service layer property", () =>
    checker.getPropertyOfType(type, name),
  ).pipe(Effect.map((property) => property !== undefined));

const isLayerType = (checker: Checker, type: Type) =>
  typeMembers(type).pipe(
    Effect.flatMap((members) =>
      Effect.forEach(members, (member) => hasTypeProperty(checker, member, LAYER_TYPE_ID)),
    ),
    Effect.map((layers) => layers.some(Boolean)),
  );

const isLayerOrFactory = (checker: Checker, type: Type) =>
  Effect.gen(function* () {
    const members = yield* typeMembers(type);
    const matches = yield* Effect.forEach(members, (member) =>
      Effect.gen(function* () {
        if (yield* isLayerType(checker, member)) {
          return true;
        }
        const signatures = yield* typeScriptRequest("read layer factory signatures", () =>
          checker.getSignaturesOfType(member, SignatureKind.Call),
        );
        const returnsLayer = yield* Effect.forEach(signatures, (signature) =>
          requiredTypeScriptRequest("read a layer factory return type", () =>
            checker.getReturnTypeOfSignature(signature),
          ).pipe(Effect.flatMap((returned) => isLayerType(checker, returned))),
        );
        return returnsLayer.some(Boolean);
      }),
    );
    return matches.some(Boolean);
  });

const candidatesIn = (sourceFile: SourceFile) => {
  const candidates: {
    readonly node: Node;
    readonly value: Node;
    readonly owner: Node;
  }[] = [];
  const visit = (node: Node) => {
    const isClassMember =
      (isPropertyDeclaration(node) ||
        isMethodDeclaration(node) ||
        isGetAccessorDeclaration(node)) &&
      node.modifiers?.some(isStaticKeyword) === true;
    const parent = node.parent;
    const isServiceMemberCandidate =
      isClassMember &&
      (isClassDeclaration(parent) || isClassExpression(parent)) &&
      parent.name !== undefined;
    if (isServiceMemberCandidate) {
      candidates.push({ node, value: node.name, owner: parent.name });
    }
    const isAssignment = isBinaryExpression(node) && LAYER_ASSIGNMENTS.has(node.operatorToken.kind);
    const isPropertyAssignment =
      isAssignment &&
      (isPropertyAccessExpression(node.left) || isElementAccessExpression(node.left));
    if (isPropertyAssignment) {
      candidates.push({ node, value: node.right, owner: node.left.expression });
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return candidates;
};

const fileViolations = (checker: Checker, sourceFile: SourceFile, displayName: string) =>
  Effect.gen(function* () {
    const violations = yield* Effect.forEach(
      candidatesIn(sourceFile),
      (candidate) =>
        Effect.gen(function* () {
          const [symbol] = yield* resolvedSymbols(checker, [candidate.owner]);
          if (symbol === undefined) {
            return [];
          }
          const ownerType = yield* typeScriptRequest("read a possible service class", () =>
            checker.getTypeOfSymbol(symbol),
          );
          if (ownerType === undefined) {
            return [];
          }
          if (!(yield* hasTypeProperty(checker, ownerType, SERVICE_TYPE_ID))) {
            return [];
          }
          const type = yield* typeScriptRequest("read a possible service layer", () =>
            checker.getTypeAtLocation(candidate.value),
          );
          if (type === undefined) {
            return [];
          }
          if (!(yield* isLayerOrFactory(checker, type))) {
            return [];
          }
          const { line, column } = nodePosition(sourceFile, candidate.node);
          return [
            new ServiceLayerNotSeparate({
              location: `${displayName}:${line}:${column}`,
              service: symbol.name,
            }),
          ];
        }),
      { concurrency: CONCURRENT_TYPESCRIPT_REQUESTS },
    );
    return violations.flat();
  });

export const findServiceLayerViolations = <OpeningError, OpeningRequirement>(
  _projectFile: string,
  openedProjects: Effect.Effect<
    Effect.Success<ReturnType<typeof openTypeScriptProjects>>,
    OpeningError,
    OpeningRequirement
  >,
) =>
  Effect.gen(function* () {
    const violations: ServiceLayerNotSeparate[] = [];
    for (const { checker, sourceFiles } of yield* openedProjects) {
      for (const { sourceFile, displayName } of sourceFiles) {
        violations.push(...(yield* fileViolations(checker, sourceFile, displayName)));
      }
    }
    if (violations.length > 0) {
      return yield* new ServiceLayersRefused({ violations });
    }
  });
