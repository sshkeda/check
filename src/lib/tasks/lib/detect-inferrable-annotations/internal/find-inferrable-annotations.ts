import { Effect } from "effect";
import { SyntaxKind, NodeFlags } from "typescript/unstable/ast";
import type {
  ArrowFunction,
  Expression,
  FunctionExpression,
  Node,
  SourceFile,
  TypeNode,
  VariableDeclaration,
} from "typescript/unstable/ast";
import {
  isArrayLiteralExpression,
  isArrowFunction,
  isCallExpression,
  isFunctionExpression,
  isIdentifier,
  isKeywordTypeNode,
  isLiteralExpression,
  isNewExpression,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isPrefixUnaryExpression,
  isPropertyAccessExpression,
  isTemplateExpression,
  isTypePredicateNode,
  isTypeReferenceNode,
  isVariableDeclaration,
  isVariableDeclarationList,
  isVoidExpression,
} from "typescript/unstable/ast/is";
import { NodeBuilderFlags } from "typescript/unstable/async";
import type { Checker, Diagnostic, Program, Type } from "typescript/unstable/async";

import {
  nodePosition,
  requiredTypeScriptRequest,
  openTypeScriptProjects,
  typeScriptRequest,
} from "../../../shared/query-the-typescript-project.ts";
import {
  InferrableTypeAnnotation,
  InferrableTypeAnnotations,
  SourceOverlayNotApplied,
} from "./inferrable-annotation-errors.ts";

const PRIMITIVE_CONVERSIONS = new Set(["Boolean", "Number", "String", "BigInt", "Symbol"]);

const PRIMITIVE_VALUE_NAMES = new Set(["undefined", "Infinity", "NaN"]);

const PRIMITIVE_LITERAL_KINDS = new Set([
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NullKeyword,
]);

const callbackOf = (node: Node) => {
  const isFunction = isArrowFunction(node) || isFunctionExpression(node);
  if (!isFunction) {
    return;
  }
  const call = node.parent;
  const isPassedToACall =
    (isCallExpression(call) || isNewExpression(call)) &&
    (call.arguments ?? []).some((argument) => argument === node);
  return isPassedToACall ? node : undefined;
};

const calleeName = (callback: ArrowFunction | FunctionExpression) => {
  const call = callback.parent;
  const isCallOrConstruction = isCallExpression(call) || isNewExpression(call);
  const callee = isCallOrConstruction ? call.expression : call;
  if (isIdentifier(callee)) {
    return callee.text;
  }
  return isPropertyAccessExpression(callee) ? callee.name.text : "a call";
};

const isPrimitiveAnnotation = (annotation: TypeNode) =>
  isKeywordTypeNode(annotation) ||
  annotation.kind === SyntaxKind.LiteralType ||
  (isTypeReferenceNode(annotation) &&
    isIdentifier(annotation.typeName) &&
    annotation.typeName.text === "RegExp");

const isPrimitiveInitializer = (initializer: Expression) =>
  isLiteralExpression(initializer) ||
  isNoSubstitutionTemplateLiteral(initializer) ||
  isTemplateExpression(initializer) ||
  isPrefixUnaryExpression(initializer) ||
  isVoidExpression(initializer) ||
  PRIMITIVE_LITERAL_KINDS.has(initializer.kind) ||
  (isIdentifier(initializer) && PRIMITIVE_VALUE_NAMES.has(initializer.text)) ||
  (isCallExpression(initializer) &&
    isIdentifier(initializer.expression) &&
    PRIMITIVE_CONVERSIONS.has(initializer.expression.text));

const isFilledLiteral = (initializer: Expression) =>
  (isObjectLiteralExpression(initializer) && initializer.properties.length > 0) ||
  (isArrayLiteralExpression(initializer) && initializer.elements.length > 0);

const constantAnnotationOf = (node: Node) => {
  if (!isVariableDeclaration(node)) {
    return;
  }
  const { type, initializer, name, parent } = node;
  const isAnnotatedIdentifierWithInitializer =
    type !== undefined && initializer !== undefined && isIdentifier(name);
  if (!isAnnotatedIdentifierWithInitializer) {
    return;
  }
  const isInferrable =
    isVariableDeclarationList(parent) &&
    (parent.flags & NodeFlags.BlockScoped) === NodeFlags.Const &&
    (parent.flags & NodeFlags.Ambient) === 0 &&
    !isFilledLiteral(initializer) &&
    !(isPrimitiveAnnotation(type) && isPrimitiveInitializer(initializer));
  return isInferrable
    ? {
        annotation: type,
        fact: `${name.text} has a type annotation TypeScript can infer`,
        edit: { start: name.end, end: type.end, replacement: "" },
      }
    : undefined;
};

const callbackAnnotationOf = (node: Node) => {
  const callback = callbackOf(node);
  const annotation = callback?.type;
  const isInferrable =
    callback !== undefined && annotation !== undefined && !isTypePredicateNode(annotation);
  return isInferrable
    ? {
        annotation,
        fact: `the callback passed to ${calleeName(callback)} has a return type annotation TypeScript can infer`,
        edit: { start: callback.parameters.end, end: annotation.end, replacement: ")" },
      }
    : undefined;
};

const annotationOf = (node: Node) => constantAnnotationOf(node) ?? callbackAnnotationOf(node);

const annotatableNodesByStart = (sourceFile: SourceFile) => {
  const found = new Map<number, ArrowFunction | FunctionExpression | VariableDeclaration>();
  const visit = (node: Node): void => {
    const annotatable = isVariableDeclaration(node) ? node : callbackOf(node);
    if (annotatable !== undefined) {
      found.set(node.getStart(sourceFile), annotatable);
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return found;
};

const FULL_TYPE_TEXT = NodeBuilderFlags.NoTruncation | NodeBuilderFlags.UseFullyQualifiedType;

const typeText = (checker: Checker, type: Type) =>
  typeScriptRequest("print a type", () => checker.typeToString(type, undefined, FULL_TYPE_TEXT));

const candidatesIn = (
  checker: Checker,
  {
    sourceFile,
    displayName,
  }: Effect.Success<ReturnType<typeof openTypeScriptProjects>>[number]["sourceFiles"][number],
) =>
  Effect.forEach(annotatableNodesByStart(sourceFile), ([start, node]) =>
    Effect.gen(function* () {
      const annotated = annotationOf(node);
      if (annotated === undefined) {
        return [];
      }
      const annotatedType = yield* requiredTypeScriptRequest("read an annotated type", () =>
        checker.getTypeFromTypeNode(annotated.annotation),
      );
      return [
        {
          ...annotated,
          sourceFile,
          displayName,
          start,
          annotatedTypeText: yield* typeText(checker, annotatedType),
        },
      ];
    }),
  ).pipe(Effect.map((candidates) => candidates.flat()));

const shiftBefore = (
  candidates: readonly Effect.Success<ReturnType<typeof candidatesIn>>[number][],
  position: number,
) =>
  candidates
    .filter((candidate) => candidate.edit.end <= position)
    .reduce((total, { edit }) => total + edit.end - edit.start - edit.replacement.length, 0);

const textWithoutAnnotations = (
  text: string,
  candidates: readonly Effect.Success<ReturnType<typeof candidatesIn>>[number][],
) =>
  candidates
    .toSorted((first, second) => second.edit.start - first.edit.start)
    .reduce(
      (remaining, { edit }) =>
        remaining.slice(0, edit.start) + edit.replacement + remaining.slice(edit.end),
      text,
    );

const typeScriptViolationsOf = (program: Program, fileName: string) =>
  Effect.gen(function* () {
    const semantic = yield* typeScriptRequest("read semantic diagnostics", () =>
      program.getSemanticDiagnostics(fileName),
    );
    const declaration = yield* typeScriptRequest("read declaration diagnostics", () =>
      program.getDeclarationDiagnostics(fileName),
    );
    return [...semantic, ...declaration];
  });

const violationKey = (fileName: string, violation: Diagnostic) =>
  [fileName, violation.code, violation.text].join("\n");

const inferredType = (
  checker: Checker,
  node: ArrowFunction | FunctionExpression | VariableDeclaration,
) =>
  Effect.gen(function* () {
    if (isVariableDeclaration(node)) {
      return yield* requiredTypeScriptRequest("read an inferred type", () =>
        checker.getTypeAtLocation(node.name),
      );
    }
    const signature = yield* requiredTypeScriptRequest("read a callback signature", () =>
      checker.getSignatureFromDeclaration(node),
    );
    return yield* requiredTypeScriptRequest("read an inferred return type", () =>
      checker.getReturnTypeOfSignature(signature),
    );
  });

const projectsWithoutAnnotations = (
  projectFile: string,
  candidates: readonly Effect.Success<ReturnType<typeof candidatesIn>>[number][],
) =>
  Effect.gen(function* () {
    const candidatesOfSourceFile = Map.groupBy(candidates, (candidate) => candidate.sourceFile);
    const candidatesOfFile = new Map(
      Array.from(candidatesOfSourceFile, ([sourceFile, fileCandidates]) => [
        sourceFile.fileName,
        fileCandidates,
      ]),
    );
    const sourceTextOverrides = new Map(
      Array.from(candidatesOfSourceFile, ([sourceFile, fileCandidates]) => [
        sourceFile.fileName,
        textWithoutAnnotations(sourceFile.text, fileCandidates),
      ]),
    );
    const projects = yield* openTypeScriptProjects(projectFile, sourceTextOverrides);
    for (const { sourceFiles } of projects) {
      for (const { sourceFile } of sourceFiles) {
        const override = sourceTextOverrides.get(sourceFile.fileName);
        const isOverrideMissingFromProgram = override !== undefined && override !== sourceFile.text;
        if (isOverrideMissingFromProgram) {
          return yield* new SourceOverlayNotApplied({ fileName: sourceFile.fileName });
        }
      }
    }
    return { projects, candidatesOfFile };
  });

const annotationsStillNeeded = <CountingError>(
  projectFile: string,
  candidates: readonly Effect.Success<ReturnType<typeof candidatesIn>>[number][],
  countBaselineViolations: Effect.Effect<ReadonlyMap<string, number>, CountingError>,
) =>
  Effect.gen(function* () {
    const typeChanging = new Set<(typeof candidates)[number]>();
    const stripped = yield* projectsWithoutAnnotations(projectFile, candidates);
    for (const { checker, sourceFiles } of stripped.projects) {
      for (const { sourceFile } of sourceFiles) {
        const fileCandidates = stripped.candidatesOfFile.get(sourceFile.fileName) ?? [];
        const annotatable = annotatableNodesByStart(sourceFile);
        for (const candidate of fileCandidates) {
          const node = annotatable.get(
            candidate.start - shiftBefore(fileCandidates, candidate.start),
          );
          const isMissingOrStillAnnotated = node === undefined || node.type !== undefined;
          if (isMissingOrStillAnnotated) {
            return yield* new SourceOverlayNotApplied({ fileName: sourceFile.fileName });
          }
          const strippingChangedType =
            (yield* typeText(checker, yield* inferredType(checker, node))) !==
            candidate.annotatedTypeText;
          if (strippingChangedType) {
            typeChanging.add(candidate);
          }
        }
      }
    }
    const removable = candidates.filter((candidate) => !typeChanging.has(candidate));
    if (removable.length === 0) {
      return typeChanging;
    }
    const strippedOfRemovable =
      typeChanging.size === 0
        ? stripped
        : yield* projectsWithoutAnnotations(projectFile, removable);
    const needed = new Set(typeChanging);
    const remainingBaseline = new Map(yield* countBaselineViolations);
    for (const { program, sourceFiles } of strippedOfRemovable.projects) {
      for (const { sourceFile } of sourceFiles) {
        const fileCandidates = strippedOfRemovable.candidatesOfFile.get(sourceFile.fileName) ?? [];
        const newViolations = (yield* typeScriptViolationsOf(program, sourceFile.fileName)).filter(
          (violation) => {
            const key = violationKey(sourceFile.fileName, violation);
            const baselineCount = remainingBaseline.get(key) ?? 0;
            remainingBaseline.set(key, baselineCount - 1);
            return baselineCount <= 0;
          },
        );
        if (newViolations.length > 0) {
          for (const candidate of fileCandidates.length > 0 ? fileCandidates : removable) {
            needed.add(candidate);
          }
        }
      }
    }
    return needed;
  }).pipe(Effect.scoped);

export const findInferrableAnnotations = <OpeningError, OpeningRequirement>(
  projectFile: string,
  openedProjects: Effect.Effect<
    Effect.Success<ReturnType<typeof openTypeScriptProjects>>,
    OpeningError,
    OpeningRequirement
  >,
) =>
  Effect.gen(function* () {
    const projects = yield* openedProjects;
    const annotated: Effect.Success<ReturnType<typeof candidatesIn>>[number][] = [];
    for (const { checker, sourceFiles } of projects) {
      for (const projectSourceFile of sourceFiles) {
        annotated.push(...(yield* candidatesIn(checker, projectSourceFile)));
      }
    }
    if (annotated.length === 0) {
      return;
    }
    const countBaselineViolations = Effect.gen(function* () {
      const counts = new Map<string, number>();
      for (const { program, sourceFiles } of projects) {
        for (const { sourceFile } of sourceFiles) {
          for (const violation of yield* typeScriptViolationsOf(program, sourceFile.fileName)) {
            const key = violationKey(sourceFile.fileName, violation);
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        }
      }
      return counts;
    });
    const needed = yield* annotationsStillNeeded(projectFile, annotated, countBaselineViolations);
    const violations = annotated
      .filter((candidate) => !needed.has(candidate))
      .map((candidate) => {
        const location = nodePosition(candidate.sourceFile, candidate.annotation);
        return new InferrableTypeAnnotation({
          location: `${candidate.displayName}:${location.line}:${location.column}`,
          fact: candidate.fact,
        });
      });
    if (violations.length > 0) {
      return yield* new InferrableTypeAnnotations({ violations });
    }
  }).pipe(Effect.scoped);
