import { Array as Arrays, Effect, FileSystem, Hash, Path, Predicate } from "effect";
import type { Node } from "oxc-parser";

import { inEachPackage } from "../../../shared/check-each-nested-package.ts";
import { isScript } from "../../../shared/classify-files-by-role.ts";
import { lineNumbersIn } from "../../../shared/count-the-line-of-an-offset.ts";
import { ownedFilesAmong } from "../../../shared/list-owned-files.ts";
import { existingPackageFiles } from "../../../shared/list-package-files.ts";
import { quietViolations } from "../../../shared/print-failures-and-keep-detail-in-the-trace.ts";
import { DuplicateFunction, DuplicateFunctions } from "./duplicate-function-errors.ts";
import { namedFunctionsIn } from "./list-named-functions.ts";

const DUPLICATE_FUNCTIONS = "duplicate-functions";
const CONCURRENT_FILE_READS = 32;
const FIELDS_OUTSIDE_THE_CODE: ReadonlySet<string> = new Set([
  "start",
  "end",
  "range",
  "loc",
  "parent",
]);

const codeOf = (values: readonly unknown[]): string =>
  values
    .map((value) => {
      if (Arrays.isArray(value)) {
        return `[${codeOf(value)}]`;
      }
      if (Predicate.isObject(value)) {
        const fields = Object.entries(value).filter(
          ([field]) => !FIELDS_OUTSIDE_THE_CODE.has(field),
        );
        const names = fields.map(([field]) => field).join(",");
        return `{${names}:${codeOf(fields.map(([, fieldValue]) => fieldValue))}}`;
      }
      const text = String(value);
      return `${typeof value}${text.length}:${text}`;
    })
    .join(",");

const hashOfTheCode = (values: readonly unknown[]): number =>
  Hash.array(
    values.map((value) => {
      if (Arrays.isArray(value)) {
        return hashOfTheCode(value);
      }
      if (Predicate.isObject(value)) {
        return hashOfTheCode(
          Object.entries(value)
            .filter(([field]) => !FIELDS_OUTSIDE_THE_CODE.has(field))
            .flat(),
        );
      }
      return Hash.string(String(value));
    }),
  );

const isInside = (inner: { start: number; end: number }, outer: { start: number; end: number }) =>
  inner !== outer && outer.start <= inner.start && inner.end <= outer.end;

export const duplicateFunctionViolations = (
  sources: readonly { readonly path: string; readonly text: string }[],
  shownPathOf = (path: string) => path,
) => {
  const candidatesIn = (
    chosen: typeof sources,
    isCandidate: (path: string, start: number) => boolean,
    keyOf: (code: Node) => number | string,
  ) =>
    chosen.flatMap(({ path, text }) => {
      const lineAt = lineNumbersIn(text);
      return namedFunctionsIn(path, text)
        .filter(({ start }) => isCandidate(path, start))
        .map(({ name, start, end, code }) => ({
          name,
          path,
          start,
          end,
          line: lineAt(start),
          key: keyOf(code),
        }));
    });
  const groupsOfCopies = (candidates: ReturnType<typeof candidatesIn>) =>
    [...Map.groupBy(candidates, ({ key }) => key).values()].filter((group) => group.length > 1);
  const likelyCopies = groupsOfCopies(
    candidatesIn(
      sources,
      () => true,
      (code) => hashOfTheCode([code]),
    ),
  ).flat();
  const likelyCopyStarts = new Set(likelyCopies.map(({ path, start }) => `${path}:${start}`));
  const likelyCopyPaths = new Set(likelyCopies.map(({ path }) => path));
  const copyGroups = groupsOfCopies(
    candidatesIn(
      sources.filter(({ path }) => likelyCopyPaths.has(path)),
      (path, start) => likelyCopyStarts.has(`${path}:${start}`),
      (code) => codeOf([code]),
    ),
  );
  const copiesByPath = Map.groupBy(copyGroups.flat(), ({ path }) => path);
  const isInsideAnotherCopy = (member: (typeof copyGroups)[number][number]) =>
    copiesByPath.get(member.path)?.some((outer) => isInside(member, outer)) === true;
  return copyGroups
    .filter((group) => !group.every((member) => isInsideAnotherCopy(member)))
    .flatMap(([first, ...others]) =>
      first === undefined
        ? []
        : [
            new DuplicateFunction({
              location: `${first.path}:${first.line}`,
              functionName: first.name,
              copies: others.map(({ path, line }) => `${shownPathOf(path)}:${line}`),
            }),
          ],
    );
};

export const findDuplicateFunctions = (directory: string, shownDirectory = ".") =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const scripts = (yield* ownedFilesAmong(
      directory,
      yield* existingPackageFiles(directory, []),
    )).filter((file) => isScript(file));
    const sources = yield* Effect.forEach(
      scripts,
      (file) =>
        fileSystem
          .readFileString(path.join(directory, file))
          .pipe(Effect.map((text) => ({ path: file, text }))),
      { concurrency: CONCURRENT_FILE_READS },
    );
    const violations = duplicateFunctionViolations(sources, (file) =>
      path.join(shownDirectory, file),
    );
    if (violations.length > 0) {
      return yield* new DuplicateFunctions({ violations });
    }
  });

export const duplicateFunctionsOfEachPackage = inEachPackage(
  DUPLICATE_FUNCTIONS,
  (packageDirectory, packageDirectoryFromTheProject) =>
    findDuplicateFunctions(packageDirectory, packageDirectoryFromTheProject).pipe(
      quietViolations(DUPLICATE_FUNCTIONS),
    ),
);
