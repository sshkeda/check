import { Task } from "@sshkeda/task";

import { check } from "../../src/lib/tasks/index.ts";

export const passesItsOwnCheck = Task.make({ name: "check passes on its own source", run: check });
