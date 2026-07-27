import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FORMAT_VERSION = "1.0.0";
const POLICY_HEADER =
  "decision\tpath\treason\tcuration_owner\tprovenance\tlicense_review";
const DECISIONS = new Set(["exclude", "include", "regenerate"]);
const MODES = new Set(["100644", "100755"]);
const GENERATED_PATHS = new Set([
  "docs/architecture/generated/module-dependencies.mmd",
  "packages/contracts/catalog/generated/catalog-manifest.json",
  "packages/contracts/catalog/generated/cli-commands.json",
  "packages/contracts/catalog/generated/generation-manifest.json",
  "packages/contracts/catalog/generated/mcp-tools.json",
  "packages/contracts/catalog/generated/openapi-3.1.1.json",
  "packages/contracts/catalog/generated/problem-registry.json",
  "packages/contracts/src/generated/v1.ts",
]);
const APPROVED_BINARY_ASSETS = new Map([
  [
    "apps/website/public/assets/kurobara-rose.webp",
    { format: "webp-vp8", maxBytes: 256 * 1024 },
  ],
  [
    "apps/website/public/assets/social/og-kurobara.jpg",
    { format: "jpeg", maxBytes: 256 * 1024 },
  ],
]);
const JPEG_ALLOWED_SEGMENT_MARKERS = new Set([
  0xc0, 0xc2, 0xc4, 0xda, 0xdb, 0xdd, 0xe0,
]);
const APACHE_LICENSE_SHA256 =
  "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";
const POLICY_FIELD_BREAK_PATTERN = /[\t\r\n]/u;
const TREE_METADATA_SEPARATOR_PATTERN = /\s+/u;
const DECIMAL_INTEGER_PATTERN = /^[0-9]+$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const MARKDOWN_LINK_PATTERN = /\[[^\]]*\]\(([^)]+)\)/gu;
const MARKDOWN_TITLE_SEPARATOR_PATTERN = /\s+["']/u;
const EXTERNAL_LINK_PATTERN = /^(?:https?:|mailto:|#)/u;
const NOREPLY_EMAIL_PATTERN =
  /^[0-9]+\+[A-Za-z0-9-]+@users\.noreply\.github\.com$/u;
const SIGNING_FINGERPRINT_PATTERN = /^[0-9A-F]{40}$/u;
const GPG_VALID_SIGNATURE_PREFIX = "[GNUPG:] VALIDSIG ";
const COMMAND_OPTIONS = new Map([
  ["policy", new Set(["output"])],
  ["export", new Set(["destination", "policy", "source_ref"])],
  ["verify", new Set(["destination", "manifest_sha256", "phase"])],
  ["scan", new Set(["destination", "manifest_sha256"])],
  [
    "bootstrap",
    new Set([
      "destination",
      "email",
      "manifest_sha256",
      "message",
      "name",
      "signing_key",
    ]),
  ],
  [
    "verify-root",
    new Set(["destination", "email", "manifest_sha256", "name", "signing_key"]),
  ],
]);
const RESERVED_EMAIL_DOMAINS = [
  "example",
  "example.com",
  "example.net",
  "example.org",
  "invalid",
  "test",
  "users.noreply.github.com",
];
const FORBIDDEN_CONTENT = [
  ["Dragon-kanji/Kurobara", "-systems"].join(""),
  ["codex/v1-", "oss-foundation"].join(""),
  ["refs/", "codex/"].join(""),
  ["a5f", "9a12"].join(""),
  ["342", "816f"].join(""),
  ["ba4", "ac5e"].join(""),
  ["891418f4c8be55bf", "6ad9279404d01d439aaffc1d"].join(""),
];
const HOME_DIRECTORY_SEGMENT = ["Us", "ers"].join("");
const HOME_PATH_PATTERN = new RegExp(
  String.raw`(?:/(?:${HOME_DIRECTORY_SEGMENT}|home)/[^/\s]+/|[A-Za-z]:\\${HOME_DIRECTORY_SEGMENT}\\)`,
  "u"
);
const EMAIL_PATTERN =
  /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Z0-9-]+(?:\.[A-Z0-9-]+)*\.[A-Z]{2,63})\b/giu;
const PHONE_PATTERN = /\+[1-9][0-9]{7,14}\b/gu;
const SUSPICIOUS_FILE_PATTERN =
  /(?:^|\/)(?:\.env(?:\..+)?|[^/]+\.(?:bak|db|dump|key|log|p12|pem|sqlite3?))$/u;
const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

export class CleanRoomError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "CleanRoomError";
  }
}

function fail(code, message) {
  throw new CleanRoomError(code, message);
}

function comparePaths(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => comparePaths(left, right))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

function containsControlCharacter(value) {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
}

function filePermissions(mode) {
  return mode % 0o1000;
}

function sanitizedGitEnvironment(overrides = {}) {
  const environment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    ...overrides,
  };
  for (const key of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_PARAMETERS",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_NAMESPACE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_REPLACE_REF_BASE",
    "GIT_SHALLOW_FILE",
    "GIT_TEMPLATE_DIR",
    "GIT_WORK_TREE",
  ]) {
    delete environment[key];
  }
  for (const key of Object.keys(environment)) {
    if (
      key.startsWith("GIT_AUTHOR_") ||
      key.startsWith("GIT_COMMITTER_") ||
      key.startsWith("GIT_CONFIG_KEY_") ||
      key.startsWith("GIT_CONFIG_VALUE_")
    ) {
      delete environment[key];
    }
  }
  return environment;
}

function git(repositoryRoot, arguments_, options = {}) {
  try {
    return execFileSync("git", ["-C", repositoryRoot, ...arguments_], {
      encoding: options.encoding ?? "utf8",
      env: sanitizedGitEnvironment(options.environment),
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = Buffer.isBuffer(error.stderr)
      ? error.stderr.toString("utf8")
      : String(error.stderr ?? "");
    fail(
      "git-command-failed",
      `git ${arguments_.join(" ")} failed${stderr ? `: ${stderr.trim()}` : ""}`
    );
  }
}

function gitStatus(repositoryRoot, arguments_) {
  return spawnSync("git", ["-C", repositoryRoot, ...arguments_], {
    encoding: "utf8",
    env: sanitizedGitEnvironment(),
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function validatePath(candidate) {
  if (
    !candidate ||
    candidate !== candidate.normalize("NFC") ||
    candidate.startsWith("/") ||
    candidate.includes("\\") ||
    containsControlCharacter(candidate)
  ) {
    fail("unsafe-path", `Unsafe policy path: ${JSON.stringify(candidate)}`);
  }
  const components = candidate.split("/");
  if (
    components.some(
      (component) =>
        !component ||
        component === "." ||
        component === ".." ||
        component === ".git"
    )
  ) {
    fail("unsafe-path", `Unsafe policy path: ${JSON.stringify(candidate)}`);
  }
  if (path.posix.normalize(candidate) !== candidate) {
    fail("unsafe-path", `Non-normalized policy path: ${candidate}`);
  }
  return candidate;
}

function repositoryRelativePath(repositoryRoot, candidate, label) {
  if (!candidate) {
    fail(`missing-${label}`, `${label} path is required`);
  }
  const absolute = path.resolve(repositoryRoot, candidate);
  const relative = path
    .relative(repositoryRoot, absolute)
    .split(path.sep)
    .join("/");
  try {
    return validatePath(relative);
  } catch {
    fail(
      `${label}-outside-repository`,
      `${label} must be a tracked path inside the source repository`
    );
  }
}

function dispositionForPath(candidate) {
  if (candidate.startsWith("apps/website/design/")) {
    return {
      curationOwner: "project-owner",
      decision: "exclude",
      licenseReview: "not-applicable-to-candidate",
      provenance: "generated-source-design-reference",
      reason: "source-private-design-reference",
    };
  }
  if (
    candidate.startsWith("docs/audits/") ||
    candidate.startsWith("docs/legal/") ||
    candidate.startsWith("docs/publication/")
  ) {
    return {
      curationOwner: "project-owner",
      decision: "exclude",
      licenseReview: "not-applicable-to-candidate",
      provenance: "source-private-operator-record",
      reason: "source-private-evidence",
    };
  }
  if (candidate === "docs/backlog-v1-oss.md") {
    return {
      curationOwner: "project-owner",
      decision: "exclude",
      licenseReview: "not-applicable-to-candidate",
      provenance: "source-private-operator-record",
      reason: "operator-planning",
    };
  }
  if (GENERATED_PATHS.has(candidate)) {
    return {
      curationOwner: "project-owner",
      decision: "regenerate",
      licenseReview: "pending-publication-review",
      provenance: "generated-from-canonical-source",
      reason: "canonical-generated-output",
    };
  }
  if (candidate === "LICENSE") {
    return {
      curationOwner: "project-owner",
      decision: "include",
      licenseReview: "verified-official-text",
      provenance: "official-apache-2.0",
      reason: "official-license-text",
    };
  }
  if (candidate === "DCO") {
    return {
      curationOwner: "project-owner",
      decision: "include",
      licenseReview: "not-a-software-license",
      provenance: "official-dco-1.1",
      reason: "official-dco-text",
    };
  }
  return {
    curationOwner: "project-owner",
    decision: "include",
    licenseReview: "pending-publication-review",
    provenance: "current-repository-tree-pending-publication-review",
    reason: "public-v1-source",
  };
}

function parseNullSeparated(buffer) {
  const parts = buffer.toString("utf8").split("\0");
  if (parts.at(-1) === "") {
    parts.pop();
  }
  return parts;
}

export async function writePolicy({
  outputPath,
  repositoryRoot = REPOSITORY_ROOT,
} = {}) {
  if (!outputPath) {
    fail("missing-policy-output", "policy requires --output");
  }
  const absoluteOutput = path.resolve(repositoryRoot, outputPath);
  const relativeOutput = path.relative(repositoryRoot, absoluteOutput);
  validatePath(relativeOutput);
  const stagedPaths = parseNullSeparated(
    git(repositoryRoot, ["ls-files", "-z"], { encoding: "buffer" })
  );
  if (!stagedPaths.includes(relativeOutput)) {
    fail(
      "policy-not-tracked",
      `Stage ${relativeOutput} once before generating the exact policy`
    );
  }
  const rows = stagedPaths.sort(comparePaths).map((candidate) => {
    validatePath(candidate);
    const disposition = dispositionForPath(candidate);
    return [
      disposition.decision,
      candidate,
      disposition.reason,
      disposition.curationOwner,
      disposition.provenance,
      disposition.licenseReview,
    ].join("\t");
  });
  await writeFile(absoluteOutput, `${POLICY_HEADER}\n${rows.join("\n")}\n`, {
    encoding: "utf8",
    mode: 0o644,
  });
  return { path: relativeOutput, rowCount: rows.length };
}

function readPolicy(bytes) {
  const text = bytes.toString("utf8");
  if (Buffer.from(text, "utf8").compare(bytes) !== 0 || !text.endsWith("\n")) {
    fail(
      "invalid-policy-encoding",
      "Policy must be canonical UTF-8 with a final LF"
    );
  }
  const lines = text.slice(0, -1).split("\n");
  if (lines.shift() !== POLICY_HEADER) {
    fail("invalid-policy-header", `Policy header must be: ${POLICY_HEADER}`);
  }
  const rows = [];
  const seenPaths = new Set();
  const caseFolded = new Set();
  for (const line of lines) {
    const columns = line.split("\t");
    if (columns.length !== 6) {
      fail("invalid-policy-row", `Policy row must have six columns: ${line}`);
    }
    const [
      decision,
      candidate,
      reason,
      curationOwner,
      provenance,
      licenseReview,
    ] = columns;
    if (!DECISIONS.has(decision)) {
      fail("invalid-policy-decision", `Unknown decision for ${candidate}`);
    }
    validatePath(candidate);
    for (const field of [reason, curationOwner, provenance, licenseReview]) {
      if (!field || POLICY_FIELD_BREAK_PATTERN.test(field)) {
        fail(
          "invalid-policy-field",
          `Invalid policy metadata for ${candidate}`
        );
      }
    }
    if (seenPaths.has(candidate)) {
      fail("duplicate-policy-path", `Duplicate policy path: ${candidate}`);
    }
    const folded = candidate.toLocaleLowerCase("en-US");
    if (caseFolded.has(folded)) {
      fail("case-fold-collision", `Case-fold path collision: ${candidate}`);
    }
    seenPaths.add(candidate);
    caseFolded.add(folded);
    rows.push({
      curation_owner: curationOwner,
      decision,
      license_review: licenseReview,
      path: candidate,
      provenance,
      reason,
    });
  }
  const sorted = [...rows].sort((left, right) =>
    comparePaths(left.path, right.path)
  );
  if (rows.some((row, index) => row.path !== sorted[index]?.path)) {
    fail("unsorted-policy", "Policy rows must use bytewise path ordering");
  }
  return { bytes, rows };
}

function parseTreeEntries(repositoryRoot, sourceCommit) {
  const output = parseNullSeparated(
    git(
      repositoryRoot,
      ["ls-tree", "-r", "-z", "-l", "--full-tree", sourceCommit],
      { encoding: "buffer" }
    )
  );
  return output.map((line) => {
    const separator = line.indexOf("\t");
    const metadata = line
      .slice(0, separator)
      .split(TREE_METADATA_SEPARATOR_PATTERN);
    if (separator === -1 || metadata.length !== 4) {
      fail("invalid-git-tree", "Unexpected git ls-tree output");
    }
    const [mode, type, gitBlob, sizeText] = metadata;
    const candidate = validatePath(line.slice(separator + 1));
    if (
      type !== "blob" ||
      !MODES.has(mode) ||
      !DECIMAL_INTEGER_PATTERN.test(sizeText)
    ) {
      fail(
        "unsupported-git-entry",
        `Only regular 100644/100755 blobs are accepted: ${candidate}`
      );
    }
    return {
      git_blob: gitBlob,
      mode,
      path: candidate,
      size_bytes: Number(sizeText),
    };
  });
}

function assertCleanTrackedState(repositoryRoot) {
  const status = git(repositoryRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=no",
  ]).trim();
  if (status) {
    fail(
      "dirty-tracked-state",
      "Commit or restore tracked and staged changes before clean-room export"
    );
  }
}

function buildManifest({ policyPath, repositoryRoot, sourceRef = "HEAD" }) {
  assertCleanTrackedState(repositoryRoot);
  const sourceCommit = git(repositoryRoot, [
    "rev-parse",
    "--verify",
    `${sourceRef}^{commit}`,
  ]).trim();
  const sourceTree = git(repositoryRoot, [
    "rev-parse",
    "--verify",
    `${sourceCommit}^{tree}`,
  ]).trim();
  const objectFormat = git(repositoryRoot, [
    "rev-parse",
    "--show-object-format",
  ]).trim();
  const treeEntries = parseTreeEntries(repositoryRoot, sourceCommit);
  const treeByPath = new Map(treeEntries.map((entry) => [entry.path, entry]));
  const relativePolicyPath = repositoryRelativePath(
    repositoryRoot,
    policyPath,
    "policy"
  );
  const policyEntry = treeByPath.get(relativePolicyPath);
  if (!policyEntry) {
    fail(
      "policy-not-in-source",
      "Policy must be a tracked blob in the selected source commit"
    );
  }
  const policy = readPolicy(
    git(repositoryRoot, ["cat-file", "blob", policyEntry.git_blob], {
      encoding: "buffer",
    })
  );
  const policyByPath = new Map(policy.rows.map((row) => [row.path, row]));
  const treePaths = [...treeByPath.keys()].sort(comparePaths);
  const policyPaths = [...policyByPath.keys()].sort(comparePaths);
  if (
    treePaths.length !== policyPaths.length ||
    treePaths.some((candidate, index) => candidate !== policyPaths[index])
  ) {
    const missing = treePaths.filter(
      (candidate) => !policyByPath.has(candidate)
    );
    const extra = policyPaths.filter((candidate) => !treeByPath.has(candidate));
    fail(
      "policy-tree-mismatch",
      `Policy must classify HEAD exactly once; missing=${missing.join(",") || "none"} extra=${extra.join(",") || "none"}`
    );
  }
  const files = [];
  const excluded = [];
  let totalSizeBytes = 0;
  for (const candidate of treePaths) {
    const treeEntry = treeByPath.get(candidate);
    const disposition = policyByPath.get(candidate);
    if (!(treeEntry && disposition)) {
      fail(
        "policy-tree-mismatch",
        `Missing policy or tree entry for ${candidate}`
      );
    }
    const bytes = git(
      repositoryRoot,
      ["cat-file", "blob", treeEntry.git_blob],
      {
        encoding: "buffer",
      }
    );
    if (bytes.length !== treeEntry.size_bytes) {
      fail("git-size-mismatch", `Git size mismatch for ${candidate}`);
    }
    const entry = {
      ...treeEntry,
      ...disposition,
      sha256: `sha256:${sha256(bytes)}`,
    };
    if (disposition.decision === "exclude") {
      excluded.push(entry);
      continue;
    }
    totalSizeBytes += treeEntry.size_bytes;
    files.push(entry);
  }
  return {
    manifest: {
      decisions: {
        exclude_count: excluded.length,
        include_count: files.filter((entry) => entry.decision === "include")
          .length,
        regenerate_count: files.filter(
          (entry) => entry.decision === "regenerate"
        ).length,
      },
      excluded,
      file_count: files.length,
      files,
      format_version: FORMAT_VERSION,
      hash_algorithm: "sha256",
      source: {
        commit: sourceCommit,
        git_object_format: objectFormat,
        policy_path: relativePolicyPath,
        policy_sha256: `sha256:${sha256(policy.bytes)}`,
        tree: sourceTree,
      },
      total_size_bytes: totalSizeBytes,
    },
    sourceCommit,
  };
}

function assertAbsoluteDestination(destination, repositoryRoot) {
  if (!(destination && path.isAbsolute(destination))) {
    fail("unsafe-destination", "Destination must be an absolute path");
  }
  const resolved = path.resolve(destination);
  const relativeFromSource = path.relative(repositoryRoot, resolved);
  const relativeFromDestination = path.relative(resolved, repositoryRoot);
  const inside = (relative) =>
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..");
  if (inside(relativeFromSource) || inside(relativeFromDestination)) {
    fail(
      "unsafe-destination",
      "Destination must be outside and must not contain the source repository"
    );
  }
  return resolved;
}

async function assertDestinationParentSafe(destination, repositoryRoot) {
  const parent = path.dirname(destination);
  const resolvedParent = await realpath(parent);
  const resolvedRepository = await realpath(repositoryRoot);
  const resolvedDestination = path.join(
    resolvedParent,
    path.basename(destination)
  );
  const relativeFromSource = path.relative(
    resolvedRepository,
    resolvedDestination
  );
  const relativeFromDestination = path.relative(
    resolvedDestination,
    resolvedRepository
  );
  const inside = (relative) =>
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..");
  if (inside(relativeFromSource) || inside(relativeFromDestination)) {
    fail(
      "unsafe-destination",
      "Resolved destination overlaps the source repository"
    );
  }
}

async function reserveDestination(destination) {
  try {
    await mkdir(destination, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") {
      fail("destination-exists", `Destination already exists: ${destination}`);
    }
    throw error;
  }
}

async function resolveWrapperRoot(
  destination,
  { allowRootReceipt = false } = {}
) {
  const wrapperPath = assertAbsoluteDestination(destination, REPOSITORY_ROOT);
  const wrapperMetadata = await lstat(wrapperPath);
  if (!wrapperMetadata.isDirectory() || wrapperMetadata.isSymbolicLink()) {
    fail("wrapper-type-mismatch", "Candidate wrapper must be a real directory");
  }
  const resolvedParent = await realpath(path.dirname(wrapperPath));
  const expectedRealPath = path.join(
    resolvedParent,
    path.basename(wrapperPath)
  );
  const wrapperRoot = await realpath(wrapperPath);
  if (wrapperRoot !== expectedRealPath) {
    fail("wrapper-symlink", "Candidate wrapper must not be a symlink");
  }
  const wrapperEntries = (await readdir(wrapperRoot)).sort(comparePaths);
  const expectedEntries = ["clean-room-manifest.json", "tree"];
  const allowedEntries = allowRootReceipt
    ? [
        expectedEntries,
        [...expectedEntries, "root-commit-receipt.json"].sort(comparePaths),
      ]
    : [expectedEntries];
  const layoutIsAllowed = allowedEntries.some(
    (allowed) =>
      allowed.length === wrapperEntries.length &&
      allowed.every((entry, index) => entry === wrapperEntries[index])
  );
  if (!layoutIsAllowed) {
    fail(
      "wrapper-layout-mismatch",
      allowRootReceipt
        ? "Wrapper must contain the manifest, tree, and optional root receipt"
        : "Wrapper must contain only clean-room-manifest.json and tree"
    );
  }
  const manifestMetadata = await lstat(
    path.join(wrapperRoot, "clean-room-manifest.json")
  );
  if (!manifestMetadata.isFile() || manifestMetadata.isSymbolicLink()) {
    fail(
      "manifest-type-mismatch",
      "Clean-room manifest must be a regular file"
    );
  }
  const treeMetadata = await lstat(path.join(wrapperRoot, "tree"));
  if (!treeMetadata.isDirectory() || treeMetadata.isSymbolicLink()) {
    fail("tree-type-mismatch", "Candidate tree must be a real directory");
  }
  return wrapperRoot;
}

function assertExpectedManifestDigest(actual, expected, phase) {
  if (phase === "candidate" && !expected) {
    fail(
      "missing-manifest-sha256",
      "Candidate verification requires the original export manifest SHA-256"
    );
  }
  if (expected && expected !== actual) {
    fail(
      "manifest-sha256-mismatch",
      "Manifest differs from the original export receipt"
    );
  }
}

async function writeCandidateFile(treeRoot, entry, bytes) {
  const destination = path.join(treeRoot, ...entry.path.split("/"));
  await mkdir(path.dirname(destination), { mode: 0o700, recursive: true });
  await writeFile(destination, bytes, {
    flag: "wx",
    mode: entry.mode === "100755" ? 0o700 : 0o600,
  });
  await chmod(destination, entry.mode === "100755" ? 0o755 : 0o644);
}

async function listTreeEntries(root, relative = "") {
  const absolute = relative ? path.join(root, relative) : root;
  const children = await readdir(absolute, { withFileTypes: true });
  const entries = [];
  for (const child of children.sort((left, right) =>
    comparePaths(left.name, right.name)
  )) {
    const childRelative = relative ? `${relative}/${child.name}` : child.name;
    validatePath(childRelative);
    const childAbsolute = path.join(root, ...childRelative.split("/"));
    const metadata = await lstat(childAbsolute);
    if (metadata.isSymbolicLink()) {
      fail(
        "candidate-symlink",
        `Candidate contains a symlink: ${childRelative}`
      );
    }
    if (metadata.isDirectory()) {
      const descendants = await listTreeEntries(root, childRelative);
      if (descendants.length === 0) {
        fail("candidate-empty-directory", `Empty directory: ${childRelative}`);
      }
      entries.push(...descendants);
      continue;
    }
    if (!metadata.isFile()) {
      fail("candidate-special-file", `Non-regular file: ${childRelative}`);
    }
    entries.push({ metadata, path: childRelative });
  }
  return entries;
}

async function readCanonicalManifest(wrapperRoot) {
  const manifestPath = path.join(wrapperRoot, "clean-room-manifest.json");
  const bytes = await readFile(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("invalid-manifest", "Manifest is not valid JSON");
  }
  const canonical = Buffer.from(canonicalJson(manifest));
  if (Buffer.compare(bytes, canonical) !== 0) {
    fail("noncanonical-manifest", "Manifest bytes are not canonical");
  }
  if (
    manifest.format_version !== FORMAT_VERSION ||
    manifest.hash_algorithm !== "sha256" ||
    !Array.isArray(manifest.files)
  ) {
    fail("invalid-manifest", "Unsupported clean-room manifest");
  }
  const sorted = [...manifest.files].sort((left, right) =>
    comparePaths(left.path, right.path)
  );
  if (
    manifest.files.some((entry, index) => entry.path !== sorted[index]?.path)
  ) {
    fail("invalid-manifest", "Manifest paths are not bytewise sorted");
  }
  for (const entry of manifest.files) {
    validatePath(entry.path);
    const metadataIsValid =
      ["include", "regenerate"].includes(entry.decision) &&
      MODES.has(entry.mode) &&
      SHA256_PATTERN.test(entry.sha256) &&
      Number.isSafeInteger(entry.size_bytes) &&
      entry.size_bytes >= 0;
    if (!metadataIsValid) {
      fail("invalid-manifest", `Invalid manifest entry: ${entry.path}`);
    }
  }
  return { bytes, manifest };
}

async function verifyFile(entry, treeRoot) {
  const absolute = path.join(treeRoot, ...entry.path.split("/"));
  const metadata = await lstat(absolute);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail("candidate-file-type", `Expected regular file: ${entry.path}`);
  }
  const expectedMode = entry.mode === "100755" ? 0o755 : 0o644;
  if (filePermissions(metadata.mode) !== expectedMode) {
    fail("candidate-mode-mismatch", `Mode mismatch: ${entry.path}`);
  }
  const bytes = await readFile(absolute);
  if (
    bytes.length !== entry.size_bytes ||
    `sha256:${sha256(bytes)}` !== entry.sha256
  ) {
    fail("candidate-hash-mismatch", `Hash or size mismatch: ${entry.path}`);
  }
}

export async function verifyCandidate({
  destination,
  expectedManifestSha256,
  phase = "export",
} = {}) {
  if (!destination) {
    fail("missing-destination", "verify requires --destination");
  }
  if (!["candidate", "export"].includes(phase)) {
    fail("invalid-phase", "verify phase must be export or candidate");
  }
  const wrapperRoot = await resolveWrapperRoot(destination);
  const { bytes: manifestBytes, manifest } =
    await readCanonicalManifest(wrapperRoot);
  const manifestSha256 = `sha256:${sha256(manifestBytes)}`;
  assertExpectedManifestDigest(manifestSha256, expectedManifestSha256, phase);
  const expectedFiles = manifest.files.filter(
    (entry) => phase === "candidate" || entry.decision === "include"
  );
  const forbiddenRegenerated = new Set(
    manifest.files
      .filter((entry) => entry.decision === "regenerate")
      .map((entry) => entry.path)
  );
  const treeRoot = path.join(wrapperRoot, "tree");
  const actual = await listTreeEntries(treeRoot);
  const actualPaths = actual.map((entry) => entry.path).sort(comparePaths);
  const expectedPaths = expectedFiles.map((entry) => entry.path);
  if (
    actualPaths.length !== expectedPaths.length ||
    actualPaths.some((candidate, index) => candidate !== expectedPaths[index])
  ) {
    const missing = expectedPaths.filter(
      (candidate) => !actualPaths.includes(candidate)
    );
    const extra = actualPaths.filter(
      (candidate) => !expectedPaths.includes(candidate)
    );
    fail(
      "candidate-path-mismatch",
      `Candidate paths differ; missing=${missing.join(",") || "none"} extra=${extra.join(",") || "none"}`
    );
  }
  if (
    phase === "export" &&
    actualPaths.some((candidate) => forbiddenRegenerated.has(candidate))
  ) {
    fail(
      "regenerated-output-copied",
      "Generated outputs must be recreated inside the clean-room"
    );
  }
  for (const entry of expectedFiles) {
    await verifyFile(entry, treeRoot);
  }
  return {
    file_count: expectedFiles.length,
    manifest_sha256: manifestSha256,
    phase,
    source_commit: manifest.source.commit,
    source_tree: manifest.source.tree,
  };
}

export async function exportCandidate({
  destination,
  policyPath,
  repositoryRoot = REPOSITORY_ROOT,
  sourceRef = "HEAD",
} = {}) {
  if (!policyPath) {
    fail("missing-policy", "export requires --policy");
  }
  const resolvedDestination = assertAbsoluteDestination(
    destination,
    repositoryRoot
  );
  await assertDestinationParentSafe(resolvedDestination, repositoryRoot);
  const { manifest, sourceCommit } = buildManifest({
    policyPath,
    repositoryRoot,
    sourceRef,
  });
  let destinationReserved = false;
  try {
    await reserveDestination(resolvedDestination);
    destinationReserved = true;
    const treeRoot = path.join(resolvedDestination, "tree");
    await mkdir(treeRoot, { mode: 0o700 });
    for (const entry of manifest.files) {
      if (entry.decision !== "include") {
        continue;
      }
      const bytes = git(repositoryRoot, ["cat-file", "blob", entry.git_blob], {
        encoding: "buffer",
      });
      await writeCandidateFile(treeRoot, entry, bytes);
    }
    await writeFile(
      path.join(resolvedDestination, "clean-room-manifest.json"),
      canonicalJson(manifest),
      { encoding: "utf8", mode: 0o600 }
    );
    const verification = await verifyCandidate({
      destination: resolvedDestination,
      phase: "export",
    });
    return {
      decisions: manifest.decisions,
      file_count: manifest.file_count,
      manifest_sha256: verification.manifest_sha256,
      source_commit: sourceCommit,
      source_tree: manifest.source.tree,
    };
  } catch (error) {
    if (destinationReserved) {
      await rm(resolvedDestination, { force: true, recursive: true });
    }
    throw error;
  }
}

function emailDomainIsReserved(domain) {
  const normalized = domain.toLocaleLowerCase("en-US");
  return RESERVED_EMAIL_DOMAINS.some(
    (reserved) => normalized === reserved || normalized.endsWith(`.${reserved}`)
  );
}

async function validateMarkdownLinks(treeRoot, filePath, body) {
  for (const match of body.matchAll(MARKDOWN_LINK_PATTERN)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    }
    target = target.split(MARKDOWN_TITLE_SEPARATOR_PATTERN)[0];
    if (EXTERNAL_LINK_PATTERN.test(target)) {
      continue;
    }
    const localPath = decodeURIComponent(target.split("#", 1)[0]);
    if (!localPath) {
      continue;
    }
    const resolved = path.resolve(path.dirname(filePath), localPath);
    const relative = path.relative(treeRoot, resolved);
    if (
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    ) {
      fail("markdown-link-outside-candidate", `${filePath}: ${target}`);
    }
    try {
      await stat(resolved);
    } catch {
      fail("broken-markdown-link", `${filePath}: ${target}`);
    }
  }
}

function validatePackageManifest(entry, body) {
  const packageManifest = JSON.parse(body);
  if (
    packageManifest.license !== "Apache-2.0" ||
    packageManifest.private !== true
  ) {
    fail("package-license-mismatch", entry.path);
  }
  if (entry.path === "package.json" && packageManifest.name !== "kurobara") {
    fail("private-root-package-name", entry.path);
  }
}

function pathIsApprovedEnvironmentExample(candidate) {
  return path.posix.basename(candidate) === ".env.example";
}

function countEmails(entry, body, allowNonReserved = false) {
  let emailCount = 0;
  for (const match of body.matchAll(EMAIL_PATTERN)) {
    emailCount += 1;
    if (!(allowNonReserved || emailDomainIsReserved(match[1]))) {
      fail("non-reserved-email", `${entry.path}: ${match[0]}`);
    }
  }
  return emailCount;
}

function validatePackageLockEmails(entry, body) {
  let lockfile;
  try {
    lockfile = JSON.parse(body);
  } catch {
    fail("invalid-package-lock", entry.path);
  }
  if (
    lockfile === null ||
    typeof lockfile !== "object" ||
    Array.isArray(lockfile)
  ) {
    fail("invalid-package-lock", entry.path);
  }
  const packageEntries =
    lockfile.packages !== null &&
    typeof lockfile.packages === "object" &&
    !Array.isArray(lockfile.packages)
      ? lockfile.packages
      : {};
  let emailCount = 0;
  const visit = (candidate, keys) => {
    if (typeof candidate === "string") {
      const packageMetadata =
        keys.length === 3 &&
        keys[0] === "packages" &&
        keys[1].startsWith("node_modules/") &&
        keys[2] === "deprecated"
          ? packageEntries[keys[1]]
          : undefined;
      const isRegistryBoundDeprecation =
        packageMetadata !== null &&
        typeof packageMetadata === "object" &&
        !Array.isArray(packageMetadata) &&
        typeof packageMetadata.resolved === "string" &&
        packageMetadata.resolved.startsWith("https://registry.npmjs.org/") &&
        typeof packageMetadata.integrity === "string" &&
        packageMetadata.integrity.length > 0;
      emailCount += countEmails(entry, candidate, isRegistryBoundDeprecation);
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((child, index) => {
        visit(child, [...keys, String(index)]);
      });
      return;
    }
    if (candidate !== null && typeof candidate === "object") {
      for (const [key, child] of Object.entries(candidate)) {
        emailCount += countEmails(entry, key);
        visit(child, [...keys, key]);
      }
    }
  };
  visit(lockfile, []);
  return emailCount;
}

function validateTextPrivacy(entry, body) {
  if (
    FORBIDDEN_CONTENT.some((token) => body.includes(token)) ||
    HOME_PATH_PATTERN.test(body)
  ) {
    fail("private-content-detected", entry.path);
  }
  const emailCount =
    entry.path === "package-lock.json"
      ? validatePackageLockEmails(entry, body)
      : countEmails(entry, body);
  if (PHONE_PATTERN.test(body)) {
    PHONE_PATTERN.lastIndex = 0;
    fail("plausible-phone-number", entry.path);
  }
  PHONE_PATTERN.lastIndex = 0;
  return emailCount;
}

async function inspectCandidateText({ absolute, body, entry, treeRoot }) {
  const counts = {
    emailCount: validateTextPrivacy(entry, body),
    markdownCount: 0,
    packageManifestCount: 0,
  };
  if (entry.path.endsWith(".md")) {
    counts.markdownCount = 1;
    await validateMarkdownLinks(treeRoot, absolute, body);
  }
  if (entry.path.endsWith("package.json")) {
    counts.packageManifestCount = 1;
    validatePackageManifest(entry, body);
  }
  return counts;
}

function failBinaryAsset(entry, reason) {
  fail("invalid-approved-binary-asset", `${entry.path}: ${reason}`);
}

function inspectWebpAsset(entry, bytes) {
  if (
    bytes.length < 30 ||
    bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
    bytes.subarray(8, 12).toString("ascii") !== "WEBP"
  ) {
    failBinaryAsset(entry, "invalid WebP signature");
  }
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) {
    failBinaryAsset(entry, "invalid WebP container length");
  }

  const chunkType = bytes.subarray(12, 16).toString("ascii");
  const chunkLength = bytes.readUInt32LE(16);
  const paddedChunkLength = chunkLength + (chunkLength % 2);
  if (
    chunkType !== "VP8 " ||
    chunkLength < 10 ||
    20 + paddedChunkLength !== bytes.length
  ) {
    failBinaryAsset(entry, "expected one metadata-free VP8 chunk");
  }
}

function readJpegMarker(entry, bytes, startOffset) {
  if (bytes[startOffset] !== 0xff) {
    failBinaryAsset(entry, "invalid JPEG marker boundary");
  }
  let offset = startOffset;
  while (bytes[offset] === 0xff) {
    offset += 1;
  }
  const marker = bytes[offset];
  offset += 1;

  if (
    marker === undefined ||
    marker === 0x00 ||
    marker === 0xd8 ||
    marker === 0x01 ||
    (marker >= 0xd0 && marker <= 0xd7)
  ) {
    failBinaryAsset(entry, "unexpected JPEG marker");
  }
  return { marker, offset };
}

function readJpegSegment(entry, bytes, marker, offset) {
  if (marker === 0xfe || (marker >= 0xe1 && marker <= 0xef)) {
    failBinaryAsset(entry, "JPEG metadata is not allowed");
  }
  if (!JPEG_ALLOWED_SEGMENT_MARKERS.has(marker) || offset + 2 > bytes.length) {
    failBinaryAsset(entry, "unsupported JPEG segment");
  }

  const segmentLength = bytes.readUInt16BE(offset);
  if (segmentLength < 2 || offset + segmentLength > bytes.length) {
    failBinaryAsset(entry, "invalid JPEG segment length");
  }
  const dataStart = offset + 2;
  if (
    marker === 0xe0 &&
    bytes.subarray(dataStart, dataStart + 5).toString("ascii") !== "JFIF\u0000"
  ) {
    failBinaryAsset(entry, "unexpected JPEG application segment");
  }
  return {
    isFrame: marker === 0xc0 || marker === 0xc2,
    isScan: marker === 0xda,
    offset: offset + segmentLength,
  };
}

function findJpegScanBoundary(entry, bytes, startOffset) {
  let offset = startOffset;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const markerStart = offset;
    while (bytes[offset] === 0xff) {
      offset += 1;
    }
    const marker = bytes[offset];
    if (
      marker === 0x00 ||
      (marker !== undefined && marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset += 1;
      continue;
    }
    return markerStart;
  }
  failBinaryAsset(entry, "unterminated JPEG scan");
}

function inspectJpegAsset(entry, bytes) {
  if (
    bytes.length < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes.at(-2) !== 0xff ||
    bytes.at(-1) !== 0xd9
  ) {
    failBinaryAsset(entry, "invalid JPEG boundary");
  }

  let offset = 2;
  let sawFrame = false;
  let sawScan = false;
  while (offset < bytes.length) {
    const markerResult = readJpegMarker(entry, bytes, offset);
    offset = markerResult.offset;
    if (markerResult.marker === 0xd9) {
      if (offset !== bytes.length || !sawFrame || !sawScan) {
        failBinaryAsset(entry, "invalid JPEG image termination");
      }
      return;
    }

    const segment = readJpegSegment(entry, bytes, markerResult.marker, offset);
    sawFrame ||= segment.isFrame;
    sawScan ||= segment.isScan;
    offset = segment.isScan
      ? findJpegScanBoundary(entry, bytes, segment.offset)
      : segment.offset;
  }
  failBinaryAsset(entry, "missing JPEG end marker");
}

function inspectApprovedBinaryAsset(entry, bytes) {
  const policy = APPROVED_BINARY_ASSETS.get(entry.path);
  if (!policy) {
    return false;
  }
  if (bytes.length === 0 || bytes.length > policy.maxBytes) {
    failBinaryAsset(entry, "asset exceeds its bounded size");
  }
  if (policy.format === "webp-vp8") {
    inspectWebpAsset(entry, bytes);
  } else if (policy.format === "jpeg") {
    inspectJpegAsset(entry, bytes);
  } else {
    failBinaryAsset(entry, "unsupported approved format");
  }
  return true;
}

export async function scanCandidate({
  destination,
  expectedManifestSha256,
} = {}) {
  const wrapperRoot = await resolveWrapperRoot(destination);
  await verifyCandidate({
    destination: wrapperRoot,
    expectedManifestSha256,
    phase: "candidate",
  });
  const { manifest } = await readCanonicalManifest(wrapperRoot);
  const treeRoot = path.join(wrapperRoot, "tree");
  let emailCount = 0;
  let markdownCount = 0;
  let packageManifestCount = 0;
  for (const entry of manifest.files) {
    if (
      SUSPICIOUS_FILE_PATTERN.test(entry.path) &&
      !pathIsApprovedEnvironmentExample(entry.path)
    ) {
      fail("suspicious-candidate-path", entry.path);
    }
    const absolute = path.join(treeRoot, ...entry.path.split("/"));
    const bytes = await readFile(absolute);
    if (inspectApprovedBinaryAsset(entry, bytes)) {
      continue;
    }
    if (bytes.includes(0)) {
      fail("binary-candidate-file", entry.path);
    }
    const body = bytes.toString("utf8");
    if (Buffer.compare(Buffer.from(body), bytes) !== 0) {
      fail("non-utf8-candidate-file", entry.path);
    }
    const counts = await inspectCandidateText({
      absolute,
      body,
      entry,
      treeRoot,
    });
    emailCount += counts.emailCount;
    markdownCount += counts.markdownCount;
    packageManifestCount += counts.packageManifestCount;
  }
  const license = await readFile(path.join(treeRoot, "LICENSE"));
  if (sha256(license) !== APACHE_LICENSE_SHA256) {
    fail("license-hash-mismatch", "LICENSE does not match the approved text");
  }
  return {
    email_count: emailCount,
    file_count: manifest.file_count,
    markdown_file_count: markdownCount,
    package_manifest_count: packageManifestCount,
  };
}

function assertNoreplyIdentity(name, email) {
  if (!(name && NOREPLY_EMAIL_PATTERN.test(email))) {
    fail(
      "invalid-root-identity",
      "Root commit requires a name and a GitHub numeric noreply email"
    );
  }
}

function normalizeSigningFingerprint(signingKey) {
  const normalized = String(signingKey ?? "").toUpperCase();
  if (!SIGNING_FINGERPRINT_PATTERN.test(normalized)) {
    fail(
      "invalid-signing-key",
      "Root commit requires a full 40-character OpenPGP fingerprint"
    );
  }
  return normalized;
}

function gitTreeManifest(repositoryRoot, revision) {
  const entries = parseTreeEntries(repositoryRoot, revision);
  return entries.map((entry) => {
    const bytes = git(repositoryRoot, ["cat-file", "blob", entry.git_blob], {
      encoding: "buffer",
    });
    return {
      ...entry,
      sha256: `sha256:${sha256(bytes)}`,
    };
  });
}

async function assertGitIsolation(treeRoot) {
  const gitDirectory = path.join(treeRoot, ".git");
  const gitMetadata = await lstat(gitDirectory);
  if (!gitMetadata.isDirectory() || gitMetadata.isSymbolicLink()) {
    fail("root-git-metadata", "Candidate .git must be a real directory");
  }
  for (const relative of [
    "info/grafts",
    "objects/info/alternates",
    "shallow",
  ]) {
    try {
      await lstat(path.join(gitDirectory, ...relative.split("/")));
      fail(
        "root-external-history",
        `Forbidden Git metadata exists: ${relative}`
      );
    } catch (error) {
      if (error instanceof CleanRoomError) {
        throw error;
      }
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  const references = git(treeRoot, ["for-each-ref", "--format=%(refname)"])
    .trim()
    .split("\n")
    .filter(Boolean);
  if (references.length !== 1 || references[0] !== "refs/heads/main") {
    fail(
      "root-extra-refs",
      "Candidate repository may contain only refs/heads/main"
    );
  }
  const fsck = gitStatus(treeRoot, [
    "fsck",
    "--full",
    "--strict",
    "--no-reflogs",
    "--unreachable",
    "--no-progress",
  ]);
  const fsckOutput = `${fsck.stdout ?? ""}${fsck.stderr ?? ""}`.trim();
  if (fsck.status !== 0 || fsckOutput) {
    fail(
      "root-object-database-invalid",
      "Candidate object database contains invalid or unreachable objects"
    );
  }
}

export async function verifyRootCommit({
  destination,
  expectedEmail,
  expectedManifestSha256,
  expectedName,
  expectedSigningKey,
} = {}) {
  assertNoreplyIdentity(expectedName, expectedEmail);
  const signingFingerprint = normalizeSigningFingerprint(expectedSigningKey);
  const wrapperRoot = await resolveWrapperRoot(destination, {
    allowRootReceipt: true,
  });
  const treeRoot = path.join(wrapperRoot, "tree");
  const { bytes: manifestBytes, manifest } =
    await readCanonicalManifest(wrapperRoot);
  const manifestSha256 = `sha256:${sha256(manifestBytes)}`;
  assertExpectedManifestDigest(
    manifestSha256,
    expectedManifestSha256,
    "candidate"
  );
  await assertGitIsolation(treeRoot);
  if (git(treeRoot, ["rev-list", "--count", "--all"]).trim() !== "1") {
    fail("root-history-count", "Candidate repository must contain one commit");
  }
  const rootLine = git(treeRoot, ["rev-list", "--parents", "-n", "1", "HEAD"])
    .trim()
    .split(TREE_METADATA_SEPARATOR_PATTERN);
  if (rootLine.length !== 1) {
    fail("root-has-parent", "Candidate root commit must have no parent");
  }
  if (git(treeRoot, ["branch", "--show-current"]).trim() !== "main") {
    fail("root-branch-mismatch", "Candidate branch must be main");
  }
  if (git(treeRoot, ["remote"]).trim()) {
    fail("root-has-remote", "Candidate repository must not have a remote");
  }
  const [
    authorName,
    committerName,
    authorEmail,
    committerEmail,
    ...messageLines
  ] = git(treeRoot, [
    "show",
    "-s",
    "--format=%an%n%cn%n%ae%n%ce%n%B",
    "HEAD",
  ]).split("\n");
  const message = messageLines.join("\n");
  const signoffLines = message
    .split("\n")
    .filter((line) => line.toLowerCase().startsWith("signed-off-by:"));
  const expectedSignoff = `Signed-off-by: ${expectedName} <${expectedEmail}>`;
  if (
    authorName !== expectedName ||
    committerName !== expectedName ||
    authorEmail !== expectedEmail ||
    committerEmail !== expectedEmail ||
    signoffLines.length !== 1 ||
    signoffLines[0] !== expectedSignoff
  ) {
    fail(
      "root-identity-mismatch",
      "Root author, committer or DCO sign-off differs"
    );
  }
  const verification = gitStatus(treeRoot, ["verify-commit", "--raw", "HEAD"]);
  const signatureOutput = `${verification.stdout ?? ""}${verification.stderr ?? ""}`;
  const validSignatureLine = signatureOutput
    .split("\n")
    .find((line) => line.startsWith(GPG_VALID_SIGNATURE_PREFIX));
  const signatureFingerprints = validSignatureLine
    ? validSignatureLine
        .slice(GPG_VALID_SIGNATURE_PREFIX.length)
        .split(TREE_METADATA_SEPARATOR_PATTERN)
        .map((value) => value.toUpperCase())
    : [];
  if (
    verification.status !== 0 ||
    !signatureFingerprints.includes(signingFingerprint)
  ) {
    fail("root-signature-invalid", "Root commit signature verification failed");
  }
  const sourceObject = gitStatus(treeRoot, [
    "cat-file",
    "-e",
    `${manifest.source.commit}^{commit}`,
  ]);
  if (sourceObject.status === 0) {
    fail(
      "source-history-present",
      "Source commit object leaked into candidate"
    );
  }
  const expected = manifest.files.map((entry) => ({
    git_blob: entry.git_blob,
    mode: entry.mode,
    path: entry.path,
    sha256: entry.sha256,
    size_bytes: entry.size_bytes,
  }));
  const actual = gitTreeManifest(treeRoot, "HEAD");
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    fail(
      "root-tree-mismatch",
      "Root commit tree differs from clean-room manifest"
    );
  }
  if (git(treeRoot, ["status", "--porcelain=v1"]).trim()) {
    fail("root-worktree-dirty", "Candidate repository worktree is dirty");
  }
  return {
    file_count: manifest.file_count,
    manifest_sha256: manifestSha256,
    root_commit: git(treeRoot, ["rev-parse", "HEAD"]).trim(),
    root_tree: git(treeRoot, ["rev-parse", "HEAD^{tree}"]).trim(),
    signing_fingerprint: signingFingerprint,
    signature: "verified",
  };
}

export async function bootstrapCandidate({
  destination,
  email,
  expectedManifestSha256,
  message = "Initial open-source preview",
  name,
  signingKey,
} = {}) {
  assertNoreplyIdentity(name, email);
  const signingFingerprint = normalizeSigningFingerprint(signingKey);
  const wrapperRoot = await resolveWrapperRoot(destination);
  await verifyCandidate({
    destination: wrapperRoot,
    expectedManifestSha256,
    phase: "candidate",
  });
  await scanCandidate({
    destination: wrapperRoot,
    expectedManifestSha256,
  });
  const treeRoot = path.join(wrapperRoot, "tree");
  const gitDirectory = path.join(treeRoot, ".git");
  const receiptPath = path.join(wrapperRoot, "root-commit-receipt.json");
  try {
    git(treeRoot, ["init", "--initial-branch=main"]);
    git(treeRoot, ["config", "user.name", name]);
    git(treeRoot, ["config", "user.email", email]);
    git(treeRoot, ["config", "user.signingkey", signingFingerprint]);
    git(treeRoot, ["config", "gpg.format", "openpgp"]);
    git(treeRoot, ["config", "commit.gpgsign", "true"]);
    git(treeRoot, ["config", "core.autocrlf", "false"]);
    git(treeRoot, ["config", "core.attributesfile", "/dev/null"]);
    git(treeRoot, ["config", "core.excludesfile", "/dev/null"]);
    git(treeRoot, ["config", "core.hooksPath", "/dev/null"]);
    git(treeRoot, ["add", "--all"]);
    git(treeRoot, ["commit", "-S", "-s", "-m", message]);
    const receipt = await verifyRootCommit({
      destination: wrapperRoot,
      expectedEmail: email,
      expectedManifestSha256,
      expectedName: name,
      expectedSigningKey: signingFingerprint,
    });
    await writeFile(receiptPath, canonicalJson(receipt), {
      encoding: "utf8",
      mode: 0o600,
    });
    return receipt;
  } catch (error) {
    await rm(receiptPath, { force: true });
    await rm(gitDirectory, { force: true, recursive: true });
    throw error;
  }
}

function parseArguments(arguments_) {
  const [command, ...rest] = arguments_;
  if (!command || command.startsWith("-")) {
    fail(
      "missing-command",
      "Expected policy, export, verify, scan, bootstrap or verify-root"
    );
  }
  const allowedOptions = COMMAND_OPTIONS.get(command);
  if (!allowedOptions) {
    fail("unknown-command", `Unknown command: ${command}`);
  }
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!(flag?.startsWith("--") && value && !value.startsWith("--"))) {
      fail("invalid-arguments", `Invalid argument near ${flag ?? "end"}`);
    }
    const key = flag.slice(2).replaceAll("-", "_");
    if (!allowedOptions.has(key)) {
      fail("unknown-argument", `Unknown argument for ${command}: ${flag}`);
    }
    if (key in options) {
      fail("duplicate-argument", `Duplicate argument: ${flag}`);
    }
    options[key] = value;
  }
  return { command, options };
}

function usage() {
  return `Usage:
  node scripts/clean-room.mjs policy --output <tracked-policy.tsv>
  node scripts/clean-room.mjs export --policy <policy.tsv> --destination <absolute-new-dir> [--source-ref <ref>]
  node scripts/clean-room.mjs verify --destination <absolute-dir> [--phase export|candidate] [--manifest-sha256 <export-digest>]
  node scripts/clean-room.mjs scan --destination <absolute-dir> --manifest-sha256 <export-digest>
  node scripts/clean-room.mjs bootstrap --destination <absolute-dir> --manifest-sha256 <export-digest> --name <name> --email <numeric-noreply> --signing-key <fingerprint> [--message <message>]
  node scripts/clean-room.mjs verify-root --destination <absolute-dir> --manifest-sha256 <export-digest> --name <name> --email <numeric-noreply> --signing-key <fingerprint>
`;
}

async function main() {
  if (process.argv.length === 2 || process.argv.includes("--help")) {
    process.stdout.write(usage());
    return;
  }
  const { command, options } = parseArguments(process.argv.slice(2));
  let result;
  if (command === "policy") {
    result = await writePolicy({
      outputPath: options.output,
      repositoryRoot: REPOSITORY_ROOT,
    });
  } else if (command === "export") {
    result = await exportCandidate({
      destination: options.destination,
      policyPath: options.policy
        ? path.resolve(REPOSITORY_ROOT, options.policy)
        : undefined,
      repositoryRoot: REPOSITORY_ROOT,
      sourceRef: options.source_ref ?? "HEAD",
    });
  } else if (command === "verify") {
    result = await verifyCandidate({
      destination: options.destination,
      expectedManifestSha256: options.manifest_sha256,
      phase: options.phase ?? "export",
    });
  } else if (command === "scan") {
    result = await scanCandidate({
      destination: options.destination,
      expectedManifestSha256: options.manifest_sha256,
    });
  } else if (command === "bootstrap") {
    result = await bootstrapCandidate({
      destination: options.destination,
      email: options.email,
      expectedManifestSha256: options.manifest_sha256,
      message: options.message,
      name: options.name,
      signingKey: options.signing_key,
    });
  } else if (command === "verify-root") {
    result = await verifyRootCommit({
      destination: options.destination,
      expectedEmail: options.email,
      expectedManifestSha256: options.manifest_sha256,
      expectedName: options.name,
      expectedSigningKey: options.signing_key,
    });
  } else {
    fail("unknown-command", `Unknown command: ${command}`);
  }
  process.stdout.write(canonicalJson(result));
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  main().catch((error) => {
    const code =
      error instanceof CleanRoomError ? error.code : "unexpected-error";
    process.stderr.write(`${code}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
