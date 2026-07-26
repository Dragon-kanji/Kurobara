import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const DCO_SCRIPT = path.join(REPOSITORY_ROOT, "scripts/check-dco.mjs");
const DCO_WORKFLOW = path.join(REPOSITORY_ROOT, ".github/workflows/dco.yml");
const ANCESTOR_FAILURE = /base commit is not an ancestor/u;
const AUTHOR_SIGN_OFF_FAILURE = /matching its author email/u;
const EMPTY_RANGE_FAILURE = /selected commit range is empty/u;
const HEAD_RESOLUTION_FAILURE = /headRef does not resolve to a commit/u;
const MALFORMED_SIGN_OFF_FAILURE = /malformed Signed-off-by trailer/u;
const MISSING_SIGN_OFF_FAILURE = /missing a valid Signed-off-by trailer/u;
const TWO_COMMIT_SUCCESS = /DCO check passed for 2 commit\(s\)/u;
const TRUSTED_BASE_CHECKOUT =
  /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/u;
const UNTRUSTED_HEAD_CHECKOUT =
  /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/u;
const PULL_REQUEST_TARGET_TRIGGER = /pull_request_target:/u;
const PERSISTED_READ_ONLY_CREDENTIAL = /persist-credentials: true/u;
const PULL_REQUEST_OBJECT_FETCH = /refs\/pull\/\$\{DCO_PR_NUMBER\}\/head:/u;
const TRUSTED_BASE_CHECKER =
  /git show "\$\{DCO_BASE_SHA\}:scripts\/check-dco\.mjs"/u;
const TRUSTED_DEPENDABOT_CONDITION =
  /github\.event\.pull_request\.user\.login == 'dependabot\[bot\]'.*github\.event\.pull_request\.head\.repo\.full_name == github\.repository.*startsWith\(github\.event\.pull_request\.head\.ref, 'dependabot\/'\)/u;
const TRUSTED_DEPENDABOT_FLAG =
  /node "\$RUNNER_TEMP\/check-dco\.mjs" --allow-dependabot/u;
const DEPENDABOT_SIGN_OFF = `dependabot[bot] <${["support", "github.com"].join(
  "@"
)}>`;

const git = (repositoryRoot, arguments_, options = {}) =>
  execFileSync("git", ["-C", repositoryRoot, ...arguments_], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_NAME: "Fixture Author",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture Author",
    },
    input: options.input,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();

const commit = (repositoryRoot, message, identity = {}) => {
  execFileSync(
    "git",
    [
      "-C",
      repositoryRoot,
      "-c",
      `user.name=${identity.name ?? "Fixture Author"}`,
      "-c",
      `user.email=${identity.email ?? "fixture@example.invalid"}`,
      "commit",
      "--allow-empty",
      "--no-gpg-sign",
      "--file=-",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_COMMITTER_EMAIL: identity.email ?? "fixture@example.invalid",
        GIT_COMMITTER_NAME: identity.name ?? "Fixture Author",
      },
      input: message,
      stdio: ["pipe", "pipe", "pipe"],
    }
  );
  return git(repositoryRoot, ["rev-parse", "HEAD"]);
};

const createRepository = async () => {
  const root = await mkdtemp(path.join(tmpdir(), "kurobara-dco-test-"));
  const repositoryRoot = path.join(root, "repository");
  await mkdir(repositoryRoot);
  git(repositoryRoot, ["init", "--initial-branch=main"]);
  const base = commit(repositoryRoot, "Base commit\n");
  return { base, repositoryRoot, root };
};

const runCheck = (repositoryRoot, baseRef, headRef, options = {}) =>
  spawnSync(
    process.execPath,
    [
      DCO_SCRIPT,
      ...(options.allowDependabot ? ["--allow-dependabot"] : []),
      baseRef,
      headRef,
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

const withRepository = async (run) => {
  const fixture = await createRepository();
  try {
    return await run(fixture);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
};

test("accepts every commit in an explicitly selected signed range", () =>
  withRepository((fixture) => {
    commit(
      fixture.repositoryRoot,
      "First change\n\nSigned-off-by: Fixture Author <fixture@example.invalid>\n"
    );
    const head = commit(
      fixture.repositoryRoot,
      "Second change\n\nSigned-off-by: Fixture Author <fixture@example.invalid>\n"
    );

    const result = runCheck(fixture.repositoryRoot, fixture.base, head);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, TWO_COMMIT_SUCCESS);
  }));

test("rejects a missing sign-off", () =>
  withRepository((fixture) => {
    const head = commit(fixture.repositoryRoot, "Unsigned change\n");

    const result = runCheck(fixture.repositoryRoot, fixture.base, head);

    assert.equal(result.status, 1);
    assert.match(result.stderr, MISSING_SIGN_OFF_FAILURE);
  }));

test("rejects a malformed sign-off", () =>
  withRepository((fixture) => {
    const head = commit(
      fixture.repositoryRoot,
      "Malformed change\n\nSigned-off-by: Fixture Author fixture@example.invalid\n"
    );

    const result = runCheck(fixture.repositoryRoot, fixture.base, head);

    assert.equal(result.status, 1);
    assert.match(result.stderr, MALFORMED_SIGN_OFF_FAILURE);
  }));

test("rejects a sign-off from an identity other than the commit author", () =>
  withRepository((fixture) => {
    const head = commit(
      fixture.repositoryRoot,
      "Wrong signer\n\nSigned-off-by: Other Author <other@example.invalid>\n"
    );

    const result = runCheck(fixture.repositoryRoot, fixture.base, head);

    assert.equal(result.status, 1);
    assert.match(result.stderr, AUTHOR_SIGN_OFF_FAILURE);
  }));

test("rejects the standard Dependabot identity pair unless explicitly trusted", () =>
  withRepository((fixture) => {
    const head = commit(
      fixture.repositoryRoot,
      `Bump dependency\n\nSigned-off-by: ${DEPENDABOT_SIGN_OFF}\n`,
      {
        email: "49699333+dependabot[bot]@users.noreply.github.com",
        name: "dependabot[bot]",
      }
    );

    const result = runCheck(fixture.repositoryRoot, fixture.base, head);

    assert.equal(result.status, 1);
    assert.match(result.stderr, AUTHOR_SIGN_OFF_FAILURE);
  }));

test("accepts the exact Dependabot identity pair when the trusted caller opts in", () =>
  withRepository((fixture) => {
    const head = commit(
      fixture.repositoryRoot,
      `Bump dependency\n\nSigned-off-by: ${DEPENDABOT_SIGN_OFF}\n`,
      {
        email: "49699333+dependabot[bot]@users.noreply.github.com",
        name: "dependabot[bot]",
      }
    );

    const result = runCheck(fixture.repositoryRoot, fixture.base, head, {
      allowDependabot: true,
    });

    assert.equal(result.status, 0, result.stderr);
  }));

test("accepts the exact Dependabot trailer after its metadata divider", () =>
  withRepository((fixture) => {
    const head = commit(
      fixture.repositoryRoot,
      `Bump dependency

---
updated-dependencies:
- dependency-name: fixture
  dependency-version: 1.2.3
  dependency-type: direct:production
  update-type: version-update:semver-minor
...

Signed-off-by: ${DEPENDABOT_SIGN_OFF}
`,
      {
        email: "49699333+dependabot[bot]@users.noreply.github.com",
        name: "dependabot[bot]",
      }
    );

    const result = runCheck(fixture.repositoryRoot, fixture.base, head, {
      allowDependabot: true,
    });

    assert.equal(result.status, 0, result.stderr);
  }));

test("rejects a Dependabot lookalike even when the trusted caller opts in", () =>
  withRepository((fixture) => {
    const head = commit(
      fixture.repositoryRoot,
      `Bump dependency\n\nSigned-off-by: ${DEPENDABOT_SIGN_OFF}\n`,
      {
        email: "impostor@example.invalid",
        name: "dependabot[bot]",
      }
    );

    const result = runCheck(fixture.repositoryRoot, fixture.base, head, {
      allowDependabot: true,
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, AUTHOR_SIGN_OFF_FAILURE);
  }));

test("rejects an empty range", () =>
  withRepository((fixture) => {
    const result = runCheck(fixture.repositoryRoot, fixture.base, fixture.base);

    assert.equal(result.status, 1);
    assert.match(result.stderr, EMPTY_RANGE_FAILURE);
  }));

test("rejects an unknown reference", () =>
  withRepository((fixture) => {
    const result = runCheck(
      fixture.repositoryRoot,
      fixture.base,
      "refs/heads/unknown"
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, HEAD_RESOLUTION_FAILURE);
  }));

test("rejects a non-ancestor range", () =>
  withRepository((fixture) => {
    const mainHead = commit(
      fixture.repositoryRoot,
      "Main change\n\nSigned-off-by: Fixture Author <fixture@example.invalid>\n"
    );
    git(fixture.repositoryRoot, ["switch", "--detach", fixture.base]);
    const sideHead = commit(
      fixture.repositoryRoot,
      "Side change\n\nSigned-off-by: Fixture Author <fixture@example.invalid>\n"
    );

    const result = runCheck(fixture.repositoryRoot, mainHead, sideHead);

    assert.equal(result.status, 1);
    assert.match(result.stderr, ANCESTOR_FAILURE);
  }));

test("keeps a shell-shaped reference inert", () =>
  withRepository(async (fixture) => {
    const marker = path.join(fixture.root, "injected");

    const result = runCheck(
      fixture.repositoryRoot,
      fixture.base,
      `HEAD;touch ${marker}`
    );

    assert.equal(result.status, 1);
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  }));

test("keeps fork pull request code out of the trusted workflow", async () => {
  const workflow = await readFile(DCO_WORKFLOW, "utf8");

  assert.match(workflow, PULL_REQUEST_TARGET_TRIGGER);
  assert.match(workflow, TRUSTED_BASE_CHECKOUT);
  assert.doesNotMatch(workflow, UNTRUSTED_HEAD_CHECKOUT);
  assert.match(workflow, PERSISTED_READ_ONLY_CREDENTIAL);
  assert.match(workflow, PULL_REQUEST_OBJECT_FETCH);
  assert.match(workflow, TRUSTED_BASE_CHECKER);
  assert.match(workflow, TRUSTED_DEPENDABOT_CONDITION);
  assert.match(workflow, TRUSTED_DEPENDABOT_FLAG);
});
