import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  bumpVersion,
  determineReleaseTarget,
  formatReleaseNotes,
  parseGitHubRepo,
  parseVersion,
  splitCommandLine,
  validateReleaseTag,
  versionFromTag,
} from "../scripts/release.mjs";

test("computes semantic patch, minor, and major versions", () => {
  assert.equal(bumpVersion("0.0.10", "patch"), "0.0.11");
  assert.equal(bumpVersion("0.0.10", "minor"), "0.1.0");
  assert.equal(bumpVersion("0.9.4", "major"), "1.0.0");
});

test("rejects ambiguous or prerelease version strings", () => {
  for (const version of ["v0.0.10", "0.0", "01.0.0", "0.0.10-beta.1"]) {
    assert.throws(() => parseVersion(version), /three-part numeric version/);
  }
  assert.throws(() => versionFromTag("0.0.10"), /beginning with "v"/);
});

test("accepts GitHub SSH and HTTPS origin URLs", () => {
  assert.equal(
    parseGitHubRepo("git@github.com:yilewang/sync-for-zotero.git"),
    "yilewang/sync-for-zotero",
  );
  assert.equal(
    parseGitHubRepo("https://github.com/yilewang/sync-for-zotero.git"),
    "yilewang/sync-for-zotero",
  );
});

test("uses an already prepared manifest version instead of double bumping", () => {
  assert.deepEqual(
    determineReleaseTarget({
      manifestVersion: "0.0.11",
      latestPublishedTag: "v0.0.10",
      manifestRelease: null,
      bumpKind: "patch",
    }),
    {
      targetVersion: "0.0.11",
      targetTag: "v0.0.11",
      alreadyBumped: true,
      resume: false,
    },
  );
});

test("bumps from a complete latest release", () => {
  assert.deepEqual(
    determineReleaseTarget({
      manifestVersion: "0.0.10",
      latestPublishedTag: "v0.0.10",
      manifestRelease: {
        tagName: "v0.0.10",
        isDraft: false,
        assets: [{ name: "extension.zip" }],
      },
      bumpKind: "patch",
    }),
    {
      targetVersion: "0.0.11",
      targetTag: "v0.0.11",
      alreadyBumped: false,
      resume: false,
    },
  );
});

test("resumes an incomplete release without moving to the next version", () => {
  assert.deepEqual(
    determineReleaseTarget({
      manifestVersion: "0.0.11",
      latestPublishedTag: "v0.0.10",
      manifestRelease: {
        tagName: "v0.0.11",
        isDraft: true,
        assets: [],
      },
      bumpKind: "patch",
    }),
    {
      targetVersion: "0.0.11",
      targetTag: "v0.0.11",
      alreadyBumped: true,
      resume: true,
    },
  );
});

test("resumes a published release whose archive is missing", () => {
  assert.deepEqual(
    determineReleaseTarget({
      manifestVersion: "0.0.11",
      latestPublishedTag: "v0.0.11",
      manifestRelease: {
        tagName: "v0.0.11",
        isDraft: false,
        assets: [],
      },
      bumpKind: "patch",
    }),
    {
      targetVersion: "0.0.11",
      targetTag: "v0.0.11",
      alreadyBumped: true,
      resume: true,
    },
  );
});

test("fails closed when the manifest is unrelated to the requested bump", () => {
  assert.throws(
    () =>
      determineReleaseTarget({
        manifestVersion: "0.0.12",
        latestPublishedTag: "v0.0.10",
        manifestRelease: null,
        bumpKind: "patch",
      }),
    /must equal either/,
  );
});

test("requires the tag to equal the extension manifest version", () => {
  assert.equal(validateReleaseTag("v0.0.11", "0.0.11"), true);
  assert.throws(
    () => validateReleaseTag("v0.0.12", "0.0.11"),
    /does not match manifest version/,
  );
});

test("generates concise notes and omits release-only commits", () => {
  assert.equal(
    formatReleaseNotes(
      [
        "improve stability of chatgpt.com",
        "fix popup status",
        "chore(release): v0.0.11",
      ],
      {
        repo: "yilewang/sync-for-zotero",
        fromTag: "v0.0.10",
        toTag: "v0.0.11",
      },
    ),
    `## Changes

- Improve stability of chatgpt.com.
- Fix popup status.

**Full Changelog**: https://github.com/yilewang/sync-for-zotero/compare/v0.0.10...v0.0.11
`,
  );
});

test("parses configured editor commands without invoking a shell", () => {
  assert.deepEqual(splitCommandLine('code --wait "release notes.md"'), [
    "code",
    "--wait",
    "release notes.md",
  ]);
  assert.throws(() => splitCommandLine('code "unterminated'), /Could not parse/);
});

test("package scripts expose one-command releases", () => {
  const packageJson = JSON.parse(
    fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.version, undefined);
  assert.equal(packageJson.scripts["release:patch"], "node scripts/release.mjs patch");
  assert.equal(packageJson.scripts["release:minor"], "node scripts/release.mjs minor");
  assert.equal(packageJson.scripts["release:major"], "node scripts/release.mjs major");
});

test("release workflow validates, tests, packages, and uploads before publication", () => {
  const workflow = fs.readFileSync(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /types:\s*\[published\]/);
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /npm run release:validate/);
  assert.match(workflow, /npm test/);
  assert.match(workflow, /zip -r -X extension\.zip extension\//);
  assert.match(workflow, /unzip -t extension\.zip/);
  assert.match(workflow, /gh release upload "\$RELEASE_TAG"/);
});
