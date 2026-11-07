import { Task } from "@sshkeda/task";

export const runTaskFile = (
  command: string,
  options: {
    readonly cwd: string;
    readonly taskStateDirectory: string;
    readonly env?: Readonly<Record<string, string>>;
  },
) =>
  Task.exec("sh", ["-c", `${command} 2>&1`], {
    cwd: options.cwd,
    env: {
      SSHKEDA_TASK_WORKERS: "1",
      ...options.env,
      SSHKEDA_TASK_STATE_DIRECTORY: options.taskStateDirectory,
    },
  });
