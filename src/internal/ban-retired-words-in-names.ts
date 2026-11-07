import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import { retiredWordIn } from "../shared/find-retired-words.ts";
import { fileNameOf } from "../shared/match-file-names-and-path-prefixes.ts";
import { fileNameWords, identifierWords } from "./split-names-into-words.ts";
import { declaredNameListeners } from "./visit-every-declared-name.ts";

const wordsOf = (name: string) => identifierWords(name).map((word) => word.text);

export const noRetiredWords = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      name: "`{{name}}` uses the retired word {{word}}",
      fileName: "file name {{fileName}} uses the retired word {{word}}",
    },
  },
  create(context) {
    const check = (node: ESTree.Node, inheritedNames: readonly string[] = []) => {
      const isIdentifierOrPrivateIdentifier =
        node.type === "Identifier" || node.type === "PrivateIdentifier";
      if (!isIdentifierOrPrivateIdentifier) {
        return;
      }
      const retired = retiredWordIn(wordsOf(node.name));
      const inherited = new Set(
        inheritedNames.flatMap((name) => wordsOf(name)).map((text) => text.toLowerCase()),
      );
      const usesRetiredWordNotInherited = retired !== undefined && !inherited.has(retired.word);
      if (usesRetiredWordNotInherited) {
        context.report({ node, messageId: "name", data: { name: node.name, ...retired } });
      }
    };
    return {
      ...declaredNameListeners(check, "own"),
      Program(node) {
        const fileName = fileNameOf(context.filename);
        const retired = retiredWordIn(fileNameWords(fileName));
        if (retired !== undefined) {
          context.report({ node, messageId: "fileName", data: { fileName, ...retired } });
        }
      },
    };
  },
});
