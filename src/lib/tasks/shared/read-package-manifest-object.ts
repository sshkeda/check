import { Result, Schema } from "effect";

import { JSON_TEXT } from "./encode-compact-json.ts";
import {
  PackageManifestNotObject,
  PackageManifestUnparsable,
} from "./project-config-and-tool-errors.ts";

export const JSON_OBJECT = Schema.Record(Schema.String, Schema.Json);

export const packageManifestObject = (
  path: string,
  text: string,
): Result.Result<typeof JSON_OBJECT.Type, PackageManifestNotObject | PackageManifestUnparsable> => {
  const json = Schema.decodeResult(JSON_TEXT)(text);
  if (Result.isFailure(json)) {
    return Result.fail(
      new PackageManifestUnparsable({ location: path, reason: json.failure.message }),
    );
  }
  const object = Schema.decodeUnknownResult(JSON_OBJECT)(json.success);
  if (Result.isFailure(object)) {
    return Result.fail(
      new PackageManifestNotObject({ location: path, reason: object.failure.message }),
    );
  }
  return Result.succeed(object.success);
};
