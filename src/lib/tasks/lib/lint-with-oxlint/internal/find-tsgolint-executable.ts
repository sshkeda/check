import { Effect, Path } from "effect";

import { installedBinary } from "../../../shared/find-installed-package-binaries.ts";
import { PackageNotInstalled } from "../../../shared/project-config-and-tool-errors.ts";

export const tsgolintExecutable = Effect.gen(function* () {
  const path = yield* Path.Path;
  const packageDirectory = yield* path.fromFileUrl(new URL(".", import.meta.url));
  const launcher = yield* installedBinary(packageDirectory, "oxlint-tsgolint", "tsgolint");
  const platformPackage = `@oxlint-tsgolint/${process.platform}-${process.arch}`;
  const executable = process.platform === "win32" ? "tsgolint.exe" : "tsgolint";
  return yield* Effect.tryPromise({
    try: () => Bun.resolve(`${platformPackage}/${executable}`, path.dirname(launcher)),
    catch: (cause) =>
      new PackageNotInstalled({
        packageName: platformPackage,
        packageDirectory: path.dirname(launcher),
        reason: String(cause),
      }),
  });
});
