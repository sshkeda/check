import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";
import { Schema } from "effect";

import { decodeRuleOptions, ruleOptionsJsonSchema } from "./describe-and-decode-rule-options.ts";
import { identifierWords } from "./split-names-into-words.ts";
import { declaredNameListeners } from "./visit-every-declared-name.ts";

const TWO_WORDS = 2;

const ABBREVIATIONS: ReadonlyMap<string, string> = new Map([
  ["arg", "argument"],
  ["args", "arguments"],
  ["arr", "array"],
  ["attr", "attribute"],
  ["btn", "button"],
  ["calc", "calculate"],
  ["cb", "callback"],
  ["cfg", "config"],
  ["cnt", "count"],
  ["col", "column"],
  ["conf", "config"],
  ["coord", "coordinate"],
  ["ctx", "context"],
  ["cur", "current"],
  ["curr", "current"],
  ["cwd", "workingDirectory"],
  ["db", "database"],
  ["decl", "declaration"],
  ["def", "definition"],
  ["dep", "dependency"],
  ["dest", "destination"],
  ["dir", "directory"],
  ["dst", "destination"],
  ["el", "element"],
  ["elem", "element"],
  ["env", "environment"],
  ["err", "error"],
  ["evt", "event"],
  ["expr", "expression"],
  ["fmt", "format"],
  ["fn", "function"],
  ["fs", "fileSystem"],
  ["idx", "index"],
  ["img", "image"],
  ["impl", "implementation"],
  ["info", "information"],
  ["init", "initialize"],
  ["len", "length"],
  ["lib", "library"],
  ["mgr", "manager"],
  ["msg", "message"],
  ["num", "number"],
  ["obj", "object"],
  ["opt", "option"],
  ["opts", "options"],
  ["param", "parameter"],
  ["params", "parameters"],
  ["pkg", "package"],
  ["pos", "position"],
  ["prev", "previous"],
  ["prop", "property"],
  ["props", "properties"],
  ["pt", "point"],
  ["rect", "rectangle"],
  ["repo", "repository"],
  ["req", "request"],
  ["res", "response"],
  ["resp", "response"],
  ["ret", "result"],
  ["src", "source"],
  ["stderr", "standardError"],
  ["stdin", "standardInput"],
  ["stdout", "standardOutput"],
  ["str", "string"],
  ["temp", "temporary"],
  ["tmp", "temporary"],
  ["util", "utility"],
  ["utils", "utilities"],
  ["val", "value"],
]);

const plural = (word: string) => (word.endsWith("y") ? `${word.slice(0, -1)}ies` : `${word}s`);

const expand = (word: string, allowed: ReadonlySet<string>) => {
  const lower = word.toLowerCase();
  if (allowed.has(lower)) {
    return null;
  }
  const direct = ABBREVIATIONS.get(lower);
  if (direct !== undefined) {
    return direct;
  }
  const singular = lower.endsWith("s") ? ABBREVIATIONS.get(lower.slice(0, -1)) : undefined;
  return singular === undefined ? null : plural(singular);
};

const spaced = (camel: string) =>
  camel.replaceAll(/[A-Z]/gu, (letter) => ` ${letter.toLowerCase()}`);

export const inEnglish = (fullWords: readonly string[]) =>
  fullWords.length < TWO_WORDS
    ? fullWords.join("")
    : `${fullWords.slice(0, -1).join(", ")} and ${fullWords.at(-1)}`;

const abbreviatedWordsIn = (name: string, allowed: ReadonlySet<string>) => {
  const found = identifierWords(name).flatMap((word) => {
    const full = expand(word.text, allowed);
    return full === null ? [] : [{ ...word, full }];
  });
  if (found.length === 0) {
    return null;
  }
  return {
    fullWords: inEnglish(found.map((word) => spaced(word.full))),
    abbreviations: found.length === 1 ? "an abbreviation" : "abbreviations",
  };
};

const ABBREVIATION_OPTIONS = Schema.Struct({
  allow: Schema.optionalKey(Schema.Array(Schema.String)),
});

const allowList = (options: readonly unknown[]): ReadonlySet<string> =>
  new Set(
    (decodeRuleOptions(ABBREVIATION_OPTIONS, options)?.allow ?? []).map((word) =>
      word.toLowerCase(),
    ),
  );

export const noAbbreviations = defineRule({
  meta: {
    type: "suggestion",
    messages: {
      abbreviation: "`{{name}}` contains {{abbreviations}} of {{fullWords}}",
    },
    schema: ruleOptionsJsonSchema(ABBREVIATION_OPTIONS),
  },
  create(context) {
    const allowed = allowList(context.options);

    const check = (node: ESTree.Node) => {
      const isIdentifierOrPrivateIdentifier =
        node.type === "Identifier" || node.type === "PrivateIdentifier";
      if (!isIdentifierOrPrivateIdentifier) {
        return;
      }
      const found = abbreviatedWordsIn(node.name, allowed);
      if (found === null) {
        return;
      }
      context.report({
        node,
        messageId: "abbreviation",
        data: { name: node.name, ...found },
      });
    };

    return declaredNameListeners(check);
  },
});
