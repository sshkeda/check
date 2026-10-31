import { defineRule } from "@oxlint/plugins";

import { fileNameOf, isEntryFileName } from "../shared/match-file-names-and-path-prefixes.ts";

const VAGUE_SUFFIXES: ReadonlySet<string> = new Set(["logic", "impl"]);

const VAGUE_FILE_NAMES: ReadonlySet<string> = new Set([
  "utils",
  "helpers",
  "common",
  "misc",
  "types",
  ...VAGUE_SUFFIXES,
]);

const ENTRY_NAME = "index";

export const noVagueFileNames = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: `Name files after what they do, not ${[...VAGUE_FILE_NAMES].join(", ")} or a ${[...VAGUE_SUFFIXES].map((suffix) => `.${suffix}`).join(" or ")} suffix, and keep ${ENTRY_NAME} for entries.`,
    },
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
        const suffix = suffixes.find((part) => VAGUE_SUFFIXES.has(part));
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
