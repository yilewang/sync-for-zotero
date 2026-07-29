import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const sourceReleaseScript = new URL("../scripts/release.mjs", import.meta.url);

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "sync-for-zotero-release-test-"),
  );
  const repository = path.join(root, "repository");
  const remote = path.join(root, "remote.git");
  const fakeBin = path.join(root, "bin");
  const stateFile = path.join(root, "gh-state.json");
  fs.mkdirSync(repository);
  fs.mkdirSync(fakeBin);

  const realGit = run("which", ["git"]).trim();
  run(realGit, ["init", "--bare", remote]);
  run(realGit, ["init", "-b", "main"], { cwd: repository });
  run(realGit, ["config", "user.name", "Release Test"], { cwd: repository });
  run(realGit, ["config", "user.email", "release-test@example.com"], {
    cwd: repository,
  });
  run(realGit, ["config", "commit.gpgsign", "false"], { cwd: repository });
  run(realGit, ["config", "tag.gpgsign", "false"], { cwd: repository });

  fs.mkdirSync(path.join(repository, "extension"));
  fs.mkdirSync(path.join(repository, "scripts"));
  fs.mkdirSync(path.join(repository, "test"));
  writeJson(path.join(repository, "extension", "manifest.json"), {
    manifest_version: 3,
    name: "Sync for Zotero",
    version: "0.0.10",
  });
  fs.writeFileSync(
    path.join(repository, "test", "smoke.test.mjs"),
    `import test from "node:test";
import assert from "node:assert/strict";

test("fixture passes", () => assert.equal(1, 1));
`,
  );
  fs.copyFileSync(
    sourceReleaseScript,
    path.join(repository, "scripts", "release.mjs"),
  );
  writeJson(path.join(repository, "package.json"), {
    private: true,
    scripts: {
      test: "node --test test/*.test.mjs",
      "release:validate": "node scripts/release.mjs validate-tag",
    },
  });

  run(realGit, ["add", "."], { cwd: repository });
  run(realGit, ["commit", "-m", "baseline release"], { cwd: repository });
  run(realGit, ["tag", "-a", "v0.0.10", "-m", "v0.0.10"], {
    cwd: repository,
  });
  run(realGit, ["remote", "add", "origin", remote], { cwd: repository });
  run(realGit, ["push", "origin", "main", "refs/tags/v0.0.10"], {
    cwd: repository,
  });

  const manifestFile = path.join(repository, "extension", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  manifest.version = "0.0.11";
  writeJson(manifestFile, manifest);
  fs.writeFileSync(
    path.join(repository, "extension", "feature.js"),
    "globalThis.releaseFixture = true;\n",
  );
  run(realGit, ["add", "."], { cwd: repository });
  run(realGit, ["commit", "-m", "improve release fixture"], {
    cwd: repository,
  });

  writeJson(stateFile, {
    latestTag: "v0.0.10",
    releases: {
      "v0.0.10": {
        tagName: "v0.0.10",
        isDraft: false,
        isPrerelease: false,
        assets: [{ name: "extension.zip" }],
        url: "https://github.com/yilewang/sync-for-zotero/releases/tag/v0.0.10",
        body: "Previous release",
        publishedAt: "2026-06-29T02:31:46Z",
      },
    },
  });

  const fakeGit = path.join(fakeBin, "git");
  fs.writeFileSync(
    fakeGit,
    `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args.join(" ") === "remote get-url origin") {
  process.stdout.write("git@github.com:yilewang/sync-for-zotero.git\\n");
  process.exit(0);
}
const result = spawnSync(process.env.REAL_GIT, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
`,
  );
  fs.chmodSync(fakeGit, 0o755);

  const fakeGh = path.join(fakeBin, "gh");
  fs.writeFileSync(
    fakeGh,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const stateFile = process.env.FAKE_GH_STATE;
const readState = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const writeState = (state) =>
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\\n");
const flagValue = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1];
};

if (args[0] === "auth" && args[1] === "status") {
  process.exit(0);
}

if (args[0] === "release" && args[1] === "view") {
  const state = readState();
  const explicitTag = args[2] && !args[2].startsWith("--") ? args[2] : null;
  const tag = explicitTag || state.latestTag;
  const release = state.releases[tag];
  if (!release) {
    process.stderr.write("release not found\\n");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(release) + "\\n");
  process.exit(0);
}

if (args[0] === "release" && args[1] === "create") {
  const state = readState();
  const tag = args[2];
  const notesFile = flagValue("--notes-file");
  state.releases[tag] = {
    tagName: tag,
    isDraft: true,
    isPrerelease: false,
    assets: [],
    url: "https://github.com/yilewang/sync-for-zotero/releases/tag/" + tag,
    body: fs.readFileSync(notesFile, "utf8"),
    publishedAt: null,
  };
  writeState(state);
  process.stdout.write(state.releases[tag].url + "\\n");
  process.exit(0);
}

if (args[0] === "release" && args[1] === "edit") {
  const state = readState();
  const tag = args[2];
  const release = state.releases[tag];
  const notesFile = flagValue("--notes-file");
  if (notesFile) {
    release.body = fs.readFileSync(notesFile, "utf8");
  }
  if (args.includes("--draft=false")) {
    release.isDraft = false;
    release.publishedAt = "2026-07-28T23:00:00Z";
    state.latestTag = tag;
  }
  writeState(state);
  process.stdout.write(release.url + "\\n");
  process.exit(0);
}

if (args[0] === "run" && args[1] === "list") {
  process.stdout.write("[]\\n");
  process.exit(0);
}

if (args[0] === "workflow" && args[1] === "run") {
  const state = readState();
  const rawTag = flagValue("--raw-field");
  const tag = rawTag.split("=")[1];
  state.releases[tag].assets = [{ name: "extension.zip" }];
  writeState(state);
  process.stdout.write(
    "https://github.com/yilewang/sync-for-zotero/actions/runs/123\\n",
  );
  process.exit(0);
}

if (args[0] === "run" && args[1] === "watch") {
  process.exit(0);
}

process.stderr.write("Unsupported fake gh command: " + args.join(" ") + "\\n");
process.exit(2);
`,
  );
  fs.chmodSync(fakeGh, 0o755);

  return {
    root,
    repository,
    remote,
    stateFile,
    env: {
      ...process.env,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      REAL_GIT: realGit,
      FAKE_GH_STATE: stateFile,
    },
    realGit,
  };
}

test("release CLI dry-runs safely, then completes a simulated one-command release", () => {
  const fixture = createFixture();
  try {
    const releaseScript = path.join(
      fixture.repository,
      "scripts",
      "release.mjs",
    );
    const dryRun = spawnSync(
      process.execPath,
      [releaseScript, "patch", "--dry-run", "--yes"],
      {
        cwd: fixture.repository,
        encoding: "utf8",
        env: fixture.env,
      },
    );
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.match(dryRun.stdout, /Target release:\s+v0\.0\.11/);
    assert.match(dryRun.stdout, /Dry run complete/);
    assert.throws(
      () =>
        run(fixture.realGit, ["rev-parse", "--verify", "v0.0.11"], {
          cwd: fixture.repository,
          stdio: "pipe",
        }),
      /Command failed/,
    );
    assert.equal(
      JSON.parse(fs.readFileSync(fixture.stateFile, "utf8")).releases[
        "v0.0.11"
      ],
      undefined,
    );

    run(fixture.realGit, ["tag", "-a", "v0.0.11", "-m", "v0.0.11"], {
      cwd: fixture.repository,
    });
    run(fixture.realGit, ["push", "origin", "refs/tags/v0.0.11"], {
      cwd: fixture.repository,
    });
    const interruptedState = JSON.parse(
      fs.readFileSync(fixture.stateFile, "utf8"),
    );
    interruptedState.releases["v0.0.11"] = {
      tagName: "v0.0.11",
      isDraft: true,
      isPrerelease: false,
      assets: [],
      url: "https://github.com/yilewang/sync-for-zotero/releases/tag/v0.0.11",
      body: "## Changes\n\n- Improve release fixture.\n",
      publishedAt: null,
    };
    writeJson(fixture.stateFile, interruptedState);

    const release = spawnSync(
      process.execPath,
      [releaseScript, "patch", "--yes"],
      {
        cwd: fixture.repository,
        encoding: "utf8",
        env: fixture.env,
      },
    );
    assert.equal(release.status, 0, release.stderr);
    assert.match(release.stdout, /Released v0\.0\.11/);

    const state = JSON.parse(fs.readFileSync(fixture.stateFile, "utf8"));
    assert.equal(state.latestTag, "v0.0.11");
    assert.equal(state.releases["v0.0.11"].isDraft, false);
    assert.deepEqual(state.releases["v0.0.11"].assets, [
      { name: "extension.zip" },
    ]);
    assert.match(
      state.releases["v0.0.11"].body,
      /Improve release fixture\./,
    );

    const validation = spawnSync(
      process.execPath,
      [releaseScript, "validate-tag", "v0.0.11"],
      {
        cwd: fixture.repository,
        encoding: "utf8",
        env: fixture.env,
      },
    );
    assert.equal(validation.status, 0, validation.stderr);
    assert.match(validation.stdout, /v0\.0\.11 matches/);

    const firstReleaseHead = run(fixture.realGit, ["rev-parse", "HEAD"], {
      cwd: fixture.repository,
    }).trim();
    const firstTagCommit = run(
      fixture.realGit,
      ["rev-parse", "v0.0.11^{commit}"],
      { cwd: fixture.repository },
    ).trim();
    assert.equal(firstTagCommit, firstReleaseHead);

    fs.writeFileSync(
      path.join(fixture.repository, "extension", "next-release.js"),
      "globalThis.nextReleaseFixture = true;\n",
    );
    run(fixture.realGit, ["add", "."], { cwd: fixture.repository });
    run(fixture.realGit, ["commit", "-m", "fix the next release"], {
      cwd: fixture.repository,
    });

    const nextRelease = spawnSync(
      process.execPath,
      [releaseScript, "patch", "--yes"],
      {
        cwd: fixture.repository,
        encoding: "utf8",
        env: fixture.env,
      },
    );
    assert.equal(nextRelease.status, 0, nextRelease.stderr);
    assert.match(nextRelease.stdout, /Released v0\.0\.12/);

    const finalState = JSON.parse(
      fs.readFileSync(fixture.stateFile, "utf8"),
    );
    assert.equal(finalState.latestTag, "v0.0.12");
    assert.equal(finalState.releases["v0.0.12"].isDraft, false);
    assert.deepEqual(finalState.releases["v0.0.12"].assets, [
      { name: "extension.zip" },
    ]);
    assert.equal(
      JSON.parse(
        fs.readFileSync(
          path.join(fixture.repository, "extension", "manifest.json"),
          "utf8",
        ),
      ).version,
      "0.0.12",
    );
    assert.equal(
      run(fixture.realGit, ["log", "-1", "--format=%s"], {
        cwd: fixture.repository,
      }).trim(),
      "chore(release): v0.0.12",
    );

    const finalHead = run(fixture.realGit, ["rev-parse", "HEAD"], {
      cwd: fixture.repository,
    }).trim();
    const finalTagCommit = run(
      fixture.realGit,
      ["rev-parse", "v0.0.12^{commit}"],
      { cwd: fixture.repository },
    ).trim();
    const remoteMain = run(
      fixture.realGit,
      ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"],
    ).trim();
    assert.equal(finalTagCommit, finalHead);
    assert.equal(remoteMain, finalHead);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
