import { defineRule } from "@oxlint/plugins";

import { fileNameOf, isEntryFileName } from "../shared/match-file-names-and-path-prefixes.ts";

const VAGUE_FILE_NAMES: ReadonlySet<string> = new Set([
  "utils",
  "helpers",
  "common",
  "misc",
  "types",
  "logic",
  "impl",
]);

const ENTRY_NAME = "index";

export const noVagueFileNames = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      vague: "file name {{fileName}} is {{name}}, which does not say what it does",
      vagueSuffix: "file name {{fileName}} ends in .{{suffix}}, which does not say what it does",
      index: "file name {{fileName}} is index but is not an entry",
    },
  },
  create(context) {
    return {
      Program(node) {
        const fileName = fileNameOf(context.filename);
        const [name = "", ...suffixes] = fileName.split(".");
        if (VAGUE_FILE_NAMES.has(name)) {
          context.report({ node, messageId: "vague", data: { fileName, name } });
          return;
        }
        const suffix = suffixes.find((part) => VAGUE_FILE_NAMES.has(part));
        if (suffix !== undefined) {
          context.report({ node, messageId: "vagueSuffix", data: { fileName, suffix } });
          return;
        }
        const isIndexOutsideAnEntryFile = name === ENTRY_NAME && !isEntryFileName(fileName);
        if (isIndexOutsideAnEntryFile) {
          context.report({ node, messageId: "index", data: { fileName } });
        }
      },
    };
  },
});
