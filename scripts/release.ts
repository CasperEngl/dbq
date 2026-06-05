#!/usr/bin/env bun
import { Args, Command as CliCommand, Options } from "@effect/cli";
import { Command as ProcessCommand } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Cause, Console, Effect, Schema } from "effect";
import packageJson from "../package.json" with { type: "json" };

const rootDirectory = fileURLToPath(new URL("..", import.meta.url));
const distDirectory = join(rootDirectory, "dist");
const packageDirectory = join(distDirectory, "package");
const packageJsonPath = join(rootDirectory, "package.json");
const changelogPath = join(rootDirectory, "CHANGELOG.md");
const formulaPath = join(rootDirectory, "homebrew/dbq.rb");
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

class ReleaseError extends Schema.TaggedError<ReleaseError>()("ReleaseError", {
  message: Schema.String,
}) {}

type Version = {
  major: number;
  minor: number;
  patch: number;
};

const versionSpecArg = Args.text({ name: "version" }).pipe(
  Args.withDescription("patch, minor, major, x.y.z, or vx.y.z"),
);
const versionArg = Args.text({ name: "version" }).pipe(
  Args.withDescription("Release version as x.y.z or vx.y.z"),
);
const pushOption = Options.boolean("push").pipe(
  Options.withDescription("Push the created commit and tag after local release preparation"),
);
const noCommitOption = Options.boolean("no-commit").pipe(
  Options.withDescription("Update the Homebrew formula without creating a git commit"),
);

const buildCommand = CliCommand.make("build", {}, () => buildRelease()).pipe(
  CliCommand.withDescription("Build the release archive"),
);

const createCommand = CliCommand.make(
  "create",
  {
    versionSpec: versionSpecArg,
    push: pushOption,
  },
  ({ push, versionSpec }) => createRelease(versionSpec, push),
).pipe(CliCommand.withDescription("Create a release commit and annotated tag"));

const homebrewCommand = CliCommand.make(
  "homebrew",
  {
    version: versionArg,
    noCommit: noCommitOption,
    push: pushOption,
  },
  ({ noCommit, push, version }) => updateHomebrewFormula(version, !noCommit, push),
).pipe(CliCommand.withDescription("Update the Homebrew formula from the published asset"));

const notesCommand = CliCommand.make(
  "notes",
  {
    version: versionArg,
  },
  ({ version }) =>
    Effect.gen(function* () {
      const notes = yield* releaseNotes(formatVersion(yield* parseVersion(version)));
      yield* Console.log(notes);
    }),
).pipe(CliCommand.withDescription("Print changelog release notes for a version"));

const rootCommand = CliCommand.make("release", {}, () => Effect.void).pipe(
  CliCommand.withDescription("DBQ release tooling"),
  CliCommand.withSubcommands([buildCommand, createCommand, homebrewCommand, notesCommand]),
);

const runCli = rootCommand.pipe(
  CliCommand.run({
    name: "DBQ release",
    version: packageJson.version,
  }),
);

const createRelease = Effect.fn("createRelease")(function* (versionSpec: string, push: boolean) {
  yield* assertCleanWorktree("Release");

  const branch = yield* gitOutput(["rev-parse", "--abbrev-ref", "HEAD"]);
  const version = yield* prepareRelease(versionSpec);
  const tag = `v${version}`;

  yield* runInherited("bun", ["run", "check"]);

  const archivePath = yield* buildRelease();
  const packagePath = archivePath.replace(/\.tar\.gz$/, "");
  const cliVersion = yield* runOutput(join(packagePath, "bin/dbq"), ["--version"]);

  if (cliVersion !== version) {
    return yield* new ReleaseError({
      message: `Built CLI reports version ${cliVersion}, expected ${version}.`,
    });
  }

  const archiveSha = yield* sha256File(archivePath);

  yield* gitInherited(["add", "package.json", "CHANGELOG.md"]);
  yield* gitInherited(["commit", "-m", `Release ${tag}`]);
  yield* gitInherited(["tag", "-a", tag, "-m", tag]);

  yield* Console.log(
    [
      `Created release commit and tag ${tag}.`,
      "",
      "Archive:",
      `  ${archivePath}`,
      "",
      "Local archive SHA256:",
      `  ${archiveSha}`,
      "",
    ].join("\n"),
  );

  if (push) {
    yield* gitInherited(["push", "origin", branch, tag]);
    return;
  }

  yield* Console.log(
    [
      "Publish with:",
      `  git push origin ${branch} ${tag}`,
      "",
      "After the GitHub release asset is published, update the Homebrew formula with:",
      `  bun run release:homebrew -- ${tag}`,
    ].join("\n"),
  );
});

const buildRelease = Effect.fn("buildRelease")(function* () {
  const version = packageJson.version;
  const platform = process.platform;
  const arch = process.arch;
  const packageName = `dbq-v${version}-${platform}-${arch}`;
  const archivePath = join(distDirectory, `${packageName}.tar.gz`);
  const finalPackageDirectory = join(distDirectory, packageName);

  yield* removePath(distDirectory);
  yield* makeDirectory(join(packageDirectory, "bin"));

  yield* runInherited("bun", [
    "build",
    "--compile",
    "--outfile",
    join(packageDirectory, "bin/dbq"),
    join(rootDirectory, "src/index.ts"),
  ]);
  yield* runInherited("swiftc", [
    join(rootDirectory, "bin/confirm-query.swift"),
    "-o",
    join(packageDirectory, "bin/dbq-confirm"),
  ]);

  yield* installFile(
    join(rootDirectory, "bin/dbq-describe-postgres"),
    join(packageDirectory, "bin/dbq-describe-postgres"),
    0o755,
  );
  yield* installFile(
    join(rootDirectory, "install.sh"),
    join(packageDirectory, "install.sh"),
    0o755,
  );
  yield* installFile(
    join(rootDirectory, "config.example.toml"),
    join(packageDirectory, "config.example.toml"),
    0o644,
  );
  yield* installFile(join(rootDirectory, "README.md"), join(packageDirectory, "README.md"), 0o644);

  yield* renamePath(packageDirectory, finalPackageDirectory);
  yield* runInherited("tar", ["-czf", `${packageName}.tar.gz`, packageName], distDirectory);

  yield* Console.log(archivePath);
  return archivePath;
});

const prepareRelease = Effect.fn("prepareRelease")(function* (versionSpec: string) {
  const packageJson = yield* readJson(packageJsonPath);
  const currentVersion = yield* parseVersion(packageJson.version);
  const nextVersion = yield* resolveNextVersion(currentVersion, versionSpec);
  const version = formatVersion(nextVersion);
  const tag = `v${version}`;
  const existingTag = yield* gitOutput(["tag", "--list", tag]);

  if (existingTag.length > 0) {
    return yield* new ReleaseError({ message: `${tag} already exists.` });
  }

  yield* writeText(packageJsonPath, `${JSON.stringify({ ...packageJson, version }, null, 2)}\n`);
  yield* writeChangelogSection(version);

  return version;
});

const updateHomebrewFormula = Effect.fn("updateHomebrewFormula")(function* (
  versionInput: string,
  commit: boolean,
  push: boolean,
) {
  const version = formatVersion(yield* parseVersion(versionInput));
  const tag = `v${version}`;

  yield* assertCleanWorktree("Homebrew formula update");

  const repo = process.env.DBQ_REPO ?? "CasperEngl/dbq";
  const assetName = `dbq-v${version}-darwin-arm64.tar.gz`;
  const assetUrl = `https://github.com/${repo}/releases/download/${tag}/${assetName}`;
  const archiveBytes = yield* downloadBytes(assetUrl);
  const sha256 = sha256Bytes(archiveBytes);

  yield* updateFormula(version, sha256);

  if (commit) {
    yield* gitInherited(["add", "homebrew/dbq.rb"]);

    const diffExitCode = yield* processCommand("git", ["diff", "--cached", "--quiet"]).pipe(
      ProcessCommand.stderr("inherit"),
      ProcessCommand.exitCode,
    );

    if (diffExitCode === 1) {
      yield* gitInherited(["commit", "-m", `Update Homebrew formula for ${tag}`]);
    } else if (diffExitCode === 0) {
      yield* Console.log(`Homebrew formula already committed for ${tag}.`);
    } else {
      return yield* new ReleaseError({
        message: `git diff --cached --quiet exited with code ${diffExitCode}.`,
      });
    }
  }

  yield* Console.log(["Homebrew formula SHA256:", `  ${sha256}`].join("\n"));

  if (push) {
    const branch = yield* gitOutput(["rev-parse", "--abbrev-ref", "HEAD"]);
    yield* gitInherited(["push", "origin", branch]);
    return;
  }

  if (commit) {
    const branch = yield* gitOutput(["rev-parse", "--abbrev-ref", "HEAD"]);
    yield* Console.log(
      ["", "Publish the formula update with:", `  git push origin ${branch}`].join("\n"),
    );
  }
});

const writeChangelogSection = Effect.fn("writeChangelogSection")(function* (version: string) {
  const existingChangelog = yield* readTextIfExists(changelogPath, "# Changelog\n");

  if (existingChangelog.includes(`## v${version} `)) {
    return yield* new ReleaseError({
      message: `CHANGELOG.md already has a section for v${version}.`,
    });
  }

  const section = [
    `## v${version} - ${new Date().toISOString().slice(0, 10)}`,
    "",
    ...(yield* releaseBullets()),
    "",
  ].join("\n");
  const normalizedChangelog = existingChangelog.trimEnd();

  if (normalizedChangelog === "# Changelog") {
    yield* writeText(changelogPath, `# Changelog\n\n${section}`);
    return;
  }

  if (normalizedChangelog.startsWith("# Changelog\n\n")) {
    yield* writeText(
      changelogPath,
      normalizedChangelog.replace("# Changelog\n\n", `# Changelog\n\n${section}\n`),
    );
    return;
  }

  yield* writeText(changelogPath, `# Changelog\n\n${section}\n${normalizedChangelog}\n`);
});

const releaseBullets = Effect.fn("releaseBullets")(function* () {
  const previousTags = yield* gitOutput(["tag", "--list", "v[0-9]*", "--sort=-v:refname"]);
  const previousTag = previousTags.split("\n").filter(Boolean)[0];
  const range = previousTag ? `${previousTag}..HEAD` : "HEAD";
  const commits = (yield* gitOutput(["log", "--reverse", "--pretty=format:%s", range]))
    .split("\n")
    .filter(Boolean);

  if (commits.length === 0) {
    return ["- Maintenance release."];
  }

  return commits.map((subject) => `- ${subject}`);
});

const releaseNotes = Effect.fn("releaseNotes")(function* (version: string) {
  const changelog = yield* readTextIfExists(changelogPath, "");

  if (changelog.length === 0) {
    return `Release v${version}.`;
  }

  const lines = changelog.split("\n");
  const startIndex = lines.findIndex((line) => line.startsWith(`## v${version} `));

  if (startIndex === -1) {
    return `Release v${version}.`;
  }

  const endIndex = lines.findIndex((line, index) => index > startIndex && line.startsWith("## "));
  return lines
    .slice(startIndex, endIndex === -1 ? undefined : endIndex)
    .join("\n")
    .trim();
});

const updateFormula = Effect.fn("updateFormula")(function* (version: string, sha256: string) {
  const formula = yield* readText(formulaPath);
  const updatedFormula = formula
    .replace(/version "[^"]+"/, `version "${version}"`)
    .replace(/sha256 "[^"]+"/, `sha256 "${sha256}"`);

  if (updatedFormula === formula) {
    yield* Console.log("Homebrew formula already matches requested release.");
    return;
  }

  yield* writeText(formulaPath, updatedFormula);
  yield* Console.log(`Updated homebrew/dbq.rb to v${version}.`);
});

const assertCleanWorktree = Effect.fn("assertCleanWorktree")(function* (label: string) {
  const status = yield* gitOutput(["status", "--porcelain"]);

  if (status.length > 0) {
    return yield* new ReleaseError({
      message: `${label} requires a clean git worktree.`,
    });
  }
});

const runInherited = Effect.fn("runInherited")(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd = rootDirectory,
) {
  const exitCode = yield* processCommand(command, args, cwd).pipe(
    ProcessCommand.stdout("inherit"),
    ProcessCommand.stderr("inherit"),
    ProcessCommand.exitCode,
  );

  if (exitCode !== 0) {
    return yield* new ReleaseError({
      message: `${command} ${args.join(" ")} exited with code ${exitCode}.`,
    });
  }
});

const runOutput = Effect.fn("runOutput")(function* (
  command: string,
  args: ReadonlyArray<string>,
  cwd = rootDirectory,
) {
  return (yield* ProcessCommand.string(processCommand(command, args, cwd))).trim();
});

const gitOutput = (args: ReadonlyArray<string>) => runOutput("git", args);
const gitInherited = (args: ReadonlyArray<string>) => runInherited("git", args);

function processCommand(command: string, args: ReadonlyArray<string>, cwd = rootDirectory) {
  return ProcessCommand.make(command, ...args).pipe(ProcessCommand.workingDirectory(cwd));
}

const resolveNextVersion = Effect.fn("resolveNextVersion")(function* (
  currentVersion: Version,
  spec: string,
) {
  switch (spec) {
    case "patch":
      return { ...currentVersion, patch: currentVersion.patch + 1 };
    case "minor":
      return {
        major: currentVersion.major,
        minor: currentVersion.minor + 1,
        patch: 0,
      };
    case "major":
      return {
        major: currentVersion.major + 1,
        minor: 0,
        patch: 0,
      };
    default: {
      const explicitVersion = yield* parseVersion(spec);

      if (compareVersions(explicitVersion, currentVersion) < 0) {
        return yield* new ReleaseError({
          message: `${formatVersion(explicitVersion)} is lower than current version ${formatVersion(currentVersion)}.`,
        });
      }

      return explicitVersion;
    }
  }
});

const parseVersion = Effect.fn("parseVersion")(function* (value: string) {
  const normalizedVersion = value.replace(/^v/, "");
  const match = versionPattern.exec(normalizedVersion);

  if (!match) {
    return yield* new ReleaseError({ message: `Expected stable semver x.y.z, got ${value}.` });
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
});

function compareVersions(left: Version, right: Version) {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function formatVersion(version: Version) {
  return `${version.major}.${version.minor}.${version.patch}`;
}

const readText = Effect.fn("readText")(function* (path: string) {
  return yield* Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => new ReleaseError({ message: `Failed to read ${path}: ${String(cause)}` }),
  });
});

const readTextIfExists = Effect.fn("readTextIfExists")(function* (path: string, fallback: string) {
  return yield* readText(path).pipe(
    Effect.catchTag("ReleaseError", () => Effect.succeed(fallback)),
  );
});

const readJson = Effect.fn("readJson")(function* (path: string) {
  const text = yield* readText(path);

  return yield* Effect.try({
    try: () => JSON.parse(text),
    catch: (cause) => new ReleaseError({ message: `Failed to parse ${path}: ${String(cause)}` }),
  });
});

const writeText = Effect.fn("writeText")(function* (path: string, text: string) {
  yield* Effect.tryPromise({
    try: () => writeFile(path, text),
    catch: (cause) => new ReleaseError({ message: `Failed to write ${path}: ${String(cause)}` }),
  });
});

const removePath = Effect.fn("removePath")(function* (path: string) {
  yield* Effect.tryPromise({
    try: () => rm(path, { force: true, recursive: true }),
    catch: (cause) => new ReleaseError({ message: `Failed to remove ${path}: ${String(cause)}` }),
  });
});

const makeDirectory = Effect.fn("makeDirectory")(function* (path: string) {
  yield* Effect.tryPromise({
    try: () => mkdir(path, { recursive: true }),
    catch: (cause) => new ReleaseError({ message: `Failed to create ${path}: ${String(cause)}` }),
  });
});

const renamePath = Effect.fn("renamePath")(function* (from: string, to: string) {
  yield* Effect.tryPromise({
    try: () => rename(from, to),
    catch: (cause) =>
      new ReleaseError({ message: `Failed to move ${from} to ${to}: ${String(cause)}` }),
  });
});

const installFile = Effect.fn("installFile")(function* (from: string, to: string, mode: number) {
  yield* Effect.tryPromise({
    try: () => copyFile(from, to),
    catch: (cause) =>
      new ReleaseError({ message: `Failed to copy ${from} to ${to}: ${String(cause)}` }),
  });
  yield* Effect.tryPromise({
    try: () => chmod(to, mode),
    catch: (cause) => new ReleaseError({ message: `Failed to chmod ${to}: ${String(cause)}` }),
  });
});

const downloadBytes = Effect.fn("downloadBytes")(function* (url: string) {
  const response = yield* Effect.tryPromise({
    try: () => fetch(url),
    catch: (cause) => new ReleaseError({ message: `Failed to download ${url}: ${String(cause)}` }),
  });

  if (!response.ok) {
    return yield* new ReleaseError({
      message: `Failed to download ${url}: HTTP ${response.status}.`,
    });
  }

  return yield* Effect.tryPromise({
    try: async () => new Uint8Array(await response.arrayBuffer()),
    catch: (cause) => new ReleaseError({ message: `Failed to read ${url}: ${String(cause)}` }),
  });
});

const sha256File = Effect.fn("sha256File")(function* (path: string) {
  const bytes = yield* Effect.tryPromise({
    try: () => readFile(path),
    catch: (cause) => new ReleaseError({ message: `Failed to hash ${path}: ${String(cause)}` }),
  });
  return sha256Bytes(bytes);
});

function sha256Bytes(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

const exit = await Effect.runPromiseExit(runCli(Bun.argv).pipe(Effect.provide(BunContext.layer)));

if (exit._tag === "Failure") {
  console.error(Cause.pretty(exit.cause, { renderErrorCause: true }));
  process.exitCode = 1;
}
