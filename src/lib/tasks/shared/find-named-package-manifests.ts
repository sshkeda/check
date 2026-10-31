import { flow, Option, Result, Schema } from "effect";
import type { ResolveResult } from "oxc-resolver";

import { directoryHolding, isWithin } from "../../../shared/match-file-names-and-path-prefixes.ts";

export const PACKAGE_MANIFEST_FILE = "package.json";
const LINE_BREAKS = /\s*\n\s*/gu;
const RELATIVE_REQUEST = /^\.\.?(?:\/|$)/u;
const SKIPPED_SEGMENTS: ReadonlySet<string> = new Set(["", "."]);
const PARENT_SEGMENT = "..";
const ERRORS_OF_A_REQUEST_FOR_NO_FILE = [
  /^Cannot find module '/u,
  /^"[\s\S]*" is not exported under /u,
  /^Package import specifier "[\s\S]*" is not defined in package /u,
];

const PACKAGE_MANIFEST = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.optionalKey(Schema.String),
    exports: Schema.optionalKey(Schema.Json),
  }),
);

const ERRNO_FAILURE = Schema.Struct({ code: Schema.String });
const CODES_OF_A_PATH_TO_NO_FILE: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);
const SYMLINK_LOOP_CODE = "ELOOP";

export const enclosingPackageManifestsOf = (directory: string, projectDirectory: string) => {
  const segments = directory.split("/");
  const highestSegments = isWithin(directory, projectDirectory)
    ? projectDirectory.split("/").length
    : 1;
  return Array.from(
    { length: segments.length - highestSegments + 1 },
    (_entry, above) =>
      `${segments.slice(0, segments.length - above).join("/")}/${PACKAGE_MANIFEST_FILE}`,
  );
};

export const namedPackageManifestIn = (bytes: Uint8Array) =>
  Schema.decodeResult(PACKAGE_MANIFEST)(new TextDecoder().decode(bytes)).pipe(
    Result.map(({ name, exports }) =>
      name === undefined ? Option.none() : Option.some({ name, hasExports: exports !== undefined }),
    ),
    Result.mapError((issue) => issue.message.replaceAll(LINE_BREAKS, " ")),
  );

export const unreadableManifestReason = flow(
  Schema.decodeUnknownOption(ERRNO_FAILURE),
  Option.match({
    onNone: () => "reading it failed",
    onSome: ({ code }) => `reading it failed with ${code}`,
  }),
);

export const namesNoManifest = flow(
  Schema.decodeUnknownOption(ERRNO_FAILURE),
  Option.exists(({ code }) => CODES_OF_A_PATH_TO_NO_FILE.has(code)),
);

export const namesASymlinkLoop = flow(
  Schema.decodeUnknownOption(ERRNO_FAILURE),
  Option.exists(({ code }) => code === SYMLINK_LOOP_CODE),
);

const withoutDotSegments = (file: string) => {
  const [root = "", ...segments] = file.split("/");
  const kept: string[] = [];
  for (const segment of segments) {
    if (segment === PARENT_SEGMENT) {
      kept.pop();
    } else if (!SKIPPED_SEGMENTS.has(segment)) {
      kept.push(segment);
    }
  }
  return [root, ...kept].join("/");
};

export const directoriesAFailedResolutionReads = ({
  importingFile,
  request,
}: {
  readonly importingFile: string;
  readonly request: string;
}) => {
  const importingDirectory = directoryHolding(importingFile);
  return RELATIVE_REQUEST.test(request)
    ? [importingDirectory, directoryHolding(withoutDotSegments(`${importingDirectory}/${request}`))]
    : [importingDirectory];
};

export const resolutionNamesNoFile = (resolved: ResolveResult, reason: string) =>
  resolved.builtin !== undefined ||
  ERRORS_OF_A_REQUEST_FOR_NO_FILE.some((error) => error.test(reason));
