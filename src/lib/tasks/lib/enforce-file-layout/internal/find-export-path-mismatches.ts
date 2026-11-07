import { Schema } from "effect";

import { isTypeScriptSourceFile } from "../../../shared/classify-files-by-role.ts";
import { JSON_OBJECT } from "../../../shared/read-package-manifest-object.ts";
import {
  ExportPathMismatch,
  moduleDirectoryNamedBy,
  PackageEntryNotTypeScript,
} from "./file-layout-errors.ts";

const ROOT_SUBPATH = ".";
const RELATIVE_PREFIX = "./";
const QUERY_OR_FRAGMENT = /[?#].*$/u;
const NOT_A_DIRECTORY_NAME: ReadonlySet<string> = new Set(["", ".", ".."]);
const CODE_FILE = /\.[cm]?[jt]sx?$/u;
const FILE_EXTENSION = /\.[^./]+$/u;
const INDEX_FILE = /^index\.tsx?$/u;
const PACKAGE_PATTERN_WILDCARD = "*";
const ENTRY_FIELDS = ["main", "module", "types", "typings"] as const;
const PROPERTY_NAME = /^[A-Za-z_$][\w$]*$/u;
const isJsonObject = Schema.is(JSON_OBJECT);
const isJsonArray = Schema.is(Schema.Array(Schema.Json));

const fieldWithKey = (field: string, key: string) =>
  PROPERTY_NAME.test(key) ? `${field}.${key}` : `${field}["${key}"]`;

const targetsUnderEveryCondition = (
  field: string,
  value: Schema.Json,
): { field: string; target: string }[] => {
  if (typeof value === "string") {
    return [{ field, target: value }];
  }
  if (isJsonArray(value)) {
    return value.flatMap((item, index) => targetsUnderEveryCondition(`${field}[${index}]`, item));
  }
  if (!isJsonObject(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([condition, nested]) =>
    targetsUnderEveryCondition(fieldWithKey(field, condition), nested),
  );
};

const subpathsWithTheirFields = (exports: Schema.Json) => {
  const isSubpathMap =
    isJsonObject(exports) && Object.keys(exports).some((key) => key.startsWith(ROOT_SUBPATH));
  return isSubpathMap
    ? Object.entries(exports).map(([subpath, value]) => ({
        subpath,
        field: fieldWithKey("exports", subpath),
        value,
      }))
    : [{ subpath: ROOT_SUBPATH, field: "exports", value: exports }];
};

const isIndexOfTheDirectoryTheSubpathNames = (subpath: string, target: string) => {
  const relativeTarget = target.startsWith(RELATIVE_PREFIX)
    ? target.slice(RELATIVE_PREFIX.length)
    : target;
  const [sourceDirectory = "", ...insideTheSourceDirectory] = relativeTarget
    .replace(QUERY_OR_FRAGMENT, "")
    .split("/");
  const fileName = insideTheSourceDirectory.at(-1);
  const namedDirectory = subpath === ROOT_SUBPATH ? "" : moduleDirectoryNamedBy(subpath);
  return (
    !NOT_A_DIRECTORY_NAME.has(sourceDirectory) &&
    fileName !== undefined &&
    INDEX_FILE.test(fileName) &&
    insideTheSourceDirectory.slice(0, -1).join("/") === namedDirectory
  );
};

export const exportPathMismatches = (path: string, manifest: typeof JSON_OBJECT.Type) => {
  const exports = manifest["exports"];
  if (exports === undefined) {
    return [];
  }
  return subpathsWithTheirFields(exports).flatMap(({ subpath, field, value }) =>
    targetsUnderEveryCondition(field, value)
      .filter(
        ({ target }) =>
          isTypeScriptSourceFile(target.replace(QUERY_OR_FRAGMENT, "")) &&
          !isIndexOfTheDirectoryTheSubpathNames(subpath, target),
      )
      .map(
        ({ field: conditionField, target }) =>
          new ExportPathMismatch({ location: path, field: conditionField, target, subpath }),
      ),
  );
};

const isCodeOtherThanTypeScriptSource = (target: string) => {
  const file = target.replace(QUERY_OR_FRAGMENT, "");
  const isExtensionlessFile =
    !FILE_EXTENSION.test(file) && !file.includes(PACKAGE_PATTERN_WILDCARD);
  return !isTypeScriptSourceFile(file) && (CODE_FILE.test(file) || isExtensionlessFile);
};

export const packageEntriesNotTypeScript = (path: string, manifest: typeof JSON_OBJECT.Type) => {
  const exports = manifest["exports"];
  return [
    ...ENTRY_FIELDS.flatMap((field) => {
      const target = manifest[field];
      return typeof target === "string" ? [{ field, target }] : [];
    }),
    ...(exports === undefined
      ? []
      : subpathsWithTheirFields(exports).flatMap(({ field, value }) =>
          targetsUnderEveryCondition(field, value),
        )),
  ]
    .filter(({ target }) => isCodeOtherThanTypeScriptSource(target))
    .map(({ field, target }) => new PackageEntryNotTypeScript({ location: path, field, target }));
};
