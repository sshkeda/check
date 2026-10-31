import { fileNameOf } from "../../../shared/match-file-names-and-path-prefixes.ts";

const TOOL_FILES = [
  {
    names: ["README.md", "package.json", ".gitignore", "tsconfig.json", "tsconfig.build.json"],
    directories: undefined,
    allowsFileType: true,
  },
  {
    names: [
      "LICENSE",
      "bun.lock",
      "bunfig.toml",
      "oxlint.config.ts",
      "oxfmt.config.ts",
      "vite.config.ts",
    ],
    directories: [""],
    allowsFileType: true,
  },
  {
    names: ["Dockerfile"],
    directories: [""],
    allowsFileType: false,
  },
] as const;

export const toolFileOf = (path: string) =>
  TOOL_FILES.find(({ names }) => names.some((name) => name === fileNameOf(path)));

export const toolFileIsPlaced = (path: string) => {
  const tool = toolFileOf(path);
  const directory = path.split("/").slice(0, -1).join("/");
  return (
    tool !== undefined &&
    (tool.directories === undefined || tool.directories.some((allowed) => allowed === directory))
  );
};
