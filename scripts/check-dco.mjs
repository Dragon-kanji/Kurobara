import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_REF_LENGTH = 512;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const COMMIT_OBJECT_ID = /^[0-9a-f]{40,64}$/u;
const LINE_BREAKS = /\r?\n/u;
const SIGN_OFF_CANDIDATE = /^\s*signed-off-by\b/iu;
const VALID_SIGN_OFF =
  /^Signed-off-by: ([^<>\r\n]+?) <([^<>\s@]+@[^<>\s@]+)>$/u;
const DEPENDABOT_AUTHOR_NAME = "dependabot[bot]";
const DEPENDABOT_AUTHOR_EMAIL =
  "49699333+dependabot[bot]@users.noreply.github.com";
const DEPENDABOT_SIGN_OFF_EMAIL = ["support", "github.com"].join("@");

export class DcoCheckError extends Error {
  constructor(message) {
    super(message);
    this.name = "DcoCheckError";
  }
}

const spawnGit = (arguments_, options = {}) => {
  const result = spawnSync("git", arguments_, {
    cwd: options.cwd,
    encoding: "utf8",
    input: options.input,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.error) {
    throw new DcoCheckError(`Unable to execute Git: ${result.error.message}`);
  }

  return result;
};

const assertReferenceArgument = (label, reference) => {
  if (
    typeof reference !== "string" ||
    reference.length === 0 ||
    reference.length > MAX_REF_LENGTH
  ) {
    throw new DcoCheckError(`${label} must be a non-empty Git reference.`);
  }
  const containsControlCharacter = [...reference].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
  if (reference.startsWith("-") || containsControlCharacter) {
    throw new DcoCheckError(`${label} contains forbidden characters.`);
  }
};

const resolveCommit = (cwd, label, reference) => {
  assertReferenceArgument(label, reference);
  const result = spawnGit(
    [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      `${reference}^{commit}`,
    ],
    { cwd }
  );
  const commit = result.stdout.trim();

  if (result.status !== 0 || !COMMIT_OBJECT_ID.test(commit)) {
    throw new DcoCheckError(`${label} does not resolve to a commit.`);
  }
  return commit;
};

const assertAncestorRange = (cwd, baseCommit, headCommit) => {
  const result = spawnGit(
    ["merge-base", "--is-ancestor", baseCommit, headCommit],
    { cwd }
  );
  if (result.status === 1) {
    throw new DcoCheckError(
      "The base commit is not an ancestor of the head commit."
    );
  }
  if (result.status !== 0) {
    throw new DcoCheckError("Git could not validate the commit range.");
  }
};

const listRangeCommits = (cwd, baseCommit, headCommit) => {
  const result = spawnGit(
    ["rev-list", "--reverse", `${baseCommit}..${headCommit}`, "--"],
    { cwd }
  );
  if (result.status !== 0) {
    throw new DcoCheckError("Git could not enumerate the commit range.");
  }

  const commits = result.stdout
    .split("\n")
    .map((commit) => commit.trim())
    .filter(Boolean);
  if (commits.length === 0) {
    throw new DcoCheckError("The selected commit range is empty.");
  }
  return commits;
};

const readCommitMessage = (cwd, commit) => {
  const result = spawnGit(["show", "--no-patch", "--format=%B", commit, "--"], {
    cwd,
  });
  if (result.status !== 0) {
    throw new DcoCheckError(`Unable to read commit ${commit.slice(0, 12)}.`);
  }
  return result.stdout;
};

const readCommitAuthor = (cwd, commit) => {
  const result = spawnGit(
    ["show", "--no-patch", "--format=%an%x00%ae", commit, "--"],
    { cwd }
  );
  const [name, email, ...unexpected] = result.stdout.trim().split("\0");
  if (
    result.status !== 0 ||
    unexpected.length > 0 ||
    name === undefined ||
    name.length === 0 ||
    name.includes("\n") ||
    name.includes("\r") ||
    email === undefined ||
    email.length === 0 ||
    email.includes("\n") ||
    email.includes("\r")
  ) {
    throw new DcoCheckError(
      `Unable to read the author of commit ${commit.slice(0, 12)}.`
    );
  }
  return { email: email.toLowerCase(), name };
};

const parseTrailers = (cwd, message) => {
  const result = spawnGit(["interpret-trailers", "--parse", "--no-divider"], {
    cwd,
    input: message,
  });
  if (result.status !== 0) {
    throw new DcoCheckError("Git could not parse commit trailers.");
  }
  return result.stdout.split("\n").filter(Boolean);
};

const isOfficialDependabotSignOff = (author, match) =>
  author.name === DEPENDABOT_AUTHOR_NAME &&
  author.email === DEPENDABOT_AUTHOR_EMAIL &&
  match?.[1] === DEPENDABOT_AUTHOR_NAME &&
  match[2].toLowerCase() === DEPENDABOT_SIGN_OFF_EMAIL;

const validateCommitMessage = (
  cwd,
  commit,
  message,
  author,
  allowDependabot
) => {
  const candidateLines = message
    .split(LINE_BREAKS)
    .filter((line) => SIGN_OFF_CANDIDATE.test(line));
  const malformedLine = candidateLines.find(
    (line) => !VALID_SIGN_OFF.test(line)
  );
  if (malformedLine !== undefined) {
    throw new DcoCheckError(
      `Commit ${commit.slice(0, 12)} contains a malformed Signed-off-by trailer.`
    );
  }

  const parsedSignOffs = parseTrailers(cwd, message).filter((line) =>
    line.startsWith("Signed-off-by:")
  );
  if (
    parsedSignOffs.length === 0 ||
    parsedSignOffs.some((line) => !VALID_SIGN_OFF.test(line))
  ) {
    throw new DcoCheckError(
      `Commit ${commit.slice(0, 12)} is missing a valid Signed-off-by trailer.`
    );
  }
  const authorSignedOff = parsedSignOffs.some((line) => {
    const match = VALID_SIGN_OFF.exec(line);
    return (
      match?.[2].toLowerCase() === author.email ||
      (allowDependabot && isOfficialDependabotSignOff(author, match))
    );
  });
  if (!authorSignedOff) {
    throw new DcoCheckError(
      `Commit ${commit.slice(0, 12)} has no Signed-off-by trailer matching its author email.`
    );
  }
};

export const checkDcoRange = ({
  allowDependabot = false,
  baseRef,
  cwd = process.cwd(),
  headRef,
}) => {
  const baseCommit = resolveCommit(cwd, "baseRef", baseRef);
  const headCommit = resolveCommit(cwd, "headRef", headRef);
  assertAncestorRange(cwd, baseCommit, headCommit);
  const commits = listRangeCommits(cwd, baseCommit, headCommit);

  for (const commit of commits) {
    validateCommitMessage(
      cwd,
      commit,
      readCommitMessage(cwd, commit),
      readCommitAuthor(cwd, commit),
      allowDependabot
    );
  }

  return {
    baseCommit,
    checkedCommits: commits,
    headCommit,
  };
};

const runCli = () => {
  const arguments_ = process.argv.slice(2);
  const allowDependabot = arguments_[0] === "--allow-dependabot";
  const [baseRef, headRef, ...unexpected] = allowDependabot
    ? arguments_.slice(1)
    : arguments_;
  if (!(baseRef && headRef) || unexpected.length > 0) {
    console.error(
      "Usage: node scripts/check-dco.mjs [--allow-dependabot] <base-ref> <head-ref>"
    );
    process.exitCode = 2;
    return;
  }

  try {
    const result = checkDcoRange({ allowDependabot, baseRef, headRef });
    console.log(
      `DCO check passed for ${result.checkedCommits.length} commit(s) in ${result.baseCommit.slice(0, 12)}..${result.headCommit.slice(0, 12)}.`
    );
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown DCO check failure.";
    console.error(`DCO check failed: ${message}`);
    process.exitCode = 1;
  }
};

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli();
}
