import { Config } from "effect";

export const PROJECT_DIRECTORY_VARIABLE = "SSHKEDA_CHECK_PROJECT_DIRECTORY";

const THE_PACKAGE_THAT_RUNS_THE_TASK = ".";

export const projectDirectory = Config.String(PROJECT_DIRECTORY_VARIABLE).pipe(
  Config.withDefault(THE_PACKAGE_THAT_RUNS_THE_TASK),
);
