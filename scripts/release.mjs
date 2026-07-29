#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const MANIFEST_PATH = path.join("extension", "manifest.json");
const RELEASE_WORKFLOW = "release.yml";
const RELEASE_ASSET = "extension.zip";
const RELEASE_BRANCH = "main";
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BUMP_KINDS = new Set(["patch", "minor", "major"]);
const ACTIVE_RUN_STATES = new Set([
  "action_required",
  "in_progress",
  "pending",
  "queued",
  "requested",
  "waiting",
]);

class ReleaseError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ReleaseError";
  }
}

class CommandError extends ReleaseError {
  constructor(command, args, result) {
    const details = result.stderr.trim() || result.stdout.trim();
    super(
      `Command failed (${result.code}): ${formatCommand(command, args)}` +
        (details ? `\n${details}` : ""),
    );
    this.command = command;
    this.args = args;
    this.result = result;
  }
}

export function parseVersion(value) {
  const match = VERSION_PATTERN.exec(String(value));
  if (!match) {
    throw new ReleaseError(
      `Expected a three-part numeric version, received: ${value}`,
    );
  }

  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) {
    throw new ReleaseError(`Version is outside the safe integer range: ${value}`);
  }

  return {
    major: parts[0],
    minor: parts[1],
    patch: parts[2],
  };
}

export function bumpVersion(version, bumpKind) {
  if (!BUMP_KINDS.has(bumpKind)) {
    throw new ReleaseError(`Unsupported version bump: ${bumpKind}`);
  }

  const parsed = parseVersion(version);
  if (bumpKind === "major") {
    return `${parsed.major + 1}.0.0`;
  }
  if (bumpKind === "minor") {
    return `${parsed.major}.${parsed.minor + 1}.0`;
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
}

export function versionFromTag(tag) {
  if (typeof tag !== "string" || !tag.startsWith("v")) {
    throw new ReleaseError(`Expected a release tag beginning with "v": ${tag}`);
  }
  const version = tag.slice(1);
  parseVersion(version);
  return version;
}

export function tagFromVersion(version) {
  parseVersion(version);
  return `v${version}`;
}

export function parseGitHubRepo(remoteUrl) {
  const value = String(remoteUrl).trim();
  const scpMatch = /^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/.exec(value);
  if (scpMatch) {
    return scpMatch[1];
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ReleaseError(
      `The origin remote is not a recognized GitHub URL: ${remoteUrl}`,
    );
  }

  if (parsed.hostname !== "github.com") {
    throw new ReleaseError(
      `The origin remote is not hosted on github.com: ${remoteUrl}`,
    );
  }

  const repo = parsed.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  if (repo.split("/").length !== 2) {
    throw new ReleaseError(
      `Could not determine OWNER/REPO from origin: ${remoteUrl}`,
    );
  }
  return repo;
}

export function hasReleaseAsset(release, assetName = RELEASE_ASSET) {
  if (!release) {
    return false;
  }
  return release.assets.some((asset) => {
    if (typeof asset === "string") {
      return asset === assetName;
    }
    return asset?.name === assetName;
  });
}

export function determineReleaseTarget({
  manifestVersion,
  latestPublishedTag,
  manifestRelease,
  bumpKind,
}) {
  parseVersion(manifestVersion);
  const latestVersion = versionFromTag(latestPublishedTag);
  const manifestTag = tagFromVersion(manifestVersion);
  const expectedVersion = bumpVersion(latestVersion, bumpKind);

  if (manifestRelease && manifestRelease.tagName !== manifestTag) {
    throw new ReleaseError(
      `Release lookup returned ${manifestRelease.tagName}, expected ${manifestTag}.`,
    );
  }

  const releaseIncomplete =
    manifestRelease &&
    (manifestRelease.isDraft || !hasReleaseAsset(manifestRelease));

  if (releaseIncomplete) {
    const publishedMissingAsset =
      !manifestRelease.isDraft && latestPublishedTag === manifestTag;
    if (!publishedMissingAsset && manifestVersion !== expectedVersion) {
      throw new ReleaseError(
        `The incomplete ${manifestTag} release does not match the requested ` +
          `${bumpKind} target ${tagFromVersion(expectedVersion)}.`,
      );
    }

    return {
      targetVersion: manifestVersion,
      targetTag: manifestTag,
      alreadyBumped: true,
      resume: true,
    };
  }

  if (
    manifestRelease &&
    hasReleaseAsset(manifestRelease) &&
    latestPublishedTag !== manifestTag
  ) {
    throw new ReleaseError(
      `${manifestTag} is published, but the latest release is ${latestPublishedTag}.`,
    );
  }

  if (
    manifestVersion !== latestVersion &&
    manifestVersion !== expectedVersion
  ) {
    throw new ReleaseError(
      `Manifest version ${manifestVersion} must equal either the latest release ` +
        `${latestVersion} or the requested ${bumpKind} target ${expectedVersion}.`,
    );
  }

  return {
    targetVersion: expectedVersion,
    targetTag: tagFromVersion(expectedVersion),
    alreadyBumped: manifestVersion === expectedVersion,
    resume: false,
  };
}

export function validateReleaseTag(tag, manifestVersion) {
  const expectedTag = tagFromVersion(manifestVersion);
  if (tag !== expectedTag) {
    throw new ReleaseError(
      `Release tag ${tag} does not match manifest version ${manifestVersion} ` +
        `(expected ${expectedTag}).`,
    );
  }
  return true;
}

function releaseNoteSentence(subject) {
  let sentence = subject.trim().replace(/^[-*]\s+/, "");
  if (!sentence) {
    return "";
  }
  sentence = sentence[0].toUpperCase() + sentence.slice(1);
  if (!/[.!?`]$/.test(sentence)) {
    sentence += ".";
  }
  return sentence;
}

export function formatReleaseNotes(subjects, { repo, fromTag, toTag }) {
  const seen = new Set();
  const bullets = [];

  for (const subject of subjects) {
    if (
      /^chore\(release\):\s*v?\d+\.\d+\.\d+/i.test(subject.trim()) ||
      /^chore:\s*(?:release|bump).*v?\d+\.\d+\.\d+/i.test(subject.trim()) ||
      /^bump\s+(?:extension\s+)?version\s+(?:to\s+)?v?\d+\.\d+\.\d+/i.test(
        subject.trim(),
      )
    ) {
      continue;
    }
    const sentence = releaseNoteSentence(subject);
    if (!sentence || seen.has(sentence)) {
      continue;
    }
    seen.add(sentence);
    bullets.push(`- ${sentence}`);
  }

  if (bullets.length === 0) {
    throw new ReleaseError(
      `No release-note entries were found in ${fromTag}..HEAD.`,
    );
  }

  const compareUrl = `https://github.com/${repo}/compare/${fromTag}...${toTag}`;
  return `## Changes\n\n${bullets.join("\n")}\n\n**Full Changelog**: ${compareUrl}\n`;
}

export function splitCommandLine(value) {
  const parts = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (const character of String(value)) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }

  if (escaped || quote) {
    throw new ReleaseError(`Could not parse editor command: ${value}`);
  }
  if (current) {
    parts.push(current);
  }
  if (parts.length === 0) {
    throw new ReleaseError("Editor command is empty.");
  }
  return parts;
}

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) {
    return text;
  }
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function formatCommand(command, args) {
  return [command, ...args].map(shellQuote).join(" ");
}

async function runCommand(
  command,
  args,
  {
    allowFailure = false,
    capture = false,
    cwd = process.cwd(),
    env = {},
  } = {},
) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });

    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }

    child.on("error", reject);
    child.on("close", (code, signal) => {
      const result = {
        code: code ?? 1,
        signal,
        stdout,
        stderr,
      };
      if (result.code !== 0 && !allowFailure) {
        reject(new CommandError(command, args, result));
        return;
      }
      resolve(result);
    });
  });
}

async function captureCommand(command, args, options = {}) {
  const result = await runCommand(command, args, {
    ...options,
    capture: true,
  });
  return result.stdout.trim();
}

async function readManifest(root) {
  const manifestFile = path.join(root, MANIFEST_PATH);
  const raw = await readFile(manifestFile, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw new ReleaseError(`Could not parse ${MANIFEST_PATH}.`, {
      cause: error,
    });
  }
  parseVersion(manifest.version);
  return {
    file: manifestFile,
    manifest,
    raw,
  };
}

async function updateManifestVersion(manifestState, nextVersion) {
  const versionField = /("version"\s*:\s*")([^"]+)(")/g;
  const matches = [...manifestState.raw.matchAll(versionField)];
  if (matches.length !== 1) {
    throw new ReleaseError(
      `${MANIFEST_PATH} must contain exactly one JSON version field.`,
    );
  }

  const nextRaw = manifestState.raw.replace(
    versionField,
    (_match, prefix, _previousVersion, suffix) =>
      `${prefix}${nextVersion}${suffix}`,
  );
  const parsed = JSON.parse(nextRaw);
  if (parsed.version !== nextVersion) {
    throw new ReleaseError(`Failed to update ${MANIFEST_PATH} safely.`);
  }
  await writeFile(manifestState.file, nextRaw, "utf8");
  return nextRaw;
}

function normalizeRelease(json) {
  return {
    ...json,
    assets: Array.isArray(json.assets) ? json.assets : [],
  };
}

function isMissingRelease(result) {
  const message = `${result.stdout}\n${result.stderr}`;
  return /release not found|HTTP 404|Not Found/i.test(message);
}

function isWorkflowUnavailable(result) {
  const message = `${result.stdout}\n${result.stderr}`;
  return /HTTP 404|HTTP 422|workflow.*not found|does not have.*workflow_dispatch/i.test(
    message,
  );
}

async function tryGetRelease(repo, tag) {
  const result = await runCommand(
    "gh",
    [
      "release",
      "view",
      tag,
      "--repo",
      repo,
      "--json",
      "tagName,isDraft,isPrerelease,assets,url,body,publishedAt",
    ],
    { allowFailure: true, capture: true },
  );
  if (result.code === 0) {
    return normalizeRelease(JSON.parse(result.stdout));
  }
  if (isMissingRelease(result)) {
    return null;
  }
  throw new CommandError("gh", ["release", "view", tag], result);
}

async function getLatestPublishedRelease(repo) {
  const json = await captureCommand("gh", [
    "release",
    "view",
    "--repo",
    repo,
    "--json",
    "tagName,isDraft,isPrerelease,assets,url,body,publishedAt",
  ]);
  return normalizeRelease(JSON.parse(json));
}

async function getCommitSubjects(fromTag) {
  const output = await captureCommand("git", [
    "log",
    "--reverse",
    "--format=%s",
    `${fromTag}..HEAD`,
  ]);
  return output ? output.split("\n") : [];
}

async function runReleaseChecks(root) {
  console.log("\nRunning release checks...");
  const testFiles = (
    await captureCommand("git", ["ls-files", "test/*.test.mjs"], { cwd: root })
  )
    .split("\n")
    .filter(Boolean);
  if (testFiles.length === 0) {
    throw new ReleaseError("No test files were found.");
  }
  await runCommand(process.execPath, ["--test", ...testFiles], { cwd: root });

  const extensionFiles = (
    await captureCommand("git", ["ls-files", "extension/*.js"], { cwd: root })
  )
    .split("\n")
    .filter(Boolean);
  for (const file of extensionFiles) {
    await runCommand(process.execPath, ["--check", file], {
      capture: true,
      cwd: root,
    });
  }
  await runCommand("git", ["diff", "--check"], { capture: true, cwd: root });
  await runCommand("git", ["diff", "--check", "origin/main..HEAD"], {
    capture: true,
    cwd: root,
  });
}

async function askYesNo(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new ReleaseError(
      "Interactive confirmation requires a terminal. Use --yes only after " +
        "completing the live smoke test and reviewing the release plan.",
    );
  }
  const reader = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await reader.question(`${question} [y/N] `))
      .trim()
      .toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    reader.close();
  }
}

async function editReleaseNotes(notes) {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), "sync-for-zotero-release-notes-"),
  );
  const notesFile = path.join(tempDirectory, "release-notes.md");
  try {
    await writeFile(notesFile, notes, "utf8");
    let editor = process.env.VISUAL || process.env.EDITOR;
    if (!editor) {
      const result = await runCommand("git", ["var", "GIT_EDITOR"], {
        allowFailure: true,
        capture: true,
      });
      editor = result.code === 0 ? result.stdout.trim() : "vi";
    }
    const [command, ...args] = splitCommandLine(editor || "vi");
    await runCommand(command, [...args, notesFile]);
    const edited = await readFile(notesFile, "utf8");
    if (!edited.trim()) {
      throw new ReleaseError("Release notes cannot be empty.");
    }
    return edited.endsWith("\n") ? edited : `${edited}\n`;
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function withNotesFile(notes, callback) {
  const tempDirectory = await mkdtemp(
    path.join(os.tmpdir(), "sync-for-zotero-release-"),
  );
  const notesFile = path.join(tempDirectory, "release-notes.md");
  try {
    await writeFile(notesFile, notes, "utf8");
    return await callback(notesFile);
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

async function tagCommit(tag) {
  const result = await runCommand(
    "git",
    ["rev-parse", "--verify", `${tag}^{commit}`],
    { allowFailure: true, capture: true },
  );
  if (result.code === 0) {
    return result.stdout.trim();
  }
  if (
    /unknown revision|Needed a single revision|not a valid object/i.test(
      result.stderr,
    )
  ) {
    return null;
  }
  throw new CommandError("git", ["rev-parse", `${tag}^{commit}`], result);
}

async function ensureTagAtHead(tag) {
  const head = await captureCommand("git", ["rev-parse", "HEAD"]);
  const existingCommit = await tagCommit(tag);
  if (existingCommit && existingCommit !== head) {
    throw new ReleaseError(
      `${tag} already points to ${existingCommit}, but HEAD is ${head}.`,
    );
  }
  if (!existingCommit) {
    await runCommand("git", ["tag", "-a", tag, "-m", tag, "HEAD"]);
  }
}

async function listWorkflowRuns(repo, tag) {
  const args = [
    "run",
    "list",
    "--repo",
    repo,
    "--workflow",
    RELEASE_WORKFLOW,
    "--event",
    "workflow_dispatch",
    "--limit",
    "30",
    "--json",
    "databaseId,displayTitle,headBranch,status,conclusion,url,createdAt",
  ];
  const result = await runCommand("gh", args, {
    allowFailure: true,
    capture: true,
  });
  if (result.code !== 0) {
    if (isWorkflowUnavailable(result)) {
      return [];
    }
    throw new CommandError("gh", args, result);
  }
  const runs = JSON.parse(result.stdout);
  return runs
    .filter(
      (run) =>
        run.headBranch === tag || run.displayTitle === `Release ${tag}`,
    )
    .sort((left, right) => right.databaseId - left.databaseId);
}

async function dispatchWorkflow(repo, tag) {
  const args = [
    "workflow",
    "run",
    RELEASE_WORKFLOW,
    "--repo",
    repo,
    "--ref",
    tag,
    "--raw-field",
    `tag=${tag}`,
  ];
  let lastResult;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    lastResult = await runCommand("gh", args, {
      allowFailure: true,
      capture: true,
    });
    if (lastResult.code === 0) {
      return lastResult.stdout.trim();
    }
    if (!isWorkflowUnavailable(lastResult)) {
      throw new CommandError("gh", args, lastResult);
    }
    console.log("Waiting for GitHub to index the updated release workflow...");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  throw new CommandError("gh", args, lastResult);
}

async function waitForDispatchedRun(repo, tag, startedAt) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const runs = await listWorkflowRuns(repo, tag);
    const run = runs.find(
      (candidate) =>
        new Date(candidate.createdAt).getTime() >= startedAt - 30_000,
    );
    if (run) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  throw new ReleaseError(
    `GitHub accepted the ${tag} workflow dispatch, but its run could not be found.`,
  );
}

async function dispatchOrResumeWorkflow(repo, tag) {
  const runs = await listWorkflowRuns(repo, tag);
  let run = runs.find((candidate) => ACTIVE_RUN_STATES.has(candidate.status));

  if (run) {
    console.log(`Resuming active workflow run: ${run.url}`);
  } else {
    console.log(`Dispatching ${RELEASE_WORKFLOW} for ${tag}...`);
    const startedAt = Date.now();
    const dispatchOutput = await dispatchWorkflow(repo, tag);
    const runUrl = dispatchOutput.match(
      /https:\/\/github\.com\/\S+\/actions\/runs\/\d+/,
    )?.[0];
    if (runUrl) {
      run = {
        databaseId: Number(runUrl.split("/").at(-1)),
        url: runUrl,
      };
    } else {
      run = await waitForDispatchedRun(repo, tag, startedAt);
    }
  }

  console.log(`Watching workflow run: ${run.url}`);
  await runCommand("gh", [
    "run",
    "watch",
    String(run.databaseId),
    "--repo",
    repo,
    "--compact",
    "--exit-status",
  ]);
}

async function waitForReleaseAsset(repo, tag) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const release = await tryGetRelease(repo, tag);
    if (hasReleaseAsset(release)) {
      return release;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new ReleaseError(
    `${tag} finished its workflow, but ${RELEASE_ASSET} was not attached.`,
  );
}

function printUsage() {
  console.log(`Usage:
  npm run release:patch
  npm run release:minor
  npm run release:major
  npm run release -- <patch|minor|major> [options]

Options:
  --dry-run            Validate and print the release plan without changing anything
  --edit-notes         Open the generated release notes in your configured editor
  --notes-file <path>  Use release notes from an existing Markdown file
  --yes                Skip confirmations; implies that live smoke testing passed
  --help               Show this help
`);
}

function parseReleaseArguments(argv) {
  const [bumpKind, ...rest] = argv;
  if (!BUMP_KINDS.has(bumpKind)) {
    throw new ReleaseError(
      `Choose one version bump: patch, minor, or major. Received: ${bumpKind ?? "(none)"}`,
    );
  }

  const options = {
    dryRun: false,
    editNotes: false,
    notesFile: null,
    yes: false,
  };

  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--edit-notes") {
      options.editNotes = true;
    } else if (argument === "--yes") {
      options.yes = true;
    } else if (argument === "--notes-file") {
      const notesFile = rest[index + 1];
      if (!notesFile) {
        throw new ReleaseError("--notes-file requires a path.");
      }
      options.notesFile = notesFile;
      index += 1;
    } else {
      throw new ReleaseError(`Unknown release option: ${argument}`);
    }
  }

  if (options.editNotes && options.notesFile) {
    throw new ReleaseError("Use either --edit-notes or --notes-file, not both.");
  }
  return { bumpKind, options };
}

async function validateTagCommand(tag) {
  if (!tag) {
    throw new ReleaseError("validate-tag requires a release tag.");
  }
  const root = await captureCommand("git", ["rev-parse", "--show-toplevel"]);
  const { manifest } = await readManifest(root);
  validateReleaseTag(tag, manifest.version);
  const [head, releaseCommit] = await Promise.all([
    captureCommand("git", ["rev-parse", "HEAD"]),
    tagCommit(tag),
  ]);
  if (!releaseCommit) {
    throw new ReleaseError(`Release tag ${tag} is not present in this checkout.`);
  }
  if (releaseCommit !== head) {
    throw new ReleaseError(
      `Release tag ${tag} points to ${releaseCommit}, but the workflow checked out ${head}.`,
    );
  }
  console.log(`${tag} matches ${MANIFEST_PATH} version ${manifest.version}.`);
}

async function releaseCommand(bumpKind, options) {
  const invocationDirectory = process.cwd();
  const notesFilePath = options.notesFile
    ? path.resolve(invocationDirectory, options.notesFile)
    : null;
  const root = await captureCommand("git", ["rev-parse", "--show-toplevel"]);
  process.chdir(root);

  const initialStatus = await captureCommand("git", [
    "status",
    "--porcelain=v1",
  ]);
  if (initialStatus) {
    throw new ReleaseError(
      "The working tree must be clean before a release.\n" + initialStatus,
    );
  }

  const branch = await captureCommand("git", ["branch", "--show-current"]);
  if (branch !== RELEASE_BRANCH) {
    throw new ReleaseError(
      `Releases must run from ${RELEASE_BRANCH}; current branch is ${branch || "(detached)"}.`,
    );
  }

  const remoteUrl = await captureCommand("git", [
    "remote",
    "get-url",
    "origin",
  ]);
  const repo = parseGitHubRepo(remoteUrl);

  await runCommand("gh", ["auth", "status", "--hostname", "github.com"], {
    capture: true,
  });
  console.log("Refreshing origin/main and release tags...");
  await runCommand("git", ["fetch", "origin", RELEASE_BRANCH, "--tags"]);

  const divergence = (
    await captureCommand("git", [
      "rev-list",
      "--left-right",
      "--count",
      `origin/${RELEASE_BRANCH}...HEAD`,
    ])
  )
    .split(/\s+/)
    .map(Number);
  const [behind, ahead] = divergence;
  if (!Number.isInteger(behind) || !Number.isInteger(ahead)) {
    throw new ReleaseError("Could not determine branch divergence.");
  }
  if (behind > 0) {
    throw new ReleaseError(
      `Local ${RELEASE_BRANCH} is ${behind} commit(s) behind origin/${RELEASE_BRANCH}.`,
    );
  }

  const manifestState = await readManifest(root);
  const manifestTag = tagFromVersion(manifestState.manifest.version);
  const [latestRelease, manifestRelease] = await Promise.all([
    getLatestPublishedRelease(repo),
    tryGetRelease(repo, manifestTag),
  ]);
  const decision = determineReleaseTarget({
    manifestVersion: manifestState.manifest.version,
    latestPublishedTag: latestRelease.tagName,
    manifestRelease,
    bumpKind,
  });

  let targetRelease =
    decision.targetTag === manifestTag
      ? manifestRelease
      : await tryGetRelease(repo, decision.targetTag);
  if (
    targetRelease &&
    !targetRelease.isDraft &&
    hasReleaseAsset(targetRelease) &&
    decision.targetTag !== latestRelease.tagName
  ) {
    throw new ReleaseError(`${decision.targetTag} is already published.`);
  }

  const existingTagCommit = await tagCommit(decision.targetTag);
  const head = await captureCommand("git", ["rev-parse", "HEAD"]);
  if (existingTagCommit && !decision.alreadyBumped) {
    throw new ReleaseError(
      `${decision.targetTag} already exists, but ${MANIFEST_PATH} still needs ` +
        `to be updated to ${decision.targetVersion}.`,
    );
  }
  if (existingTagCommit && existingTagCommit !== head) {
    throw new ReleaseError(
      `${decision.targetTag} already points to ${existingTagCommit}, not HEAD ${head}.`,
    );
  }

  await runReleaseChecks(root);

  let notes;
  if (notesFilePath) {
    notes = await readFile(notesFilePath, "utf8");
    if (!notes.trim()) {
      throw new ReleaseError("The release-notes file is empty.");
    }
  } else if (targetRelease?.body?.trim()) {
    notes = targetRelease.body.endsWith("\n")
      ? targetRelease.body
      : `${targetRelease.body}\n`;
  } else {
    const subjects = await getCommitSubjects(latestRelease.tagName);
    notes = formatReleaseNotes(subjects, {
      repo,
      fromTag: latestRelease.tagName,
      toTag: decision.targetTag,
    });
  }

  if (options.editNotes && !options.dryRun) {
    notes = await editReleaseNotes(notes);
  } else if (
    !options.yes &&
    !options.notesFile &&
    !options.dryRun &&
    (await askYesNo("Edit the generated release notes before continuing?"))
  ) {
    notes = await editReleaseNotes(notes);
  }

  console.log(`
Release plan
  Repository:       ${repo}
  Branch:           ${RELEASE_BRANCH} (${ahead} local commit(s) ahead)
  Latest release:   ${latestRelease.tagName}
  Target release:   ${decision.targetTag}
  Manifest update:  ${decision.alreadyBumped ? "already complete" : `${manifestState.manifest.version} -> ${decision.targetVersion}`}
  Resume:           ${decision.resume || Boolean(targetRelease) ? "yes" : "no"}

Release notes
${notes.trim()}
`);

  if (options.dryRun) {
    console.log(
      "Dry run complete. No commit, tag, push, workflow, or release was created.",
    );
    return;
  }

  if (!options.yes) {
    const smokePassed = await askYesNo(
      "Has the live Zotero → browser → WebChat smoke test passed for this exact HEAD?",
    );
    if (!smokePassed) {
      throw new ReleaseError(
        "Release cancelled: live smoke testing was not confirmed.",
      );
    }
    const confirmed = await askYesNo(
      `Create and publish ${decision.targetTag} using the plan above?`,
    );
    if (!confirmed) {
      throw new ReleaseError("Release cancelled.");
    }
  }

  let manifestUpdated = false;
  if (!decision.alreadyBumped) {
    console.log(`Updating ${MANIFEST_PATH} to ${decision.targetVersion}...`);
    try {
      await updateManifestVersion(manifestState, decision.targetVersion);
      await runCommand("git", ["add", "--", MANIFEST_PATH]);
      await runCommand("git", [
        "commit",
        "-m",
        `chore(release): ${decision.targetTag}`,
      ]);
      manifestUpdated = true;
    } catch (error) {
      await writeFile(manifestState.file, manifestState.raw, "utf8");
      await runCommand("git", ["add", "--", MANIFEST_PATH], {
        allowFailure: true,
        capture: true,
      });
      throw error;
    }
  }

  try {
    await ensureTagAtHead(decision.targetTag);
    console.log(
      `Pushing ${RELEASE_BRANCH} and ${decision.targetTag} atomically...`,
    );
    await runCommand("git", [
      "push",
      "--atomic",
      "origin",
      `HEAD:refs/heads/${RELEASE_BRANCH}`,
      `refs/tags/${decision.targetTag}`,
    ]);
  } catch (error) {
    const recovery = manifestUpdated
      ? `The version commit remains local; rerun the same command after fixing the error.`
      : `Rerun the same command after fixing the error.`;
    throw new ReleaseError(`${error.message}\n${recovery}`, { cause: error });
  }

  targetRelease = await tryGetRelease(repo, decision.targetTag);
  if (!targetRelease) {
    console.log(`Creating draft release ${decision.targetTag}...`);
    await withNotesFile(notes, async (notesFile) => {
      await runCommand("gh", [
        "release",
        "create",
        decision.targetTag,
        "--repo",
        repo,
        "--draft",
        "--verify-tag",
        "--title",
        decision.targetTag,
        "--notes-file",
        notesFile,
      ]);
    });
    targetRelease = await tryGetRelease(repo, decision.targetTag);
  } else if (options.notesFile || options.editNotes) {
    await withNotesFile(notes, async (notesFile) => {
      await runCommand("gh", [
        "release",
        "edit",
        decision.targetTag,
        "--repo",
        repo,
        "--notes-file",
        notesFile,
      ]);
    });
    targetRelease = await tryGetRelease(repo, decision.targetTag);
  }

  if (!hasReleaseAsset(targetRelease)) {
    await dispatchOrResumeWorkflow(repo, decision.targetTag);
    targetRelease = await waitForReleaseAsset(repo, decision.targetTag);
  }

  if (targetRelease.isDraft) {
    console.log(
      `Publishing ${decision.targetTag} after artifact verification...`,
    );
    await runCommand("gh", [
      "release",
      "edit",
      decision.targetTag,
      "--repo",
      repo,
      "--draft=false",
    ]);
  }

  const finalRelease = await tryGetRelease(repo, decision.targetTag);
  if (!finalRelease || finalRelease.isDraft || !hasReleaseAsset(finalRelease)) {
    throw new ReleaseError(
      `${decision.targetTag} did not reach a published state with ${RELEASE_ASSET}.`,
    );
  }
  console.log(`\nReleased ${decision.targetTag}: ${finalRelease.url}`);
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return;
  }
  if (argv[0] === "validate-tag") {
    await validateTagCommand(argv[1]);
    return;
  }
  const { bumpKind, options } = parseReleaseArguments(argv);
  await releaseCommand(bumpKind, options);
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : null;
const modulePath = realpathSync(fileURLToPath(import.meta.url));
if (invokedPath === modulePath) {
  main().catch((error) => {
    const message =
      error instanceof Error ? error.message : `Unknown release error: ${error}`;
    console.error(`\nRelease stopped safely.\n${message}`);
    process.exitCode = 1;
  });
}
