import { Task } from "@sshkeda/task";

import { fileTypeViolationsOfEachPackage } from "./internal/find-file-type-violations.ts";

export const fileTypes = Task.make("file-types", fileTypeViolationsOfEachPackage);
