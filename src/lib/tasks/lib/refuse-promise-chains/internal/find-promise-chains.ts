import { Effect } from "effect";
import type { Node, SourceFile } from "typescript/unstable/ast";
import {
  isElementAccessExpression,
  isPropertyAccessExpression,
  isStringLiteralLikeNode,
} from "typescript/unstable/ast/is";
import { isErrorType, SignatureKind, TypeFlags } from "typescript/unstable/async";
import type { Checker, Type } from "typescript/unstable/async";

import {
  callsIn,
  CONCURRENT_TYPESCRIPT_REQUESTS,
  nodePosition,
  typeMembers,
  typeScriptRequest,
} from "../../../shared/query-the-typescript-project.ts";
import type { openTypeScriptProjects } from "../../../shared/query-the-typescript-project.ts";
import { withoutWrappers } from "../../../shared/read-piped-steps-through-wrappers.ts";
import { PromiseChained, PromiseChainsRefused } from "./promise-chain-errors.ts";

const THEN = "then";
const CHAINING_METHODS: ReadonlySet<string> = new Set([THEN, "catch", "finally"]);

const memberCalledBy = (callee: Node) => {
  if (isPropertyAccessExpression(callee)) {
    return { receiver: callee.expression, key: callee.name, method: callee.name.text };
  }
  if (!isElementAccessExpression(callee)) {
    return;
  }
  const key = callee.argumentExpression;
  return {
    receiver: callee.expression,
    key,
    method: isStringLiteralLikeNode(key) ? key.text : undefined,
  };
};

const chainingMethodOf = (keyType: Type | undefined) =>
  Effect.gen(function* () {
    const members = keyType === undefined ? [] : yield* typeMembers(keyType);
    const methods = members.flatMap((member) => {
      const isChainingMethodName =
        member.isStringLiteralType() && CHAINING_METHODS.has(member.value);
      return isChainingMethodName ? [member.value] : [];
    });
    return methods[0];
  });

const withComputedMethods = (checker: Checker, members: ReturnType<typeof chainedCallsIn>) =>
  Effect.gen(function* () {
    const named = members.flatMap(({ receiver, key, method }) =>
      method === undefined ? [] : [{ receiver, key, method }],
    );
    const computed = members.filter(({ method }) => method === undefined);
    if (computed.length === 0) {
      return named;
    }
    const keyTypes = yield* typeScriptRequest("read the types of computed member keys", () =>
      checker.getTypeAtLocation(computed.map(({ key }) => key)),
    );
    const distinctKeyTypes = [
      ...new Map(
        keyTypes.flatMap((keyType) =>
          keyType === undefined ? [] : [[keyType.id, keyType] as const],
        ),
      ).values(),
    ];
    const distinctMethods = yield* Effect.forEach(distinctKeyTypes, (keyType) =>
      chainingMethodOf(keyType),
    );
    const methodOfKeyType = new Map(
      distinctKeyTypes.map((keyType, index) => [keyType.id, distinctMethods[index]] as const),
    );
    return [
      ...named,
      ...computed.flatMap(({ receiver, key }, index) => {
        const keyType = keyTypes[index];
        const method = keyType === undefined ? undefined : methodOfKeyType.get(keyType.id);
        return method === undefined ? [] : [{ receiver, key, method }];
      }),
    ];
  });

const hasCallableThen = (checker: Checker, member: Type) =>
  Effect.gen(function* () {
    const thenProperty = yield* typeScriptRequest("read a then property", () =>
      checker.getPropertyOfType(member, THEN),
    );
    if (thenProperty === undefined) {
      return false;
    }
    const thenType = yield* typeScriptRequest("read the type of a then property", () =>
      checker.getTypeOfSymbol(thenProperty),
    );
    const thenTypes = thenType === undefined ? [] : yield* typeMembers(thenType);
    const signatures = yield* Effect.forEach(thenTypes, (thenMember) =>
      typeScriptRequest("read the signatures of a then property", () =>
        checker.getSignaturesOfType(thenMember, SignatureKind.Call),
      ),
    );
    return signatures.some((memberSignatures) => memberSignatures.length > 0);
  });

const isThenable = (checker: Checker, receiver: Type) =>
  Effect.gen(function* () {
    const isUnknown = (receiver.flags & TypeFlags.AnyOrUnknown) !== 0 || isErrorType(receiver);
    if (isUnknown) {
      return false;
    }
    const apparent = yield* typeScriptRequest("read the apparent type of a receiver", () =>
      checker.getApparentType(receiver),
    );
    const members = apparent === undefined ? [] : yield* typeMembers(apparent);
    const thenables = yield* Effect.forEach(members, (member) => hasCallableThen(checker, member));
    return thenables.some(Boolean);
  });

const chainedCallsIn = (sourceFile: SourceFile) =>
  callsIn(sourceFile).flatMap((call) => {
    const member = memberCalledBy(withoutWrappers(call.expression));
    const mayChain =
      member !== undefined && (member.method === undefined || CHAINING_METHODS.has(member.method));
    return mayChain ? [member] : [];
  });

const projectViolations = (
  checker: Checker,
  sourceFiles: readonly { readonly sourceFile: SourceFile; readonly displayName: string }[],
) =>
  Effect.gen(function* () {
    const candidates = sourceFiles.flatMap(({ sourceFile, displayName }) => {
      const chained = chainedCallsIn(sourceFile);
      return chained.length === 0 ? [] : [{ sourceFile, displayName, chained }];
    });
    const files = yield* Effect.forEach(
      candidates,
      ({ sourceFile, displayName, chained: members }) =>
        Effect.gen(function* () {
          const chained = yield* withComputedMethods(checker, members);
          const types =
            chained.length === 0
              ? []
              : yield* typeScriptRequest("read the types of chained receivers", () =>
                  checker.getTypeAtLocation(chained.map(({ receiver }) => receiver)),
                );
          return { sourceFile, displayName, chained, types };
        }),
      { concurrency: CONCURRENT_TYPESCRIPT_REQUESTS },
    );
    const distinctTypes = [
      ...new Map(
        files.flatMap(({ types }) =>
          types.flatMap((type) => (type === undefined ? [] : [[type.id, type] as const])),
        ),
      ).values(),
    ];
    const thenables = yield* Effect.forEach(distinctTypes, (type) => isThenable(checker, type), {
      concurrency: CONCURRENT_TYPESCRIPT_REQUESTS,
    });
    const thenableTypeIds = new Set(
      distinctTypes.flatMap((type, index) => (thenables[index] === true ? [type.id] : [])),
    );
    return files.flatMap(({ sourceFile, displayName, chained, types }) =>
      chained
        .filter((_member, index) => {
          const type = types[index];
          return type !== undefined && thenableTypeIds.has(type.id);
        })
        .toSorted((left, right) => left.key.pos - right.key.pos)
        .map(({ key, method }) => {
          const { line, column } = nodePosition(sourceFile, key);
          return new PromiseChained({
            location: `${displayName}:${line}:${column}`,
            method,
          });
        }),
    );
  });

export const findPromiseChains = <OpeningError, OpeningRequirement>(
  _projectFile: string,
  openedProjects: Effect.Effect<
    Effect.Success<ReturnType<typeof openTypeScriptProjects>>,
    OpeningError,
    OpeningRequirement
  >,
) =>
  Effect.gen(function* () {
    const violationsOfEachProject = yield* Effect.forEach(
      yield* openedProjects,
      ({ checker, sourceFiles }) => projectViolations(checker, sourceFiles),
    );
    const violations = violationsOfEachProject.flat();
    if (violations.length > 0) {
      return yield* new PromiseChainsRefused({ violations });
    }
  });
