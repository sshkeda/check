import {
  Array as Arrays,
  Context,
  Effect,
  FileSystem,
  Layer,
  Path,
  Predicate,
  Schema,
} from "effect";
import type {
  CallExpression,
  Node,
  ShorthandPropertyAssignment,
  SourceFile,
} from "typescript/unstable/ast";
import {
  isArrowFunction,
  isCallExpression,
  isCallSignatureDeclaration,
  isClassDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isFunctionTypeNode,
  isIdentifier,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isPropertyAssignment,
  isPropertySignatureDeclaration,
  isShorthandPropertyAssignment,
  isSourceFile,
  isTypeLiteralNode,
  isVariableDeclaration,
} from "typescript/unstable/ast/is";
import { API, SymbolFlags } from "typescript/unstable/async";
import type { Checker, Program, Symbol as TypeScriptSymbol, Type } from "typescript/unstable/async";

import { isDeclarationFile, isScript, packagePathOf } from "./classify-files-by-role.ts";
import { ownedFilesAmong } from "./list-owned-files.ts";
import {
  existingPackageFiles,
  isInsideAnyDirectory,
  nestedPackageDirectoriesAmong,
} from "./list-package-files.ts";
import {
  AbsoluteProjectReference,
  ProgramFilesOutsideProject,
  ProjectReferencesUndecodable,
  TypeScriptApiFailed,
  TypeScriptConfigUnparsable,
  TypeScriptProjectFileMissing,
  TypeScriptReturnedNothing,
} from "./project-config-and-tool-errors.ts";
import { absolutePathOf } from "./resolve-absolute-paths.ts";

export const TYPESCRIPT_PROJECT_FILE = "tsconfig.json";

export const CONCURRENT_TYPESCRIPT_REQUESTS = 32;

const NODE_MODULES_DIRECTORY = "node_modules";

export const packageFileOf = (projectDirectory: string, fileName: string) => {
  const projectPrefix = `${projectDirectory}/`;
  const searchedPath = fileName.toLowerCase().startsWith(projectPrefix.toLowerCase())
    ? fileName.slice(projectPrefix.length)
    : fileName;
  const segments = searchedPath.split("/");
  const installedAt = segments.lastIndexOf(NODE_MODULES_DIRECTORY);
  return installedAt === -1
    ? undefined
    : segments
        .slice(installedAt + 1)
        .join("/")
        .toLowerCase();
};

const isInNodeModules = (projectDirectory: string, fileName: string) =>
  packageFileOf(projectDirectory, fileName) !== undefined;

const isLibraryFile = (projectDirectory: string, fileName: string) =>
  isInNodeModules(projectDirectory, fileName) || isDeclarationFile(fileName);

const COMPILER_OPTIONS = Schema.Record(Schema.String, Schema.Json);

export const CUSTOM_CONDITIONS = Schema.Struct({
  customConditions: Schema.optionalKey(Schema.Array(Schema.String)),
});

const PROJECT_REFERENCES = Schema.Struct({
  references: Schema.optionalKey(Schema.Array(Schema.Struct({ path: Schema.String }))),
});

export const typeScriptRequest = <Value>(operation: string, request: () => Promise<Value>) =>
  Effect.tryPromise({
    try: request,
    catch: (cause) => new TypeScriptApiFailed({ operation, reason: String(cause) }),
  });

export const typeMembers = (type: Type) =>
  type.isUnionType()
    ? typeScriptRequest("read union members", () => type.getTypes())
    : Effect.succeed([type]);

export const callsIn = (sourceFile: SourceFile) => {
  const calls: CallExpression[] = [];
  const visit = (node: Node) => {
    if (isCallExpression(node)) {
      calls.push(node);
    }
    node.forEachChild(visit);
  };
  sourceFile.forEachChild(visit);
  return calls;
};

export const requiredTypeScriptRequest = <Value>(
  operation: string,
  request: () => Promise<Value | undefined>,
) =>
  typeScriptRequest(operation, request).pipe(
    Effect.filterOrFail(
      Predicate.isNotUndefined,
      () => new TypeScriptReturnedNothing({ operation }),
    ),
  );

export const followedImportAliases = (
  checker: Checker,
  symbols: readonly (TypeScriptSymbol | undefined)[],
) =>
  Effect.forEach(symbols, (symbol) => {
    const isImportAlias = symbol !== undefined && (symbol.flags & SymbolFlags.Alias) !== 0;
    return isImportAlias
      ? typeScriptRequest("follow an import alias", () => checker.getAliasedSymbol(symbol))
      : Effect.succeed(symbol);
  });

export const resolvedSymbols = (checker: Checker, references: readonly Node[]) =>
  Effect.gen(function* () {
    const symbols = yield* typeScriptRequest("resolve referenced symbols", () =>
      checker.getSymbolAtLocation(references),
    );
    return yield* followedImportAliases(checker, symbols);
  });

export const parentOf = (node: Node) => (isSourceFile(node) ? undefined : node.parent);

export const nodePosition = (sourceFile: SourceFile, node: Node) => {
  const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { line: location.line + 1, column: location.character + 1 };
};

const parsedProjectFile = (configFile: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const text = yield* fileSystem
      .readFileString(configFile)
      .pipe(
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.fail(new TypeScriptProjectFileMissing({ projectFile: configFile })),
        ),
      );
    return yield* Effect.try({
      try: () => Bun.JSONC.parse(text),
      catch: (cause) =>
        new TypeScriptConfigUnparsable({ projectFile: configFile, reason: String(cause) }),
    });
  });

const referencesOf = (configFile: string) =>
  Effect.gen(function* () {
    const parsed = yield* parsedProjectFile(configFile);
    const decoded = yield* Schema.decodeUnknownEffect(PROJECT_REFERENCES)(parsed).pipe(
      Effect.mapError(
        (error) =>
          new ProjectReferencesUndecodable({ projectFile: configFile, reason: error.message }),
      ),
    );
    return decoded.references ?? [];
  });

export const projectConfigFiles = (projectFile: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const configFiles = [path.normalize(projectFile)];
    for (const configFile of configFiles) {
      for (const reference of yield* referencesOf(configFile)) {
        if (path.isAbsolute(reference.path)) {
          return yield* new AbsoluteProjectReference({
            projectFile: configFile,
            reference: reference.path,
          });
        }
        const referenced = path.join(path.dirname(configFile), reference.path);
        const referencedConfigFile = referenced.endsWith(".json")
          ? referenced
          : path.join(referenced, TYPESCRIPT_PROJECT_FILE);
        if (!configFiles.includes(referencedConfigFile)) {
          configFiles.push(referencedConfigFile);
        }
      }
    }
    return configFiles;
  });

const openedApi = (sourceTextOverrides: ReadonlyMap<string, string>) =>
  Effect.acquireRelease(
    Effect.sync(
      () =>
        new API(
          sourceTextOverrides.size === 0
            ? {}
            : { fs: { readFile: (fileName) => sourceTextOverrides.get(fileName) } },
        ),
    ),
    (openApi) => Effect.promise(() => openApi.close()),
  );

const parseCompilerOptionsAndInputs = (configFile: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const api = yield* openedApi(new Map());
    const absoluteConfigFile = yield* absolutePathOf(configFile);
    const configDirectory = path.dirname(absoluteConfigFile);
    const parsed = yield* typeScriptRequest(`parse ${configFile}`, () =>
      api.parseConfigFile(absoluteConfigFile),
    );
    const options = yield* Schema.decodeUnknownEffect(COMPILER_OPTIONS)(parsed.options);
    const compilesFiles = parsed.fileNames.length > 0;
    const relativeToConfigDirectory = (value: Schema.Json) => {
      const isAbsolutePath = Predicate.isString(value) && path.isAbsolute(value);
      return isAbsolutePath ? path.relative(configDirectory, value) : value;
    };
    const effectiveOptions = Object.fromEntries(
      Object.entries(options).map(([optionName, value]) => [
        optionName,
        Array.isArray(value)
          ? value.map((item: Schema.Json) => relativeToConfigDirectory(item))
          : relativeToConfigDirectory(value),
      ]),
    );
    return { effectiveOptions, compilesFiles };
  }).pipe(Effect.scoped);

export const includedFiles = (projectFile: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const projectDirectory = path.dirname(yield* absolutePathOf(projectFile));
    const api = yield* openedApi(new Map());
    const parsedConfigs = yield* Effect.forEach(
      yield* projectConfigFiles(projectFile),
      (configFile) =>
        absolutePathOf(configFile).pipe(
          Effect.flatMap((absoluteConfigFile) =>
            typeScriptRequest(`parse ${configFile}`, () => api.parseConfigFile(absoluteConfigFile)),
          ),
        ),
    );
    return new Set(
      parsedConfigs.flatMap(({ fileNames }) =>
        fileNames.map((fileName) => path.relative(projectDirectory, fileName)),
      ),
    );
  }).pipe(Effect.scoped);

const openedPrograms = (
  configFiles: readonly string[],
  sourceTextOverrides: ReadonlyMap<string, string>,
) =>
  Effect.gen(function* () {
    const api = yield* openedApi(sourceTextOverrides);
    const snapshot = yield* typeScriptRequest("load the project", () =>
      api.updateSnapshot({ openProjects: [...configFiles] }),
    );
    return yield* Effect.forEach(configFiles, (configFile) => {
      const project = snapshot.getProject(configFile);
      return project === undefined
        ? new TypeScriptApiFailed({
            operation: "load the project",
            reason: `${configFile} is not a project`,
          })
        : Effect.succeed(project);
    });
  });

const compiledFilesOf = (
  projectFile: string,
  projects: readonly (readonly [configFile: string, project: { readonly program: Program }])[],
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const projectDirectory = path.dirname(yield* absolutePathOf(projectFile));
    const listedFilesOfEachProject = yield* Effect.forEach(projects, ([configFile, { program }]) =>
      typeScriptRequest("list the program files", () => program.getSourceFileNames()).pipe(
        Effect.map((fileNames) => ({
          configFile,
          program,
          fileNames: fileNames.filter((fileName) => path.isAbsolute(fileName)),
        })),
      ),
    );
    const everyListedFile = listedFilesOfEachProject.flatMap(({ fileNames }) => fileNames);
    const listedFiles = everyListedFile.filter(
      (fileName) => !isInNodeModules(projectDirectory, fileName),
    );
    const pathsFromProjectDirectory = listedFiles.map((fileName) =>
      path.relative(projectDirectory, fileName),
    );
    const [firstListedFile] = listedFiles;
    const everyListedFileIsOutsideTheProject =
      firstListedFile !== undefined &&
      pathsFromProjectDirectory.every((relativePath) => relativePath.startsWith(".."));
    if (everyListedFileIsOutsideTheProject) {
      return yield* new ProgramFilesOutsideProject({ projectFile, listedFile: firstListedFile });
    }
    const projectFilesOutsideNodeModules = everyListedFile.filter(
      (fileName) => !isInNodeModules(projectDirectory, fileName),
    );
    const nestedPackageDirectories = yield* nestedPackageDirectoriesAmong(
      projectDirectory,
      projectFilesOutsideNodeModules
        .map((fileName) => path.relative(projectDirectory, fileName))
        .filter((relativePath) => !relativePath.startsWith("..")),
    );
    const isOutsidePackage = (relativePath: string) =>
      relativePath.startsWith("..") || isInsideAnyDirectory(relativePath, nestedPackageDirectories);
    const isPackageScript = (relativePath: string) =>
      !isOutsidePackage(relativePath) && isScript(relativePath);
    const packageFiles = pathsFromProjectDirectory.filter((relativePath) =>
      isPackageScript(relativePath),
    );
    return {
      packageFiles: [...new Set(packageFiles)].toSorted(),
      listedFilesOfEachProject,
      isPackageScriptFile: (fileName: string) =>
        !isInNodeModules(projectDirectory, fileName) &&
        isPackageScript(path.relative(projectDirectory, fileName)),
    };
  });

const listProgramFiles = (projectFile: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const projectDirectory = path.dirname(yield* absolutePathOf(projectFile));
    const configFiles = yield* projectConfigFiles(projectFile);
    const projects = yield* openedPrograms(configFiles, new Map());
    const { listedFilesOfEachProject, isPackageScriptFile, ...compiledFiles } =
      yield* compiledFilesOf(projectFile, Arrays.zip(configFiles, projects));
    const packageSourceFilesOfEachProject = yield* Effect.forEach(
      listedFilesOfEachProject,
      ({ configFile, program, fileNames }) =>
        Effect.forEach(
          fileNames.filter((fileName) => isPackageScriptFile(fileName)),
          (fileName) =>
            requiredTypeScriptRequest("read a source file", () =>
              program.getSourceFile(fileName),
            ).pipe(
              Effect.map(
                (sourceFile) =>
                  [
                    path.relative(projectDirectory, fileName),
                    {
                      isDeclarationFile: sourceFile.isDeclarationFile,
                      scriptKind: sourceFile.scriptKind,
                    },
                  ] as const,
              ),
            ),
          { concurrency: CONCURRENT_TYPESCRIPT_REQUESTS },
        ).pipe(Effect.map((sourceFiles) => ({ configFile, sourceFiles: new Map(sourceFiles) }))),
    );
    return { ...compiledFiles, packageSourceFilesOfEachProject };
  }).pipe(Effect.scoped);

const makeTypeScriptProjectListings = Effect.gen(function* () {
  const services = yield* Effect.context<
    | Effect.Services<ReturnType<typeof listProgramFiles>>
    | Effect.Services<ReturnType<typeof parseCompilerOptionsAndInputs>>
  >();
  const parsedWithTheRunServices = (configFile: string) =>
    parseCompilerOptionsAndInputs(configFile).pipe(Effect.provide(services));
  const listedWithTheRunServices = (projectFile: string) =>
    listProgramFiles(projectFile).pipe(Effect.provide(services));
  const compilerOptionsAndInputsByConfigFile = new Map<
    string,
    ReturnType<typeof parsedWithTheRunServices>
  >();
  const programFilesByProject = new Map<string, ReturnType<typeof listedWithTheRunServices>>();
  return {
    compilerOptionsAndInputs: (configFile: string) =>
      Effect.gen(function* () {
        const cachedParse =
          compilerOptionsAndInputsByConfigFile.get(configFile) ??
          (yield* Effect.cached(parsedWithTheRunServices(configFile)));
        compilerOptionsAndInputsByConfigFile.set(configFile, cachedParse);
        return yield* cachedParse;
      }),
    programFileListing: (projectFile: string) =>
      Effect.gen(function* () {
        const cachedListing =
          programFilesByProject.get(projectFile) ??
          (yield* Effect.cached(listedWithTheRunServices(projectFile)));
        programFilesByProject.set(projectFile, cachedListing);
        return yield* cachedListing;
      }),
  };
});

class TypeScriptProjectListings extends Context.Service<
  TypeScriptProjectListings,
  Effect.Success<typeof makeTypeScriptProjectListings>
>()("@sshkeda/check/TypeScriptProjectListings") {}

export const TypeScriptProjectListingsLive = Layer.effect(
  TypeScriptProjectListings,
  makeTypeScriptProjectListings,
);

const compilerOptionsAndInputs = (configFile: string) =>
  TypeScriptProjectListings.use((listings) => listings.compilerOptionsAndInputs(configFile));

export const effectiveCompilerOptions = (configFile: string) =>
  compilerOptionsAndInputs(configFile).pipe(Effect.map(({ effectiveOptions }) => effectiveOptions));

export const compilesFiles = (configFile: string) =>
  compilerOptionsAndInputs(configFile).pipe(Effect.map((parsed) => parsed.compilesFiles));

const cachedProgramFileListing = (projectFile: string) =>
  TypeScriptProjectListings.use((listings) => listings.programFileListing(projectFile));

export const programFiles = (projectFile: string) =>
  cachedProgramFileListing(projectFile).pipe(Effect.map(({ packageFiles }) => packageFiles));

export const packageSourceFilesOfEachProject = (projectFile: string) =>
  cachedProgramFileListing(projectFile).pipe(
    Effect.map((listing) => listing.packageSourceFilesOfEachProject),
  );

export const checkedSourceFiles = (projectFile: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const packageDirectory = path.dirname(projectFile);
    const tracked = yield* existingPackageFiles(packageDirectory, ["."]);
    const listed = new Set([
      ...(yield* programFiles(projectFile)),
      ...tracked.filter((file) => isScript(file)),
    ]);
    return yield* FileSystem.FileSystem.use((fileSystem) =>
      Effect.gen(function* () {
        const realPackageDirectory = yield* fileSystem.realPath(packageDirectory);
        const realFiles = yield* Effect.forEach(
          listed,
          (file) =>
            fileSystem
              .realPath(path.join(packageDirectory, file))
              .pipe(Effect.map((real) => packagePathOf(path, realPackageDirectory, real))),
          { concurrency: "unbounded" },
        );
        return [
          ...new Set(realFiles.filter((file) => !file.startsWith("..") && listed.has(file))),
        ].toSorted();
      }),
    );
  });

const NO_SYMBOL = undefined;

const factOf = (projectDirectory: string, symbol: TypeScriptSymbol | undefined) =>
  symbol === undefined
    ? undefined
    : {
        id: symbol.id,
        library:
          symbol.declarations.length > 0 &&
          symbol.declarations.every((declaration) =>
            isLibraryFile(projectDirectory, declaration.path),
          ),
      };

export const valueSymbolAt = <Failure>(
  checker: Checker,
  node: Node | undefined,
  located: Effect.Effect<TypeScriptSymbol | undefined, Failure>,
) => {
  const isShorthandPropertyName =
    node !== undefined && isShorthandPropertyAssignment(node.parent) && node.parent.name === node;
  return isShorthandPropertyName
    ? typeScriptRequest("resolve a shorthand property value", () =>
        checker.getShorthandAssignmentValueSymbol(node.parent),
      )
    : located;
};

export const projectSymbolsIn = (
  projectDirectory: string,
  projects: Effect.Success<ReturnType<typeof openTypeScriptProjects>>,
) => {
  const checkerOf = new Map(
    projects.flatMap(({ checker, allSourceFiles }) =>
      allSourceFiles.map(
        ({ sourceFile, displayName }) => [displayName, { checker, sourceFile }] as const,
      ),
    ),
  );
  return (file: string) => {
    const owner = checkerOf.get(file);
    if (owner === undefined) {
      return;
    }
    return (
      requests: readonly {
        readonly start: number;
        readonly end: number;
        readonly shorthand: boolean;
      }[],
    ) =>
      Effect.gen(function* () {
        if (requests.length === 0) {
          return requests.map(() => NO_SYMBOL);
        }
        const symbols = yield* typeScriptRequest("resolve same-file references", () =>
          owner.checker.getSymbolAtPosition(
            owner.sourceFile.fileName,
            requests.map(({ start }) => start),
          ),
        );
        const shorthandByNameEnd = new Map<number, ShorthandPropertyAssignment>();
        if (requests.some(({ shorthand }) => shorthand)) {
          const visit = (node: Node) => {
            if (isShorthandPropertyAssignment(node)) {
              shorthandByNameEnd.set(node.name.end, node);
            }
            node.forEachChild(visit);
          };
          owner.sourceFile.forEachChild(visit);
        }
        return yield* Effect.forEach(requests, (request, index) => {
          const shorthand = request.shorthand ? shorthandByNameEnd.get(request.end) : undefined;
          return valueSymbolAt(
            owner.checker,
            shorthand === undefined ? undefined : shorthand.name,
            Effect.succeed(symbols[index]),
          ).pipe(Effect.map((symbol) => factOf(projectDirectory, symbol)));
        });
      });
  };
};

const isFunctionAssignedToName = (node: Node) =>
  (isArrowFunction(node) || isFunctionExpression(node)) &&
  (isVariableDeclaration(node.parent) || isPropertyAssignment(node.parent));

const signatureOwnerOf = (node: Node | undefined): Node | undefined => {
  const isSignatureOrTypeLiteral =
    node !== undefined &&
    (isFunctionTypeNode(node) ||
      isCallSignatureDeclaration(node) ||
      isTypeLiteralNode(node) ||
      isFunctionAssignedToName(node));
  return isSignatureOrTypeLiteral ? signatureOwnerOf(node.parent) : node;
};

const isReturnedBySignature = (node: Node | undefined, member: Node): boolean =>
  node !== undefined &&
  node !== member &&
  (isFunctionTypeNode(node) ||
    isCallSignatureDeclaration(node) ||
    isReturnedBySignature(node.parent, member));

const declaredCallee = (declared: Node | undefined) => {
  const member = signatureOwnerOf(declared);
  const isCalleeDeclaration =
    member !== undefined &&
    (isMethodDeclaration(member) ||
      isMethodSignatureDeclaration(member) ||
      isPropertySignatureDeclaration(member) ||
      isPropertyAssignment(member) ||
      isFunctionDeclaration(member) ||
      isVariableDeclaration(member));
  const name = isCalleeDeclaration ? member.name : undefined;
  if (member === undefined) {
    return;
  }
  if (name === undefined) {
    return;
  }
  if (!isIdentifier(name)) {
    return;
  }
  const owner = member.parent;
  const isNamedClassOrInterface =
    (isClassDeclaration(owner) || isInterfaceDeclaration(owner)) && owner.name !== undefined;
  return {
    declaration: member,
    name: name.text,
    className: isNamedClassOrInterface ? owner.name.text : undefined,
    returnedBySignature: isReturnedBySignature(declared?.parent, member),
  };
};

export const packageCalleeOf = (
  checker: Checker,
  projectDirectory: string,
  call: CallExpression,
  isWantedDeclarationFile: (file: string) => boolean,
) =>
  Effect.gen(function* () {
    const signature = yield* typeScriptRequest("resolve a call signature", () =>
      checker.getResolvedSignature(call),
    );
    const declaration = signature?.declaration;
    const file =
      declaration === undefined ? undefined : packageFileOf(projectDirectory, declaration.path);
    if (declaration === undefined) {
      return;
    }
    if (file === undefined) {
      return;
    }
    if (!isWantedDeclarationFile(file)) {
      return;
    }
    const declared = yield* typeScriptRequest("read a call's declaration", () =>
      declaration.resolve(),
    );
    const named = declaredCallee(declared);
    return named === undefined ? undefined : { call, file, ...named };
  });

const isAnyPackageFile = () => true;

const listPackageCalleesIn = (
  checker: Checker,
  projectDirectory: string,
  sourceFile: SourceFile,
) => {
  const calleeOf = (call: CallExpression) =>
    packageCalleeOf(checker, projectDirectory, call, isAnyPackageFile).pipe(
      Effect.map((callee) => (callee === undefined ? [] : [callee])),
    );
  return Effect.suspend(() =>
    Effect.forEach(callsIn(sourceFile), calleeOf, {
      concurrency: CONCURRENT_TYPESCRIPT_REQUESTS,
    }),
  ).pipe(Effect.map((callees) => callees.flat()));
};

const PACKAGE_CALLEES_BY_FILE = new WeakMap<SourceFile, ReturnType<typeof listPackageCalleesIn>>();

export const packageCalleesIn = (
  checker: Checker,
  projectDirectory: string,
  sourceFile: SourceFile,
) =>
  Effect.gen(function* () {
    const cachedCallees =
      PACKAGE_CALLEES_BY_FILE.get(sourceFile) ??
      (yield* Effect.cached(listPackageCalleesIn(checker, projectDirectory, sourceFile)));
    PACKAGE_CALLEES_BY_FILE.set(sourceFile, cachedCallees);
    return yield* cachedCallees;
  });

export const openTypeScriptProjects = (
  projectFile: string,
  sourceTextOverrides: ReadonlyMap<string, string> = new Map(),
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const projectDirectory = path.dirname(yield* absolutePathOf(projectFile));
    const configFiles = yield* projectConfigFiles(projectFile);
    const opened = yield* openedPrograms(configFiles, sourceTextOverrides);
    const { packageFiles } = yield* compiledFilesOf(projectFile, Arrays.zip(configFiles, opened));
    const projects = opened.map(({ program, checker }) => ({
      program,
      checker,
      sourceFiles: new Array<{ readonly sourceFile: SourceFile; readonly displayName: string }>(),
    }));
    for (const displayName of packageFiles.filter((file) => !isDeclarationFile(file))) {
      const fileName = path.resolve(projectDirectory, displayName);
      const candidates = yield* Effect.forEach(projects, (project) =>
        typeScriptRequest("read a source file", () => project.program.getSourceFile(fileName)).pipe(
          Effect.map((sourceFile) => ({ project, sourceFile })),
        ),
      );
      const owned = candidates.find(
        ({ sourceFile }) => sourceFile !== undefined && !sourceFile.isDeclarationFile,
      );
      if (owned?.sourceFile === undefined) {
        return yield* new TypeScriptApiFailed({
          operation: "read a source file",
          reason: `${displayName} is in no project`,
        });
      }
      owned.project.sourceFiles.push({ sourceFile: owned.sourceFile, displayName });
    }
    const owned = new Set(yield* ownedFilesAmong(projectDirectory, packageFiles));
    return projects.map(({ program, checker, sourceFiles }) => ({
      program,
      checker,
      allSourceFiles: sourceFiles,
      sourceFiles: sourceFiles.filter(({ displayName }) => owned.has(displayName)),
    }));
  });
