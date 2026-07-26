import path from "node:path";
import { fileURLToPath } from "node:url";
import { runSidecarConformance } from "../../src/runner.ts";
import { INJECTED_CATALOG_MANIFEST } from "./catalog-mutation-before-runner.ts";
import { fixtureRequests } from "./fixture-values.ts";

const canary = "SYNTHETIC-CONFORMANCE-CANARY";
const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const pidLog = process.argv[2];
if (!pidLog) {
  throw new TypeError("The catalog mutation probe requires a PID log path.");
}

const report = await runSidecarConformance({
  canary,
  effectProbe: {
    read: () => Promise.resolve({ effectCount: 0, operationKeys: [] }),
  },
  host: {
    arguments: [
      "--conditions=kurobara-source",
      "--experimental-strip-types",
      path.join(packageRoot, "test/fixtures/one-request-sidecar.ts"),
      "good",
      `${pidLog}.effects`,
      canary,
      pidLog,
    ],
    callTimeoutMs: 5000,
    executablePath: process.execPath,
    expectedManifest: INJECTED_CATALOG_MANIFEST,
    workingDirectory: packageRoot,
  },
  requests: fixtureRequests(canary),
  subject: {
    artifactFingerprint: `sha256:${"f".repeat(64)}`,
    packageName: "@example/conformance-subject",
    packageVersion: "1.0.0",
  },
});

const compatibility = report.guarantees.find(
  (guarantee) => guarantee.id === "compatibility.exact-versions"
);
if (
  compatibility?.status !== "failed" ||
  compatibility.reason_codes.length !== 1 ||
  compatibility.reason_codes[0] !== "compatibility-unsupported"
) {
  throw new Error("The mutated catalog was not rejected before host spawn.");
}
