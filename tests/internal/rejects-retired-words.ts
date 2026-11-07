import { expect } from "bun:test";

import { Task } from "@sshkeda/task";

import { ruleTestWith, wordInName } from "../shared/rule-test.ts";

const ruleTest = ruleTestWith(({ reported, expected }) => {
  expect(reported).toMatchObject(expected);
});

export const rejectsRetiredWordsInDeclaredNames = Task.make(
  "no-retired-words reports fingerprint, folder, settings, finding and problem in the names a file chooses",
  ruleTest("no-retired-words", {
    valid: [
      "const hash = 1;",
      "const violations = [];",
      "const directory = '.';",
      "const options = {};",
      "report.findings;",
      "const report = { settings: [] };",
      'import { findings } from "other";',
      'import { Settings as Configured } from "other";',
      "const problematic = 1;",
      "const digest = 1;",
      "const diagnostics = [];",
      "const { settings } = editor;",
      "const { settings = {} } = editor;",
      "class Panel implements Editor { settings = {}; getSettings() { return 1; } }",
      "class Panel extends Base { override getSettings() { return 1; } }",
      "type Settings = editor.Settings;",
      'type Settings = import("editor").Settings;',
    ],
    invalid: [
      {
        code: "const fileFingerprints = [];",
        errors: [wordInName("fileFingerprints", "fingerprints")],
      },
      { code: "const outputFolder = '.';", errors: [wordInName("outputFolder", "folder")] },
      {
        code: "const settings = {};",
        errors: [wordInName("settings", "settings")],
      },
      {
        code: "function check(findings: Array<string>) {}",
        errors: [wordInName("findings", "findings")],
      },
      {
        code: "class ProblemReport {}",
        errors: [wordInName("ProblemReport", "problem")],
      },
      {
        code: "interface Report { readonly findings: Array<string> }",
        errors: [wordInName("findings", "findings")],
      },
      {
        code: "const MAX_FINDINGS = 3;",
        errors: [wordInName("MAX_FINDINGS", "findings")],
      },
      {
        code: "const { settings: editorSettings } = editor;",
        errors: [wordInName("editorSettings", "settings")],
      },
      {
        code: 'import { join as folderJoin } from "node:path";',
        errors: [wordInName("folderJoin", "folder")],
      },
      {
        code: "export interface Editor { getSettings(): number } class Panel implements Editor { getSettings() { return 1; } }",
        errors: [wordInName("getSettings", "settings")],
      },
      {
        code: "interface Editor { readonly settings: object } class Panel implements Editor { settings = {}; folderName = ''; }",
        errors: [wordInName("settings", "settings"), wordInName("folderName", "folder")],
      },
      {
        code: "class Panel { getSettings() { return 1; } }",
        errors: [wordInName("getSettings", "settings")],
      },
      {
        code: "type Settings = Record<string, string>;",
        errors: [wordInName("Settings", "settings")],
      },
    ],
  }),
);

export const rejectsRetiredWordsInFileNames = Task.make(
  "no-retired-words reports a retired word in the linted file's own name and leaves directories to the layout check",
  ruleTest("no-retired-words", {
    valid: [
      { code: "export const HASH = 1;", filename: "src/lib/file-hashes.ts" },
      { code: "export const HASH = 1;", filename: "src/folders/report.ts" },
      { code: "export const HASH = 1;", filename: "src/lib/content-digest.ts" },
    ],
    invalid: [
      {
        code: "export const HASH = 1;",
        filename: "src/lib/settings.ts",
        errors: [
          {
            messageId: "fileName",
            data: { fileName: "settings.ts", word: "settings" },
          },
        ],
      },
      {
        code: "export const HASH = 1;",
        filename: "src/lib/folder-scan.ts",
        errors: [
          {
            messageId: "fileName",
            data: { fileName: "folder-scan.ts", word: "folder" },
          },
        ],
      },
    ],
  }),
);
