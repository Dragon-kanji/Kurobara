import type { AddressInfo } from "node:net";

import { type ServerType, serve } from "@hono/node-server";
import {
  createCsvDatasetCodec,
  createJsonlDatasetCodec,
} from "@kurobara/adapter-dataset-codec";
import {
  contactDiscoveryExecutionQueryContract,
  contactIdentityExecutionQueryContract,
  contactWorkEmailExecutionQueryContract,
  createHttpApp,
  createRecipeCellInputValidator,
  organizationDiscoveryQueryContract,
} from "@kurobara/adapter-http";
import {
  createPostgresDatasetGenerationPlanningSnapshotResolver,
  createPostgresRuntime,
  type PostgresRuntime,
} from "@kurobara/adapter-postgres";
import {
  contactDiscoveryCapability,
  contactIdentityRevealCapability,
  contactWorkEmailResolveCapability,
  contactWorkEmailVerifyCapability,
  createCompanyDiscoveryQueryNormalizer,
  createContactDiscoveryQueryNormalizer,
  createContactIdentityQueryNormalizer,
  createContactWorkEmailQueryNormalizer,
  createDatasetGenerationQueryNormalizerRouter,
  createRandomDatasetGenerationIdentifiers,
  createRandomIdentifiers,
  createRandomPlanningIdentifiers,
  createStaticExecutionCatalog,
  createSystemClock,
  organizationDiscoveryCapability,
} from "@kurobara/adapter-system";
import {
  type ContactExportPolicyTemplate,
  type ContactPrivacyHmacSecret,
  createContactExportPolicyResolver,
  createContactPrivacyTombstoneGuard,
  createHmacContactPrivacySubjectKeyDeriver,
  makeAuthorizeContactEffect,
} from "@kurobara/application";

import type { ApiProcessConfig } from "./config.ts";
import type { ApiProcessService } from "./lifecycle.ts";
import { composeApi } from "./main.ts";

export type ApiServiceAddress = Readonly<{
  host: string;
  port: number;
}>;

export type ApiService = ApiProcessService &
  Readonly<{
    address: () => ApiServiceAddress | null;
  }>;

export type ApiServiceOptions = Readonly<{
  config: ApiProcessConfig;
  contactExportPolicy?: ContactExportPolicyTemplate;
  contactPrivacyHmacSecrets?: readonly ContactPrivacyHmacSecret[];
  databaseUrl: string;
  executionRoutes?: Parameters<typeof createStaticExecutionCatalog>[0];
}>;

const closeServer = (server: ServerType): Promise<void> =>
  new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });

const closeResources = async (
  server: ServerType | undefined,
  runtime: PostgresRuntime | undefined
): Promise<void> => {
  const failures: unknown[] = [];
  if (server !== undefined) {
    try {
      await closeServer(server);
    } catch (error) {
      failures.push(error);
    }
  }
  if (runtime !== undefined) {
    try {
      await runtime.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "API resource shutdown failed.");
  }
};

export const createApiService = ({
  config,
  contactExportPolicy,
  contactPrivacyHmacSecrets,
  databaseUrl,
  executionRoutes = [],
}: ApiServiceOptions): ApiService => {
  let acceptingRequests = false;
  let boundAddress: ApiServiceAddress | null = null;
  let runtime: PostgresRuntime | undefined;
  let server: ServerType | undefined;
  let stopPromise: Promise<void> | undefined;

  const markServerFailure = (): void => {
    acceptingRequests = false;
  };

  const start = async (): Promise<void> => {
    try {
      runtime = createPostgresRuntime(databaseUrl);
      if (config.migrationMode === "apply") {
        await runtime.migrate();
      } else {
        await runtime.verifyMigrations();
      }
      await runtime.health();

      const clock = createSystemClock();
      const planningIdentifiers = createRandomPlanningIdentifiers();
      const datasetGenerationIdentifiers =
        createRandomDatasetGenerationIdentifiers();
      const runIdentifiers = createRandomIdentifiers();
      const privacySubjectKeys =
        contactPrivacyHmacSecrets === undefined
          ? {
              derive: (): Promise<never> =>
                Promise.reject(
                  new Error("Contact privacy HMAC secret is not configured.")
                ),
            }
          : createHmacContactPrivacySubjectKeyDeriver(
              contactPrivacyHmacSecrets
            );
      const contactPrivacyGuard = createContactPrivacyTombstoneGuard({
        persistence: runtime.contactPrivacy,
        subjectKeys: privacySubjectKeys,
      });
      const authorizeContactEffect = makeAuthorizeContactEffect({
        clock,
        persistence: runtime.contactPrivacy,
        subjectKeys: privacySubjectKeys,
      });
      const executionCatalog = createStaticExecutionCatalog(executionRoutes);
      const datasetGenerationSnapshots =
        createPostgresDatasetGenerationPlanningSnapshotResolver({
          clock,
          identifiers: planningIdentifiers,
          persistence: runtime.planning,
          routes: executionCatalog.routes,
        });
      const composition = composeApi({
        authentication: { apiKeys: runtime.apiKeys, clock },
        capabilityDiscovery: {
          catalog: executionCatalog.capabilities,
          clock,
          persistence: runtime.planning,
          requiredPermission: "capabilities:list",
        },
        contactPrivacyGuard,
        contactPrivacyRestriction: {
          clock,
          persistence: runtime.contactPrivacy,
          requiredPermission: "contacts:privacy",
          subjectKeys: privacySubjectKeys,
        },
        datasetGenerationAuthorization: {
          clock,
          identifiers: runIdentifiers,
          persistence: runtime.datasetGenerationFirstPage,
        },
        datasetGenerationCancellation: {
          clock,
          identifiers: runIdentifiers,
          persistence: runtime.datasetGenerationCancellation,
          requiredPermission: "datasets:generate",
        },
        datasetGenerationCreation: {
          clock,
          identifiers: datasetGenerationIdentifiers,
          persistence: runtime.datasetGeneration,
        },
        datasetGenerationPlanning: {
          clock,
          identifiers: datasetGenerationIdentifiers,
          normalizer: createDatasetGenerationQueryNormalizerRouter([
            {
              capability: organizationDiscoveryCapability,
              normalizer: createCompanyDiscoveryQueryNormalizer({
                contract: organizationDiscoveryQueryContract,
              }),
            },
            {
              capability: contactDiscoveryCapability,
              normalizer: createContactDiscoveryQueryNormalizer({
                contract: contactDiscoveryExecutionQueryContract,
              }),
            },
            {
              capability: contactIdentityRevealCapability,
              normalizer: createContactIdentityQueryNormalizer({
                contract: contactIdentityExecutionQueryContract,
              }),
            },
            {
              capability: contactWorkEmailResolveCapability,
              normalizer: createContactWorkEmailQueryNormalizer({
                contract: contactWorkEmailExecutionQueryContract,
              }),
            },
            {
              capability: contactWorkEmailVerifyCapability,
              normalizer: createContactWorkEmailQueryNormalizer({
                contract: contactWorkEmailExecutionQueryContract,
              }),
            },
          ]),
          persistence: runtime.datasetGenerationPlanning,
          snapshots: datasetGenerationSnapshots,
        },
        datasetGenerationStatus: {
          persistence: runtime.datasetGeneration,
          requiredPermission: "datasets:read",
        },
        datasetGenerationResults: {
          generations: runtime.datasetGeneration,
          privacy: {
            guard: contactPrivacyGuard,
            subjects: runtime.contactDatasetExportPrivacy,
          },
          records: runtime.datasetRecordPages,
          requiredPermission: "datasets:read",
        },
        datasetGenerationSelectionSources: {
          identity: runtime.contactIdentitySource,
          workEmail: runtime.selectedContactEnrichmentSource,
        },
        datasetExport: {
          codecs: {
            csv: createCsvDatasetCodec(),
            jsonl: createJsonlDatasetCodec(),
          },
          contactPrivacy: {
            clock,
            guard: contactPrivacyGuard,
            ...(contactExportPolicy === undefined
              ? {}
              : {
                  policy:
                    createContactExportPolicyResolver(contactExportPolicy),
                }),
            requiredPermission: "contacts:export",
            subjects: runtime.contactDatasetExportPrivacy,
          },
          datasets: runtime.datasets,
          maxExportBytes: config.maxExportBytes,
          requiredPermission: "datasets:export",
        },
        exportDelivery: {
          authorizeContactEffect,
          clock,
          persistence: runtime.exportDeliveries,
          requiredPermission: "contacts:export",
          subjectKeys: privacySubjectKeys,
        },
        datasetImport: {
          codecs: {
            csv: createCsvDatasetCodec(),
            jsonl: createJsonlDatasetCodec(),
          },
          datasets: runtime.datasets,
          requiredPermission: "datasets:import",
        },
        planning: {
          clock,
          identifiers: planningIdentifiers,
          persistence: runtime.planning,
          routes: executionCatalog.routes,
        },
        recipeApplicationExport: {
          codecs: {
            csv: createCsvDatasetCodec(),
            jsonl: createJsonlDatasetCodec(),
          },
          datasets: runtime.datasets,
          maxExportBytes: config.maxExportBytes,
          maxRecordBytes: config.maxExportRecordBytes,
          persistence: runtime.recipes,
          requiredPermission: "recipes:export",
        },
        recipeApplicationWatch: {
          requiredPermission: "recipes:read",
          watches: runtime.recipeApplicationWatches,
        },
        recipeApply: {
          applicationIdentifiers: {
            nextRecipeApplicationId: async () =>
              `application_${globalThis.crypto.randomUUID()}`,
          },
          clock,
          datasets: runtime.datasets,
          identifiers: runIdentifiers,
          inputValidator: createRecipeCellInputValidator(),
          persistence: runtime.recipeApply,
          planningIdentifiers,
          recipes: runtime.recipes,
          routes: executionCatalog.routes,
        },
        runCancellation: {
          clock,
          identifiers: runIdentifiers,
          persistence: runtime.runExecution,
          requiredPermission: "runs:cancel",
        },
        runCreation: {
          clock,
          identifiers: runIdentifiers,
          persistence: runtime.persistence,
          requiredPermission: "runs:create",
        },
        runQuery: {
          requiredPermission: "runs:read",
          runs: runtime.runQueries,
        },
      });
      const app = createHttpApp(
        {
          applyRecipe: composition.applyRecipe,
          authenticateApiKey: composition.authenticateApiKey,
          cancelDatasetGeneration: composition.cancelDatasetGeneration,
          cancelRun: composition.cancelRun,
          createRun: composition.createRun,
          deriveContactIdentities: composition.deriveContactIdentities,
          deriveContactWorkEmails: composition.deriveContactWorkEmails,
          discoverContacts: composition.discoverContacts,
          discoverOrganizations: composition.discoverOrganizations,
          exportDataset: composition.exportDataset,
          exportRecipeApplication: composition.exportRecipeApplication,
          getDatasetGeneration: composition.getDatasetGeneration,
          getExportDelivery: composition.getExportDelivery,
          getRecipeApplicationStatus: composition.getRecipeApplicationStatus,
          getRun: composition.getRun,
          importDataset: composition.importDataset,
          listCapabilities: composition.listCapabilities,
          listContactCandidates: composition.listContactCandidates,
          listCompanyCandidates: composition.listCompanyCandidates,
          quoteRunPlan: composition.quoteRunPlan,
          restrictContactPrivacy: composition.restrictContactPrivacy,
          revokeExportDelivery: composition.revokeExportDelivery,
          readiness: async () => {
            if (!(acceptingRequests && runtime !== undefined)) {
              return false;
            }
            try {
              await runtime.health();
              return true;
            } catch {
              return false;
            }
          },
        },
        {
          maxAuthorizationHeaderBytes: config.maxAuthorizationHeaderBytes,
          maxBodyBytes: config.maxBodyBytes,
          maxExportRecordBytes: config.maxExportRecordBytes,
          maxImportBytes: config.maxImportBytes,
        }
      );

      await new Promise<void>((resolve, reject) => {
        let candidate: ServerType;
        const handleStartupFailure = (error: Error): void => reject(error);
        candidate = serve(
          {
            fetch: app.fetch,
            hostname: config.host,
            overrideGlobalObjects: false,
            port: config.port,
          },
          (info: AddressInfo) => {
            candidate.off("error", handleStartupFailure);
            server = candidate;
            boundAddress = { host: info.address, port: info.port };
            acceptingRequests = true;
            candidate.on("error", markServerFailure);
            resolve();
          }
        );
        server = candidate;
        candidate.once("error", handleStartupFailure);
      });
    } catch (error) {
      acceptingRequests = false;
      try {
        await closeResources(server, runtime);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "API startup and cleanup failed."
        );
      } finally {
        boundAddress = null;
        runtime = undefined;
        server = undefined;
      }
      throw error;
    }
  };

  const stop = (_reason: string): Promise<void> => {
    if (stopPromise !== undefined) {
      return stopPromise;
    }
    acceptingRequests = false;
    const currentServer = server;
    const currentRuntime = runtime;
    currentServer?.off("error", markServerFailure);
    boundAddress = null;
    stopPromise = closeResources(currentServer, currentRuntime).finally(() => {
      if (server === currentServer) {
        server = undefined;
      }
      if (runtime === currentRuntime) {
        runtime = undefined;
      }
    });
    return stopPromise;
  };

  const forceStop = async (reason: string): Promise<void> => {
    acceptingRequests = false;
    const currentServer = server as
      | (ServerType & {
          closeAllConnections?: () => void;
          closeIdleConnections?: () => void;
        })
      | undefined;
    currentServer?.closeIdleConnections?.();
    currentServer?.closeAllConnections?.();
    await stop(reason);
  };

  return {
    address: () => boundAddress,
    forceStop,
    start,
    stop,
  };
};
