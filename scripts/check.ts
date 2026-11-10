#!/usr/bin/env bun
import { Task } from "@sshkeda/task";

import { PROJECT_DIRECTORY_VARIABLE } from "../src/lib/project-directory/index.ts";
import { check } from "../src/lib/tasks/index.ts";

if (import.meta.main) {
  process.env[PROJECT_DIRECTORY_VARIABLE] = process.cwd();
  Task.main(check);
}
