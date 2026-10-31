import { Task } from "@sshkeda/task";

import { fileLayoutViolationsOfEachPackage } from "./internal/check-the-layout-of-each-package.ts";

export const layout = Task.make("layout", fileLayoutViolationsOfEachPackage);
