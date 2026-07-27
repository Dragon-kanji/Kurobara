import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  bootstrapCandidate,
  CleanRoomError,
  exportCandidate,
  scanCandidate,
  verifyCandidate,
  writePolicy,
} from "../../scripts/clean-room.mjs";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const PUBLIC_DEPENDENCY_EMAIL = ["support", "npmjs.com"].join("@");
const PRIVATE_CONTACT_EMAIL = ["private-contact", "npmjs.com"].join("@");

function git(repositoryRoot, arguments_) {
  return execFileSync("git", ["-C", repositoryRoot, ...arguments_], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function writeFixtureFiles(repositoryRoot) {
  await mkdir(path.join(repositoryRoot, "alpha"), { recursive: true });
  await mkdir(path.join(repositoryRoot, "config"), { recursive: true });
  await mkdir(path.join(repositoryRoot, "docs/audits"), { recursive: true });
  await mkdir(path.join(repositoryRoot, "docs/publication"), {
    recursive: true,
  });
  await mkdir(path.join(repositoryRoot, "packages/contracts/src/generated"), {
    recursive: true,
  });
  await writeFile(
    path.join(repositoryRoot, "alpha/nested.txt"),
    "nested\n",
    "utf8"
  );
  await writeFile(path.join(repositoryRoot, "alpha.txt"), "sibling\n", "utf8");
  await writeFile(
    path.join(repositoryRoot, "config/.env.example"),
    "FIXTURE_TOKEN=synthetic-value\n",
    "utf8"
  );
  await writeFile(
    path.join(repositoryRoot, ".gitignore"),
    "ignored.txt\nnode_modules\n",
    "utf8"
  );
  await writeFile(
    path.join(repositoryRoot, "README.md"),
    "# Fixture\n\n[Licence](./LICENSE)\n",
    "utf8"
  );
  await writeFile(
    path.join(repositoryRoot, "LICENSE"),
    await readFile(path.join(REPOSITORY_ROOT, "LICENSE"))
  );
  await writeFile(
    path.join(repositoryRoot, "bin.sh"),
    "#!/bin/sh\nexit 0\n",
    "utf8"
  );
  await chmod(path.join(repositoryRoot, "bin.sh"), 0o755);
  await writeFile(
    path.join(repositoryRoot, "docs/audits/internal.md"),
    "source private evidence\n",
    "utf8"
  );
  await writeFile(
    path.join(repositoryRoot, "docs/publication/clean-room-policy.tsv"),
    "decision\tpath\treason\tcuration_owner\tprovenance\tlicense_review\n",
    "utf8"
  );
  await writeFile(
    path.join(repositoryRoot, "package.json"),
    `${JSON.stringify(
      {
        license: "Apache-2.0",
        name: "kurobara",
        private: true,
        type: "module",
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(repositoryRoot, "package-lock.json"),
    `${JSON.stringify(
      {
        lockfileVersion: 3,
        name: "kurobara",
        packages: {
          "": {
            license: "Apache-2.0",
            name: "kurobara",
            version: "0.1.0",
          },
          "node_modules/public-deprecation-fixture": {
            deprecated: `Public dependency support is available at ${PUBLIC_DEPENDENCY_EMAIL}`,
            integrity: "sha512-synthetic-fixture",
            resolved:
              "https://registry.npmjs.org/public-deprecation-fixture/-/public-deprecation-fixture-1.0.0.tgz",
            version: "1.0.0",
          },
        },
        requires: true,
        version: "0.1.0",
      },
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeFile(
    path.join(repositoryRoot, "packages/contracts/src/generated/v1.ts"),
    'export const generated = "fixture";\n',
    "utf8"
  );
}

async function createFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "kurobara-clean-room-test-"));
  const repositoryRoot = path.join(root, "source");
  await mkdir(repositoryRoot);
  git(repositoryRoot, ["init", "--initial-branch=main"]);
  await writeFixtureFiles(repositoryRoot);
  git(repositoryRoot, ["add", "--all"]);
  git(repositoryRoot, ["commit", "--no-gpg-sign", "-m", "fixture"]);
  await writePolicy({
    outputPath: "docs/publication/clean-room-policy.tsv",
    repositoryRoot,
  });
  git(repositoryRoot, ["add", "docs/publication/clean-room-policy.tsv"]);
  git(repositoryRoot, [
    "commit",
    "--no-gpg-sign",
    "-m",
    "classify fixture tree",
  ]);
  await writeFile(
    path.join(repositoryRoot, "ignored.txt"),
    "ignored\n",
    "utf8"
  );
  await writeFile(
    path.join(repositoryRoot, "untracked.txt"),
    "untracked\n",
    "utf8"
  );
  return {
    policyPath: path.join(
      repositoryRoot,
      "docs/publication/clean-room-policy.tsv"
    ),
    repositoryRoot,
    root,
  };
}

async function commitPolicyUpdate(fixture, message) {
  git(fixture.repositoryRoot, ["add", "--all", ".", ":(exclude)untracked.txt"]);
  await writePolicy({
    outputPath: "docs/publication/clean-room-policy.tsv",
    repositoryRoot: fixture.repositoryRoot,
  });
  git(fixture.repositoryRoot, [
    "add",
    "docs/publication/clean-room-policy.tsv",
  ]);
  git(fixture.repositoryRoot, ["commit", "--no-gpg-sign", "-m", message]);
}

async function materializeGeneratedOutput(destination, repositoryRoot) {
  const relative = "packages/contracts/src/generated/v1.ts";
  const target = path.join(destination, "tree", relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, await readFile(path.join(repositoryRoot, relative)), {
    mode: 0o644,
  });
}

test("exports only classified HEAD blobs and reproduces the same manifest", async () => {
  const fixture = await createFixture();
  const first = path.join(fixture.root, "candidate-a");
  const second = path.join(fixture.root, "candidate-b");

  await exportCandidate({ ...fixture, destination: first });
  await exportCandidate({ ...fixture, destination: second });

  const firstReceipt = await verifyCandidate({ destination: first });
  const secondReceipt = await verifyCandidate({ destination: second });
  assert.deepEqual(firstReceipt, secondReceipt);
  assert.deepEqual(
    await readFile(path.join(first, "clean-room-manifest.json")),
    await readFile(path.join(second, "clean-room-manifest.json"))
  );
  await assert.rejects(
    readFile(path.join(first, "tree/docs/audits/internal.md")),
    { code: "ENOENT" }
  );
  await assert.rejects(readFile(path.join(first, "tree/ignored.txt")), {
    code: "ENOENT",
  });
  await assert.rejects(readFile(path.join(first, "tree/untracked.txt")), {
    code: "ENOENT",
  });
  await assert.rejects(
    readFile(path.join(first, "tree/packages/contracts/src/generated/v1.ts")),
    { code: "ENOENT" }
  );
  assert.equal(
    (await stat(path.join(first, "tree/bin.sh"))).mode % 0o1000,
    0o755
  );
});

test("verifies regenerated outputs and the public content scan", async () => {
  const fixture = await createFixture();
  const destination = path.join(fixture.root, "candidate");
  const exportReceipt = await exportCandidate({ ...fixture, destination });
  await materializeGeneratedOutput(destination, fixture.repositoryRoot);

  const receipt = await verifyCandidate({
    destination,
    expectedManifestSha256: exportReceipt.manifest_sha256,
    phase: "candidate",
  });
  assert.equal(receipt.phase, "candidate");
  assert.deepEqual(
    await scanCandidate({
      destination,
      expectedManifestSha256: exportReceipt.manifest_sha256,
    }),
    {
      email_count: 1,
      file_count: 10,
      markdown_file_count: 1,
      package_manifest_count: 1,
    }
  );
});

test("admits only the two audited website images and excludes design references", async () => {
  const fixture = await createFixture();
  const rosePath = "apps/website/public/assets/kurobara-rose.webp";
  const socialPath = "apps/website/public/assets/social/og-kurobara.jpg";
  const designPath = "apps/website/design/desktop-reference.png";
  for (const candidate of [rosePath, socialPath, designPath]) {
    await mkdir(path.dirname(path.join(fixture.repositoryRoot, candidate)), {
      recursive: true,
    });
  }
  const [rose, social] = await Promise.all([
    readFile(path.join(REPOSITORY_ROOT, rosePath)),
    readFile(path.join(REPOSITORY_ROOT, socialPath)),
  ]);
  await Promise.all([
    writeFile(path.join(fixture.repositoryRoot, rosePath), rose),
    writeFile(path.join(fixture.repositoryRoot, socialPath), social),
    writeFile(
      path.join(fixture.repositoryRoot, designPath),
      Buffer.from([0x00, 0x01, 0x02])
    ),
  ]);
  await commitPolicyUpdate(fixture, "add audited website assets");

  const validDestination = path.join(fixture.root, "valid-binary-candidate");
  const validReceipt = await exportCandidate({
    ...fixture,
    destination: validDestination,
  });
  await materializeGeneratedOutput(validDestination, fixture.repositoryRoot);
  assert.deepEqual(
    await scanCandidate({
      destination: validDestination,
      expectedManifestSha256: validReceipt.manifest_sha256,
    }),
    {
      email_count: 1,
      file_count: 12,
      markdown_file_count: 1,
      package_manifest_count: 1,
    }
  );
  await assert.rejects(
    readFile(path.join(validDestination, "tree", designPath)),
    { code: "ENOENT" }
  );

  await writeFile(
    path.join(fixture.repositoryRoot, rosePath),
    Buffer.concat([rose, Buffer.from([0x00])])
  );
  await commitPolicyUpdate(fixture, "corrupt approved website asset");
  const corruptDestination = path.join(
    fixture.root,
    "corrupt-binary-candidate"
  );
  const corruptReceipt = await exportCandidate({
    ...fixture,
    destination: corruptDestination,
  });
  await materializeGeneratedOutput(corruptDestination, fixture.repositoryRoot);
  await assert.rejects(
    scanCandidate({
      destination: corruptDestination,
      expectedManifestSha256: corruptReceipt.manifest_sha256,
    }),
    (error) =>
      error instanceof CleanRoomError &&
      error.code === "invalid-approved-binary-asset"
  );

  await writeFile(
    path.join(fixture.repositoryRoot, rosePath),
    Buffer.alloc(256 * 1024 + 1)
  );
  await commitPolicyUpdate(fixture, "oversize approved website asset");
  const oversizedDestination = path.join(
    fixture.root,
    "oversized-binary-candidate"
  );
  const oversizedReceipt = await exportCandidate({
    ...fixture,
    destination: oversizedDestination,
  });
  await materializeGeneratedOutput(
    oversizedDestination,
    fixture.repositoryRoot
  );
  await assert.rejects(
    scanCandidate({
      destination: oversizedDestination,
      expectedManifestSha256: oversizedReceipt.manifest_sha256,
    }),
    (error) =>
      error instanceof CleanRoomError &&
      error.code === "invalid-approved-binary-asset"
  );

  const exifSegment = Buffer.from([
    0xff, 0xe1, 0x00, 0x08, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
  ]);
  await Promise.all([
    writeFile(path.join(fixture.repositoryRoot, rosePath), rose),
    writeFile(
      path.join(fixture.repositoryRoot, socialPath),
      Buffer.concat([social.subarray(0, 2), exifSegment, social.subarray(2)])
    ),
  ]);
  await commitPolicyUpdate(fixture, "add forbidden website metadata");
  const metadataDestination = path.join(
    fixture.root,
    "metadata-binary-candidate"
  );
  const metadataReceipt = await exportCandidate({
    ...fixture,
    destination: metadataDestination,
  });
  await materializeGeneratedOutput(metadataDestination, fixture.repositoryRoot);
  await assert.rejects(
    scanCandidate({
      destination: metadataDestination,
      expectedManifestSha256: metadataReceipt.manifest_sha256,
    }),
    (error) =>
      error instanceof CleanRoomError &&
      error.code === "invalid-approved-binary-asset"
  );
});

test("keeps unapproved binary files denied by default", async () => {
  const fixture = await createFixture();
  await writeFile(
    path.join(fixture.repositoryRoot, "alpha/unapproved.bin"),
    Buffer.from([0x00, 0x01, 0x02])
  );
  await commitPolicyUpdate(fixture, "add unapproved binary");

  const destination = path.join(fixture.root, "unapproved-binary-candidate");
  const receipt = await exportCandidate({ ...fixture, destination });
  await materializeGeneratedOutput(destination, fixture.repositoryRoot);
  await assert.rejects(
    scanCandidate({
      destination,
      expectedManifestSha256: receipt.manifest_sha256,
    }),
    (error) =>
      error instanceof CleanRoomError && error.code === "binary-candidate-file"
  );
});

test("allows only registry-bound dependency deprecation emails in the lockfile", async () => {
  const fixture = await createFixture();
  const lockfilePath = path.join(fixture.repositoryRoot, "package-lock.json");
  const lockfile = JSON.parse(await readFile(lockfilePath, "utf8"));
  lockfile.private_contact = PRIVATE_CONTACT_EMAIL;
  await writeFile(
    lockfilePath,
    `${JSON.stringify(lockfile, null, 2)}\n`,
    "utf8"
  );
  git(fixture.repositoryRoot, ["add", "package-lock.json"]);
  git(fixture.repositoryRoot, [
    "commit",
    "--no-gpg-sign",
    "-m",
    "add private lockfile contact",
  ]);
  const destination = path.join(fixture.root, "private-lockfile-candidate");
  const exportReceipt = await exportCandidate({
    ...fixture,
    destination,
  });
  await materializeGeneratedOutput(destination, fixture.repositoryRoot);

  await assert.rejects(
    scanCandidate({
      destination,
      expectedManifestSha256: exportReceipt.manifest_sha256,
    }),
    (error) =>
      error instanceof CleanRoomError && error.code === "non-reserved-email"
  );
});

test("rejects tracked dirt and an incomplete policy", async () => {
  const fixture = await createFixture();
  await writeFile(
    path.join(fixture.repositoryRoot, "README.md"),
    "# Dirty\n",
    "utf8"
  );
  await assert.rejects(
    exportCandidate({
      ...fixture,
      destination: path.join(fixture.root, "dirty-candidate"),
    }),
    (error) =>
      error instanceof CleanRoomError && error.code === "dirty-tracked-state"
  );

  git(fixture.repositoryRoot, ["restore", "README.md"]);
  await writeFile(
    path.join(fixture.repositoryRoot, "new.txt"),
    "new\n",
    "utf8"
  );
  git(fixture.repositoryRoot, ["add", "new.txt"]);
  git(fixture.repositoryRoot, [
    "commit",
    "--no-gpg-sign",
    "-m",
    "unclassified file",
  ]);
  await assert.rejects(
    exportCandidate({
      ...fixture,
      destination: path.join(fixture.root, "unclassified-candidate"),
    }),
    (error) =>
      error instanceof CleanRoomError && error.code === "policy-tree-mismatch"
  );
});

test("rejects unsafe destinations, tampering and wrapper extras", async () => {
  const fixture = await createFixture();
  await assert.rejects(
    exportCandidate({
      ...fixture,
      destination: path.join(fixture.repositoryRoot, "candidate"),
    }),
    (error) =>
      error instanceof CleanRoomError && error.code === "unsafe-destination"
  );

  const destination = path.join(fixture.root, "candidate");
  await exportCandidate({ ...fixture, destination });
  await writeFile(
    path.join(destination, "tree/README.md"),
    "# Tampered\n",
    "utf8"
  );
  await assert.rejects(
    verifyCandidate({ destination }),
    (error) =>
      error instanceof CleanRoomError &&
      error.code === "candidate-hash-mismatch"
  );

  const second = path.join(fixture.root, "candidate-extra");
  await exportCandidate({ ...fixture, destination: second });
  await writeFile(path.join(second, "extra.txt"), "extra\n", "utf8");
  await assert.rejects(
    verifyCandidate({ destination: second }),
    (error) =>
      error instanceof CleanRoomError &&
      error.code === "wrapper-layout-mismatch"
  );
});

test("binds candidate verification to the original manifest digest", async () => {
  const fixture = await createFixture();
  const destination = path.join(fixture.root, "candidate");
  const receipt = await exportCandidate({ ...fixture, destination });
  await materializeGeneratedOutput(destination, fixture.repositoryRoot);

  const readmePath = path.join(destination, "tree/README.md");
  const tamperedBytes = Buffer.from("# Co-tampered\n");
  await writeFile(readmePath, tamperedBytes);
  const manifestPath = path.join(destination, "clean-room-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const readme = manifest.files.find((entry) => entry.path === "README.md");
  readme.git_blob = "0".repeat(40);
  readme.sha256 = `sha256:${createHash("sha256")
    .update(tamperedBytes)
    .digest("hex")}`;
  readme.size_bytes = tamperedBytes.length;
  await writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8"
  );

  await assert.rejects(
    verifyCandidate({
      destination,
      expectedManifestSha256: receipt.manifest_sha256,
      phase: "candidate",
    }),
    (error) =>
      error instanceof CleanRoomError &&
      error.code === "manifest-sha256-mismatch"
  );
});

test("rejects wrapper symlinks and a policy outside the source commit", async () => {
  const fixture = await createFixture();
  const destination = path.join(fixture.root, "candidate");
  await exportCandidate({ ...fixture, destination });
  const externalTree = path.join(fixture.root, "external-tree");
  await rename(path.join(destination, "tree"), externalTree);
  await symlink(externalTree, path.join(destination, "tree"), "dir");

  await assert.rejects(
    verifyCandidate({ destination }),
    (error) =>
      error instanceof CleanRoomError && error.code === "tree-type-mismatch"
  );

  const externalPolicy = path.join(fixture.root, "external-policy.tsv");
  await writeFile(externalPolicy, await readFile(fixture.policyPath));
  await assert.rejects(
    exportCandidate({
      ...fixture,
      destination: path.join(fixture.root, "external-policy-candidate"),
      policyPath: externalPolicy,
    }),
    (error) =>
      error instanceof CleanRoomError &&
      error.code === "policy-outside-repository"
  );
});

test("never overwrites a destination and cleans a failed bootstrap", async () => {
  const fixture = await createFixture();
  const existing = path.join(fixture.root, "existing-candidate");
  await mkdir(existing);
  const sentinel = path.join(existing, "sentinel.txt");
  await writeFile(sentinel, "preserve\n", "utf8");
  await assert.rejects(
    exportCandidate({ ...fixture, destination: existing }),
    (error) =>
      error instanceof CleanRoomError && error.code === "destination-exists"
  );
  assert.equal(await readFile(sentinel, "utf8"), "preserve\n");

  const destination = path.join(fixture.root, "bootstrap-candidate");
  const receipt = await exportCandidate({ ...fixture, destination });
  await materializeGeneratedOutput(destination, fixture.repositoryRoot);
  await assert.rejects(
    bootstrapCandidate({
      destination,
      email: "123+fixture@users.noreply.github.com",
      expectedManifestSha256: receipt.manifest_sha256,
      name: "Fixture",
      signingKey: "F".repeat(40),
    }),
    (error) =>
      error instanceof CleanRoomError && error.code === "git-command-failed"
  );
  await assert.rejects(lstat(path.join(destination, "tree/.git")), {
    code: "ENOENT",
  });
});

test("rejects unknown CLI options", () => {
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          path.join(REPOSITORY_ROOT, "scripts/clean-room.mjs"),
          "verify",
          "--destination",
          "/tmp/candidate.invalid",
          "--typo",
          "value",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      ),
    (error) =>
      error.status === 1 &&
      error.stderr.includes("unknown-argument: Unknown argument for verify")
  );
});

test("sanitizes ambient Git repository and config overrides", async () => {
  const fixture = await createFixture();
  const overrides = {
    GIT_AUTHOR_NAME: "Hostile Author",
    GIT_COMMON_DIR: path.join(fixture.root, "missing-common-dir"),
    GIT_COMMITTER_NAME: "Hostile Committer",
    GIT_CONFIG_PARAMETERS: "'core.bare=true'",
    GIT_NAMESPACE: "hostile-namespace",
    GIT_REPLACE_REF_BASE: "refs/hostile",
    GIT_SHALLOW_FILE: path.join(fixture.root, "missing-shallow-file"),
    GIT_TEMPLATE_DIR: path.join(fixture.root, "missing-template-dir"),
  };
  const previous = Object.fromEntries(
    Object.keys(overrides).map((key) => [key, process.env[key]])
  );
  Object.assign(process.env, overrides);
  try {
    const destination = path.join(fixture.root, "candidate");
    const receipt = await exportCandidate({ ...fixture, destination });
    assert.equal(receipt.source_commit.length, 40);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
