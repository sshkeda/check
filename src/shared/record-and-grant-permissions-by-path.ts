import { Array as Arrays, Result, Schema, SchemaIssue } from "effect";

import {
  BANS_NO_GRANT_LIFTS,
  bansNoGrantLifts,
  GRANTABLE_BAN_NAMES,
  HANDLES_EVERY_FAILURE,
  PERMISSION_BANS,
  READS_CONFIG,
  RULES_EACH_PERMISSION_LIFTS,
  SCRIPT,
  SHORT_NAMES,
  TRUSTS_UNVERIFIED_TYPES,
  UNUSED_GRANT_REPORTED,
  WRITES_TO_THE_TERMINAL,
} from "./bans-each-permission-lifts.ts";
import { isWithin } from "./match-file-names-and-path-prefixes.ts";
import { MalformedGrant, PermissionGrantsRefused } from "./permission-grant-errors.ts";
import { SCRIPTS_DIRECTORY, TEST_DIRECTORY, TEST_HOME } from "./test-home-directories.ts";

export const DIRECTORY = "isAnUnlistedDirectory";
export const GENERATED = "isGeneratedByATool";
export const PATCH = "patchesADependency";
export const FILE_TYPE = "hasAnUnlistedFileType";
export const TEST_TIMEOUTS_RULE = "no-test-timeouts";
export const TYPE_PREDICATES_RULE = "no-type-predicates";
export const STDIO_SERVICE_RULE = "no-stdio-service";
export const FAILURES_AS_RESULTS_RULE = "no-failures-as-results";
export const UNNAMED_FALLBACKS_RULE = "no-unnamed-fallbacks";
export const FIXED_FALLBACKS = "fallsBackToFixedValues";
export const FIXED_FALLBACKS_RULE = "no-fixed-fallbacks";
export const FIXED_FALLBACKS_GRANTED = "granted";
const SCHEDULES = "pollsWithADeadline";
const TIMERS = "waitsOnTimers";
export const SCHEDULES_RULE = "no-schedules";
export const SLEEP_RULE = "no-sleep";
export const CLOCK_RULE = "no-clock-reads-and-sleeps";
export const UNUSED_CODE_GRANTS_RULE = "no-unused-code-grants";
export const INSIDE_THE_TEST_HOME = "inside";
const GLOB_CHARACTERS = /[*?[\]{}]/u;
const ROUTE_PARAMETER_SEGMENT = /^\[\[?(?:\.\.\.)?[A-Za-z0-9_-]+\]\]?$/u;

const isGlobPath = (path: string) =>
  path
    .split("/")
    .some((segment) => !ROUTE_PARAMETER_SEGMENT.test(segment) && GLOB_CHARACTERS.test(segment));
const MARKDOWN_EXTENSIONS = [".md", ".markdown"] as const;

export const PERMISSION_NAMES = [
  ...GRANTABLE_BAN_NAMES,
  SHORT_NAMES,
  SCHEDULES,
  TIMERS,
  DIRECTORY,
  PATCH,
  FILE_TYPE,
  TRUSTS_UNVERIFIED_TYPES,
  HANDLES_EVERY_FAILURE,
  FIXED_FALLBACKS,
  GENERATED,
] as const;

const RETIRED_PERMISSIONS = new Map([
  ["errors", "error classes may be declared in any file"],
  [SCRIPT, `files directly in ${SCRIPTS_DIRECTORY}/ run tasks`],
]);

export const isMarkdown = (path: string) =>
  MARKDOWN_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension));

export const permissionBanRuleId = (permission: keyof typeof PERMISSION_BANS) =>
  `sshkeda/${PERMISSION_BANS[permission].ruleName}`;

const GRANTED = ["error", { bans: BANS_NO_GRANT_LIFTS }] as const;

const GRANTED_UNLESS_UNUSED = [
  "error",
  { bans: BANS_NO_GRANT_LIFTS, unusedGrant: UNUSED_GRANT_REPORTED },
] as const;

const permissionBanSeverityOnceGranted = (permission: keyof typeof PERMISSION_BANS) =>
  bansNoGrantLifts(permission).length > 0 ? GRANTED : "off";

const severityOnceGranted = (permission: keyof typeof PERMISSION_BANS) =>
  permission === READS_CONFIG
    ? permissionBanSeverityOnceGranted(permission)
    : GRANTED_UNLESS_UNUSED;

const ruleSeverities = (
  severities: Readonly<
    Record<string, readonly ["error", Readonly<Record<string, string>>] | "off">
  >,
) => Object.entries(severities);

const rulesGrantedBy = (permission: (typeof PERMISSION_NAMES)[number]) => {
  if (permission === SHORT_NAMES) {
    return ruleSeverities({
      [`sshkeda/${RULES_EACH_PERMISSION_LIFTS[permission]}`]: "off",
    } as const);
  }
  if (permission === SCHEDULES) {
    return ruleSeverities({
      [`sshkeda/${SCHEDULES_RULE}`]: ["error", { timedSchedules: "allowedWithDeadline" }],
      [`sshkeda/${TEST_TIMEOUTS_RULE}`]: "off",
    } as const);
  }
  if (permission === TIMERS) {
    return ruleSeverities({
      [`sshkeda/${SLEEP_RULE}`]: "off",
      [`sshkeda/${CLOCK_RULE}`]: ["error", { clockServiceSleeps: "allowed" }],
    } as const);
  }
  if (permission === WRITES_TO_THE_TERMINAL) {
    return ruleSeverities({
      [permissionBanRuleId(permission)]: GRANTED,
      [`sshkeda/${STDIO_SERVICE_RULE}`]: "off",
    } as const);
  }
  if (permission === HANDLES_EVERY_FAILURE) {
    return ruleSeverities({
      [permissionBanRuleId(permission)]: "off",
      [`sshkeda/${FAILURES_AS_RESULTS_RULE}`]: "off",
      [`sshkeda/${UNNAMED_FALLBACKS_RULE}`]: "off",
    } as const);
  }
  if (permission === FIXED_FALLBACKS) {
    return ruleSeverities({
      [`sshkeda/${FIXED_FALLBACKS_RULE}`]: ["error", { fixedFallbacks: FIXED_FALLBACKS_GRANTED }],
    } as const);
  }
  if (permission === TRUSTS_UNVERIFIED_TYPES) {
    return ruleSeverities({
      [permissionBanRuleId(permission)]: "off",
      [`sshkeda/${TYPE_PREDICATES_RULE}`]: ["error", { schemaDeclarations: "allowed" }],
    } as const);
  }
  const grantsNoRule =
    permission === GENERATED ||
    permission === DIRECTORY ||
    permission === PATCH ||
    permission === FILE_TYPE;
  if (grantsNoRule) {
    return ruleSeverities({});
  }
  return ruleSeverities({
    [permissionBanRuleId(permission)]: severityOnceGranted(permission),
  } as const);
};

export const CODE_GRANTS = [
  HANDLES_EVERY_FAILURE,
  TIMERS,
  SCHEDULES,
  SHORT_NAMES,
  TRUSTS_UNVERIFIED_TYPES,
] as const;

const isCodeGrant = Schema.is(Schema.Literals(CODE_GRANTS));

const ABORT_ON_FAILURE = true;

const pathRule = (isAllowed: (path: string) => boolean, violation: (path: string) => string) =>
  Schema.makeFilter(
    (path: string) => isAllowed(path) || violation(path),
    undefined,
    ABORT_ON_FAILURE,
  );

export const normalizedPath = (path: string) =>
  path
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");

const GRANT_PATH = Schema.String.check(
  pathRule(
    (path) => path !== "",
    () => "is not a path",
  ),
  pathRule(
    (path) => !path.includes("\\"),
    () => "uses backslashes",
  ),
  pathRule(
    (path) => !isGlobPath(path),
    () => "is a glob",
  ),
  pathRule(
    (path) => !path.startsWith("!"),
    () => "is a negated pattern",
  ),
  pathRule(
    (path) => !path.startsWith("/"),
    () => "is an absolute path",
  ),
  pathRule(
    (path) => !path.split("/").includes(".."),
    () => "has a .. segment",
  ),
  pathRule(
    (path) => normalizedPath(path) === path,
    () => "is not a normalized path",
  ),
);

const PERMISSION = Schema.String.annotate({ message: "is not a permission name" })
  .check(
    Schema.makeFilter((name: string) => {
      const retirement = RETIRED_PERMISSIONS.get(name);
      return retirement === undefined || `${name} is retired: ${retirement}`;
    }),
  )
  .pipe(Schema.decodeTo(Schema.Literals(PERMISSION_NAMES)));

const nonEmptyList = <Entry extends Schema.Top>(entry: Entry) =>
  Schema.Array(entry).check(Schema.isNonEmpty({ message: "is empty" }));

const ALLOWED = nonEmptyList(PERMISSION);

const GRANT_FIELDS = {
  allow: Schema.optionalKey(ALLOWED),
  services: Schema.optionalKey(nonEmptyList(Schema.NonEmptyString)),
  cannotImport: Schema.optionalKey(nonEmptyList(GRANT_PATH)),
};

const GRANT = Schema.Struct(GRANT_FIELDS)
  .annotate({
    messageUnexpectedKey: `is not one of the grant keys ${Object.keys(GRANT_FIELDS).join(", ")}`,
  })
  .check(Schema.makeFilter((grant) => Object.keys(grant).length > 0 || "grants nothing"));

const isGrant = Schema.is(GRANT);
const UNDECODED_GRANT = Schema.Record(Schema.String, Schema.Unknown);
const isUndecodedGrant = Schema.is(UNDECODED_GRANT);
const isList = Schema.is(Schema.Array(Schema.Unknown));
const isString = Schema.is(Schema.String);

const repeatedItems = (path: string, grant: typeof UNDECODED_GRANT.Type) =>
  Object.keys(GRANT_FIELDS).flatMap((key) => {
    const list = grant[key];
    const names = isList(list) ? list.filter((item) => isString(item)) : [];
    const repeated = names.filter((name, index) => names.indexOf(name) !== index);
    return Arrays.dedupe(repeated).map((name) => ({
      path: [path, key],
      issue: `lists "${name}" twice`,
    }));
  });

const grantMismatches = (path: string, grant: typeof GRANT.Type): readonly Schema.FilterIssue[] => {
  const allowed = grant.allow ?? [];
  const grantsOnlyFileType =
    allowed.length > 0 &&
    allowed.every((permission) => permission === FILE_TYPE) &&
    Object.keys(grant).length === 1;
  const grantsGenerated = allowed.includes(GENERATED);
  const grantsGeneratedWithOtherPermissions =
    grantsGenerated && (allowed.length !== 1 || Object.keys(grant).length !== 1);
  const grantsDirectory = allowed.includes(DIRECTORY);
  const grantsMarkdownMoreThanFileType =
    isMarkdown(path) && !grantsOnlyFileType && !grantsDirectory && !grantsGenerated;
  return [
    ...(grantsGeneratedWithOtherPermissions
      ? [
          {
            path: [path],
            issue:
              "generated outputs cannot also have permissions, services or import restrictions",
          },
        ]
      : []),
    ...(grant.cannotImport ?? [])
      .filter((target) => isWithin(path, target))
      .map((target) => ({ path: [path, "cannotImport"], issue: `"${target}" contains "${path}"` })),
    ...(grantsMarkdownMoreThanFileType
      ? [
          {
            path: [path],
            issue: `is Markdown, so it may only be granted ${FILE_TYPE}`,
          },
        ]
      : []),
  ];
};

const GRANT_PATHS = Schema.Record(Schema.String.pipe(Schema.decodeTo(GRANT_PATH)), Schema.Unknown);

const GRANTS = Schema.Record(Schema.String, GRANT);

const GRANTS_AGAINST_THEIR_PATHS = Schema.Record(Schema.String, Schema.Unknown).check(
  Schema.makeFilter((grants) => {
    const entries = Object.entries(grants);
    return [
      ...entries.flatMap(([path, grant]) =>
        isUndecodedGrant(grant) ? repeatedItems(path, grant) : [],
      ),
      ...entries.flatMap(([path, grant]) => (isGrant(grant) ? grantMismatches(path, grant) : [])),
    ];
  }),
);

const STANDARD_SCHEMA_ISSUES = SchemaIssue.makeFormatterStandardSchemaV1();

const unusedCodeGrantsRule = (path: string, permissions: readonly string[]) => {
  const codeGrants = permissions.filter((permission) => isCodeGrant(permission));
  const place = isWithin(path, TEST_DIRECTORY) ? { testHome: INSIDE_THE_TEST_HOME } : {};
  return codeGrants.length > 0
    ? Object.entries({
        [`sshkeda/${UNUSED_CODE_GRANTS_RULE}`]: ["error", { permissions: codeGrants, ...place }],
      } as const)
    : [];
};

const grantOverride = (
  grant: Extract<ReturnType<typeof recordedGrantsOf>, { grants: unknown }>["grants"][number],
) => ({
  files: [`./${grant.path.replaceAll("[", String.raw`\[`).replaceAll("]", String.raw`\]`)}`],
  rules: {
    ...Object.fromEntries(grant.allow.flatMap((permission) => rulesGrantedBy(permission))),
    ...Object.fromEntries(unusedCodeGrantsRule(grant.path, grant.allow)),
    ...Object.fromEntries(
      grant.services.length > 0
        ? Object.entries({
            "sshkeda/no-service-declarations": ["error", { services: grant.services }],
            "sshkeda/no-unused-service-grants": ["error", { services: grant.services }],
          } as const)
        : [],
    ),
  },
});

const TEST_HOME_OVERRIDE = {
  files: [`./${TEST_HOME}**`],
  rules: {
    "sshkeda/no-testing-helpers": "off",
    "sshkeda/no-assertions": "off",
    [`sshkeda/${SCHEDULES_RULE}`]: "off",
    [`sshkeda/${FIXED_FALLBACKS_RULE}`]: "off",
    "sshkeda/no-instant-retries": "off",
    "sshkeda/no-shared-holders": "off",
    [`sshkeda/${TEST_TIMEOUTS_RULE}`]: "error",
  },
} as const;

const TEST_HOME_SEVERITIES: ReadonlyMap<string, string> = new Map(
  Object.entries(TEST_HOME_OVERRIDE.rules),
);

const isOnWithoutAGrant = (ruleId: string, isInTheTestHome: boolean) => {
  const testHomeSeverity = TEST_HOME_SEVERITIES.get(ruleId);
  return isInTheTestHome ? testHomeSeverity !== "off" : testHomeSeverity !== "error";
};

export const rulesACodeGrantChanges = (
  permission: (typeof CODE_GRANTS)[number],
  isInTheTestHome: boolean,
) =>
  rulesGrantedBy(permission).map(([ruleId, granted]) => ({
    ruleId,
    granted,
    isOnWithoutTheGrant: isOnWithoutAGrant(ruleId, isInTheTestHome),
  }));

const SCRIPTS_OVERRIDE = {
  files: [`./${SCRIPTS_DIRECTORY}/*`],
  rules: { [permissionBanRuleId(SCRIPT)]: "off" },
} as const;

const DECODE_OPTIONS = {
  errors: "all",
  onExcessProperty: "error",
  reportInput: true,
} as const;

const grantLocation = (
  issuePath: ReturnType<typeof STANDARD_SCHEMA_ISSUES>["issues"][number]["path"],
) =>
  (issuePath ?? [])
    .map((segment) => (typeof segment === "object" ? segment.key : segment))
    .map((key, index) => {
      if (index === 0) {
        return `"${String(key)}"`;
      }
      return typeof key === "number" ? `[${key}]` : `.${String(key)}`;
    })
    .join("");

const malformedGrants = (decoded: Result.Result<unknown, Schema.SchemaError>) =>
  Result.isFailure(decoded)
    ? STANDARD_SCHEMA_ISSUES(decoded.failure.issue).issues.map(
        (issue) =>
          new MalformedGrant({
            issuePath: grantLocation(issue.path),
            issueMessage: issue.message,
          }),
      )
    : [];

export const recordedGrantsOf = (permissionsByPath: unknown) => {
  const decoded = Schema.decodeUnknownResult(GRANTS)(permissionsByPath, DECODE_OPTIONS);
  const violations = [
    Schema.decodeUnknownResult(GRANT_PATHS)(permissionsByPath, DECODE_OPTIONS),
    decoded,
    Schema.decodeUnknownResult(GRANTS_AGAINST_THEIR_PATHS)(permissionsByPath, DECODE_OPTIONS),
  ].flatMap((result) => malformedGrants(result));
  const isRefused = Result.isFailure(decoded) || violations.length > 0;
  if (isRefused) {
    return { violations };
  }
  const grants = Object.entries(decoded.success).map(([path, grant]) => ({
    path,
    allow: grant.allow ?? [],
    services: grant.services ?? [],
    cannotImport: grant.cannotImport ?? [],
  }));
  return { grants };
};

export const generatedPathsOf = (
  grants: NonNullable<ReturnType<typeof recordedGrantsOf>["grants"]>,
) => new Set(grants.filter((grant) => grant.allow.includes(GENERATED)).map(({ path }) => path));

export const grantPermissions = <Config>(
  config: Config,
  permissionsByPath: Readonly<
    Record<
      string,
      {
        readonly [Key in keyof typeof GRANT.Type]-?: Required<Pick<typeof GRANT.Type, Key>> &
          typeof GRANT.Type;
      }[keyof typeof GRANT.Type]
    >
  >,
) => {
  const recorded = recordedGrantsOf(permissionsByPath);
  if ("violations" in recorded) {
    const failure = new PermissionGrantsRefused({ violations: recorded.violations });
    failure.stack = `${failure._tag}: ${failure.message}`;
    throw failure;
  }
  const overrides = [
    SCRIPTS_OVERRIDE,
    TEST_HOME_OVERRIDE,
    ...recorded.grants
      .filter((grant) => grant.allow.length > 0 || grant.services.length > 0)
      .map((grant) => grantOverride(grant)),
  ];
  return { ...config, overrides };
};
