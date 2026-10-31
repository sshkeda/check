import { inEachPackage } from "../../../shared/check-each-nested-package.ts";
import { quietViolations } from "../../../shared/print-failures-and-keep-detail-in-the-trace.ts";
import { findFileLayoutViolations } from "./find-file-layout-violations.ts";

const LAYOUT = "layout";

export const fileLayoutViolationsOfEachPackage = inEachPackage(LAYOUT, ".", (packageDirectory) =>
  findFileLayoutViolations(packageDirectory).pipe(quietViolations(LAYOUT)),
);
