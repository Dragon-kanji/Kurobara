import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  createHttpApp,
  type HttpAdapterDependencies,
} from "@kurobara/adapter-http";
import { createKurobaraClient } from "@kurobara/sdk";

const body =
  '{"display_name":"Synthetic Contact","work_email":"synthetic@example.test"}\n';
const bodyBytes = new TextEncoder().encode(body);
const bodyHash = `sha256:${createHash("sha256")
  .update(bodyBytes)
  .digest("hex")}`;

const unexpected = (): never => {
  throw new Error("Unexpected dependency call.");
};

const dependencies = {
  applyRecipe: unexpected,
  authenticateApiKey: () =>
    Promise.resolve({
      ok: true,
      value: {
        actorId: "actor-http-sdk-export",
        authenticationMode: "api-key",
        credentialId: "credential-http-sdk-export",
        permissions: ["datasets:export"],
        workspaceId: "workspace-http-sdk-export",
      },
    }),
  cancelRun: unexpected,
  createRun: unexpected,
  exportDataset: () =>
    Promise.resolve({
      ok: true,
      value: {
        contentHash: bodyHash,
        contentLength: bodyBytes.byteLength,
        dataset: {
          datasetId: "dataset-http-sdk-export",
          name: "Synthetic Contact export",
          workspaceId: "workspace-http-sdk-export",
        },
        events: {
          async *[Symbol.asyncIterator]() {
            await Promise.resolve();
            yield {
              bytes: bodyBytes,
              recordNumber: 1,
              type: "chunk",
            } as const;
          },
        },
        fields: [],
        format: "jsonl",
      },
    }),
  exportRecipeApplication: unexpected,
  getRecipeApplicationStatus: unexpected,
  getRun: unexpected,
  importDataset: unexpected,
  listCapabilities: unexpected,
  listCompanyCandidates: unexpected,
  quoteRunPlan: unexpected,
  readiness: () => true,
} as unknown as HttpAdapterDependencies;

test("the SDK consumes the real chunked dataset export handler", async () => {
  const app = createHttpApp(dependencies);
  const client = createKurobaraClient({
    apiKey: "synthetic-api-key",
    baseUrl: "http://kurobara.invalid",
    fetch: (input, init) => app.request(new Request(input, init)),
  });

  const exported = await client.datasets.export({
    dataset_id: "dataset-http-sdk-export",
    format: "jsonl",
  });
  assert.equal(exported.contentLength, bodyBytes.byteLength);
  assert.equal(exported.contentSha256, bodyHash);
  assert.equal(exported.contentType, "application/x-ndjson");
  assert.equal(exported.filename, "kurobara-dataset.jsonl");

  const chunks: Uint8Array[] = [];
  for await (const chunk of exported.bytes) {
    chunks.push(chunk);
  }
  assert.equal(new TextDecoder().decode(Buffer.concat(chunks)), body);
});
