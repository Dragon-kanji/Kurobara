import { createHash } from "node:crypto";

import {
  type ContentHash,
  contentHash,
  type Dataset,
  type DatasetId,
  type Record as DomainRecord,
  type DomainResult,
  type Field,
  type FieldId,
  fail,
  idempotencyKey,
  instant,
  succeed,
} from "@kurobara/kernel";
import type {
  ContactDataClass,
  RequestedContactData,
} from "@kurobara/policy-engine";
import type {
  ClockPort,
  ContactDatasetExportPrivacySourcePort,
  ContactPrivacyGuardPort,
  DatasetCodecPort,
  DatasetEncodeEvent,
  DatasetEncodeInput,
  DatasetFieldCodecSpec,
  DatasetImportFormat,
  DatasetPersistencePort,
  ExportDelivery,
  StoredDataset,
  VerifiedApiKey,
} from "@kurobara/ports";
import { canonicalContentHash } from "./canonical-content-hash.ts";
import type {
  ContactExportPolicyResolver,
  ResolvedContactExportPolicy,
} from "./contact-export-policy.ts";
import type {
  GeneratedDatasetDeliveryExport,
  PrepareExportDeliveryFailureCode,
  PrepareExportDeliveryRequest,
  PrepareExportDeliveryResult,
} from "./export-delivery.ts";

export type ExportDatasetRequest = Readonly<{
  actor: VerifiedApiKey;
  datasetId: DatasetId;
  fieldIds?: readonly FieldId[];
  format: DatasetImportFormat;
  maxRecordBytes: number;
}>;

export type ExportDatasetFailureCode =
  | "authority-permission-missing"
  | "codec-configuration-invalid"
  | "contact-privacy-check-failed"
  | "contact-privacy-restricted"
  | "contact-export-policy-unavailable"
  | "dataset-not-ready"
  | "dataset-not-found"
  | "export-too-large"
  | "export-delivery-conflict"
  | "export-delivery-revoked"
  | "field-selection-invalid"
  | "sparse-csv-unsupported";

export type ExportDatasetFailure = Readonly<{
  code: ExportDatasetFailureCode;
  message: string;
}>;

export type DatasetExport = Readonly<{
  contentHash: ContentHash;
  contentLength: number;
  dataset: Dataset;
  delivery?: ExportDelivery;
  events: AsyncIterable<DatasetEncodeEvent>;
  fields: readonly Field[];
  format: DatasetImportFormat;
}>;

export type ExportDatasetDependencies = Readonly<{
  codecs: Readonly<Record<DatasetImportFormat, DatasetCodecPort>>;
  contactPrivacy: Readonly<{
    clock: ClockPort;
    guard: ContactPrivacyGuardPort;
    policy?: ContactExportPolicyResolver;
    prepareDelivery?: (
      request: PrepareExportDeliveryRequest
    ) => Promise<PrepareExportDeliveryResult>;
    requiredPermission: string;
    subjects: ContactDatasetExportPrivacySourcePort;
  }>;
  datasets: DatasetPersistencePort;
  maxExportBytes?: number;
  requiredPermission: string;
}>;

type ContactExportAuthorization = Awaited<
  ReturnType<ContactDatasetExportPrivacySourcePort["loadAuthorization"]>
>;

class ContactDatasetExportPrivacyError extends Error {
  constructor() {
    super("Contact privacy restrictions interrupted the dataset export.");
    this.name = "ContactDatasetExportPrivacyError";
  }
}

const selectFields = (
  fields: readonly Field[],
  requested: readonly FieldId[] | undefined
): readonly Field[] | undefined => {
  if (requested === undefined) {
    return fields;
  }
  if (new Set(requested).size !== requested.length) {
    return;
  }
  const byId = new Map(fields.map((field) => [field.fieldId, field]));
  const selected = requested.map((fieldId) => byId.get(fieldId));
  return selected.some((field) => field === undefined)
    ? undefined
    : (selected as readonly Field[]);
};

const filteredRecords = (
  records: AsyncIterable<DomainRecord>,
  fields: readonly Field[]
): AsyncIterable<DomainRecord> => {
  const selected = new Set(fields.map((field) => field.fieldId));
  return {
    async *[Symbol.asyncIterator]() {
      for await (const record of records) {
        yield {
          ...record,
          values: record.values.filter((entry) => selected.has(entry.fieldId)),
        };
      }
    },
  };
};

const codecFields = (
  fields: readonly Field[]
): readonly DatasetFieldCodecSpec[] =>
  fields.map((field) => ({
    fieldId: field.fieldId,
    key: field.key,
    valueType: field.valueType,
  }));

const privacyGuardedEvents = (
  events: AsyncIterable<DatasetEncodeEvent>,
  revalidate: () => Promise<boolean>
): AsyncIterable<DatasetEncodeEvent> => ({
  async *[Symbol.asyncIterator]() {
    const iterator = events[Symbol.asyncIterator]();
    try {
      while (true) {
        if (!(await revalidate())) {
          throw new ContactDatasetExportPrivacyError();
        }
        const next = await iterator.next();
        if (next.done) {
          return;
        }
        if (!(await revalidate())) {
          throw new ContactDatasetExportPrivacyError();
        }
        yield next.value;
      }
    } finally {
      await iterator.return?.();
    }
  },
});

const authorizeContactExport = async (
  dependencies: ExportDatasetDependencies["contactPrivacy"],
  request: ExportDatasetRequest,
  expectedRecordCount: number
): Promise<DomainResult<ContactExportAuthorization, ExportDatasetFailure>> => {
  const scope = { workspaceId: request.actor.workspaceId } as const;
  let authorization: ContactExportAuthorization;
  try {
    authorization = await dependencies.subjects.loadAuthorization(
      scope,
      request.datasetId
    );
  } catch {
    return fail({
      code: "contact-privacy-check-failed",
      message: "Contact export privacy lineage could not be verified.",
    });
  }
  if (authorization === undefined) {
    return succeed(undefined);
  }
  if (!request.actor.permissions.includes(dependencies.requiredPermission)) {
    return fail({
      code: "authority-permission-missing",
      message:
        "The authenticated actor lacks permission to export Contact data.",
    });
  }
  if (
    authorization.records.length !== expectedRecordCount ||
    new Set(authorization.records.map((record) => record.recordId)).size !==
      authorization.records.length ||
    authorization.records.some((record) => record.subjects.length === 0) ||
    (authorization.records.length > 0 &&
      authorization.providerKeys.length === 0) ||
    new Set(authorization.providerKeys).size !==
      authorization.providerKeys.length
  ) {
    return fail({
      code: "contact-privacy-check-failed",
      message:
        "Contact export privacy lineage does not cover every materialized record.",
    });
  }
  const subjects = authorization.records.flatMap((record) => record.subjects);
  if (subjects.length === 0) {
    return succeed(authorization);
  }
  let privacyAllowed = false;
  try {
    privacyAllowed = await dependencies.guard.allows(scope, subjects);
  } catch {
    privacyAllowed = false;
  }
  return privacyAllowed
    ? succeed(authorization)
    : fail({
        code: "contact-privacy-restricted",
        message: "Contact privacy restrictions block this dataset export.",
      });
};

const CONTACT_FIELD_DATA_CLASSES = Object.freeze({
  department: "employment",
  display_name: "contact-identity",
  first_name: "contact-identity",
  identity_completeness: "contact-identity",
  identity_observed_at_ms: "contact-identity",
  identity_status: "contact-identity",
  job_title: "employment",
  last_name: "contact-identity",
  observed_at_ms: "employment",
  organization_domain: "employment",
  organization_id: "employment",
  organization_name: "employment",
  person_country_code: "employment",
  profile_url: "professional-social-profile",
  seniority: "employment",
  work_email: "professional-email",
  work_email_confidence: "professional-email",
  work_email_observed_at_ms: "professional-email",
  work_email_source: "professional-email",
  work_email_status: "professional-email",
  work_email_verification: "professional-email",
} satisfies Readonly<Record<string, ContactDataClass>>);

const CONTACT_EXPORT_DATA_CLASSES = [
  "contact-identity",
  "employment",
  "professional-social-profile",
  "professional-email",
] as const satisfies readonly ContactDataClass[];

const requestedContactData = (
  authorization: NonNullable<ContactExportAuthorization>,
  fields: readonly Field[]
): readonly RequestedContactData[] | undefined => {
  const selectedClasses = new Set<ContactDataClass>();
  for (const field of fields) {
    const dataClass =
      CONTACT_FIELD_DATA_CLASSES[
        field.key as keyof typeof CONTACT_FIELD_DATA_CLASSES
      ];
    if (dataClass === undefined) {
      return;
    }
    selectedClasses.add(dataClass);
  }
  return CONTACT_EXPORT_DATA_CLASSES.flatMap((dataClass) => {
    if (!selectedClasses.has(dataClass)) {
      return [];
    }
    const observations = authorization.records.map(
      (record) => record.observations[dataClass]
    );
    if (
      observations.length === 0 ||
      observations.some((observation) => observation === undefined)
    ) {
      return [];
    }
    return [
      {
        dataClass,
        observedAt: instant(Math.min(...(observations as readonly number[]))),
      },
    ];
  });
};

const deliveryIdempotencyKey = (
  request: ExportDatasetRequest,
  exported: GeneratedDatasetDeliveryExport,
  authorization: ResolvedContactExportPolicy
) =>
  idempotencyKey(
    `dataset-export:${canonicalContentHash({
      actorId: request.actor.actorId,
      contentHash: exported.contentHash,
      datasetId: exported.dataset.datasetId,
      fieldIds: exported.fields.map((field) => field.fieldId),
      format: exported.format,
      kind: "generated-contact-dataset-delivery",
      privacy: authorization.privacy,
      providerRights: authorization.providerRights,
      source: exported.source,
      workspaceId: request.actor.workspaceId,
    }).slice("sha256:".length)}`
  );

const exportDeliveryFailureCode = (
  code: PrepareExportDeliveryFailureCode
): ExportDatasetFailureCode => {
  switch (code) {
    case "delivery-idempotency-conflict":
      return "export-delivery-conflict";
    case "delivery-revoked":
      return "export-delivery-revoked";
    case "privacy-authorization-denied":
      return "contact-privacy-restricted";
    default:
      return "contact-export-policy-unavailable";
  }
};

const prepareContactDelivery = async (
  dependencies: ExportDatasetDependencies["contactPrivacy"],
  request: ExportDatasetRequest,
  authorization: NonNullable<ContactExportAuthorization>,
  exported: Omit<GeneratedDatasetDeliveryExport, "source">
): Promise<
  DomainResult<
    Readonly<{ delivery: ExportDelivery; events: DatasetExport["events"] }>,
    ExportDatasetFailure
  >
> => {
  if (
    dependencies.policy === undefined ||
    dependencies.prepareDelivery === undefined
  ) {
    return fail({
      code: "contact-export-policy-unavailable",
      message:
        "Contact dataset delivery is not configured with a current server-side policy.",
    });
  }
  const requestedData = requestedContactData(authorization, exported.fields);
  if (
    requestedData === undefined ||
    requestedData.length === 0 ||
    requestedData.length !==
      new Set(
        exported.fields.map(
          (field) =>
            CONTACT_FIELD_DATA_CLASSES[
              field.key as keyof typeof CONTACT_FIELD_DATA_CLASSES
            ]
        )
      ).size
  ) {
    return fail({
      code: "contact-export-policy-unavailable",
      message:
        "The Contact dataset has no exact observation proof for every exported data class.",
    });
  }
  const now = await dependencies.clock.now();
  const resolved = dependencies.policy({
    now,
    providerKeys: authorization.providerKeys,
    requestedData,
  });
  if (!resolved.ok) {
    return fail(resolved.error);
  }
  const deliveryExport: GeneratedDatasetDeliveryExport = {
    ...exported,
    source: {
      capabilityId: authorization.source.capability.capabilityId,
      capabilityVersion: authorization.source.capability.capabilityVersion,
      generationId: authorization.source.generationId,
      generationPlanId: authorization.source.generationPlanId,
      kind: "generated-dataset",
      planHash: authorization.source.planHash,
    },
  };
  const prepared = await dependencies.prepareDelivery({
    actor: request.actor,
    exported: deliveryExport,
    idempotencyKey: deliveryIdempotencyKey(
      request,
      deliveryExport,
      resolved.value
    ),
    privacy: {
      ...resolved.value.privacy,
      subjectGroups: authorization.records.map((record) => record.subjects),
      subjects: authorization.records.flatMap((record) => record.subjects),
    },
    providerRights: resolved.value.providerRights,
  });
  if (!prepared.ok) {
    return fail({
      code: exportDeliveryFailureCode(prepared.error.code),
      message: "The Contact export delivery could not be prepared safely.",
    });
  }
  return succeed({
    delivery: prepared.value.delivery,
    events: prepared.value.events,
  });
};

type EncodedContentProof = Readonly<{
  contentHash: ContentHash;
  contentLength: number;
}>;

type EncodedChunk = Extract<DatasetEncodeEvent, Readonly<{ type: "chunk" }>>;

class DatasetExportInvariantError extends Error {
  readonly code = "dataset-export-drift";

  constructor() {
    super("The dataset export did not match its bounded preflight proof.");
    this.name = "DatasetExportInvariantError";
  }
}

const encodeInput = (
  dataset: Dataset,
  fields: readonly Field[],
  maxRecordBytes: number,
  records: AsyncIterable<DomainRecord>
): DatasetEncodeInput => ({
  datasetId: dataset.datasetId,
  fields: codecFields(fields),
  maxRecordBytes,
  records,
  workspaceId: dataset.workspaceId,
});

const preflightEncodedContent = async (
  events: AsyncIterable<DatasetEncodeEvent>,
  maxExportBytes: number
): Promise<DomainResult<EncodedContentProof, ExportDatasetFailure>> => {
  const digest = createHash("sha256");
  let contentLength = 0;
  try {
    for await (const event of events) {
      if (event.type === "error") {
        return fail({
          code:
            event.error.code === "record-too-large"
              ? "export-too-large"
              : "codec-configuration-invalid",
          message:
            event.error.code === "record-too-large"
              ? "The encoded dataset export exceeds its configured byte limit."
              : "The selected dataset codec produced an invalid export stream.",
        });
      }
      if (
        !(event.bytes instanceof Uint8Array) ||
        event.bytes.byteLength > maxExportBytes - contentLength
      ) {
        return fail({
          code: "export-too-large",
          message:
            "The encoded dataset export exceeds its configured byte limit.",
        });
      }
      contentLength += event.bytes.byteLength;
      digest.update(event.bytes);
    }
  } catch (error) {
    return fail({
      code:
        error instanceof ContactDatasetExportPrivacyError
          ? "contact-privacy-restricted"
          : "codec-configuration-invalid",
      message:
        error instanceof ContactDatasetExportPrivacyError
          ? "Contact privacy restrictions interrupted the dataset export."
          : "The selected dataset codec could not validate the export stream.",
    });
  }
  return succeed({
    contentHash: contentHash(`sha256:${digest.digest("hex")}`),
    contentLength,
  });
};

const immutableEncodedChunk = (
  event: DatasetEncodeEvent,
  remainingBytes: number
): EncodedChunk => {
  if (
    event.type !== "chunk" ||
    !(event.bytes instanceof Uint8Array) ||
    event.bytes.byteLength > remainingBytes
  ) {
    throw new DatasetExportInvariantError();
  }
  return { ...event, bytes: event.bytes.slice() };
};

const assertEncodedContentProof = (
  contentLength: number,
  digest: ReturnType<typeof createHash>,
  expected: EncodedContentProof
): void => {
  const observedHash = contentHash(`sha256:${digest.digest("hex")}`);
  if (
    contentLength !== expected.contentLength ||
    observedHash !== expected.contentHash
  ) {
    throw new DatasetExportInvariantError();
  }
};

const isSafeExportInterruption = (
  error: unknown
): error is ContactDatasetExportPrivacyError | DatasetExportInvariantError =>
  error instanceof DatasetExportInvariantError ||
  error instanceof ContactDatasetExportPrivacyError;

const verifiedEncodedEvents = (
  makeEvents: () => AsyncIterable<DatasetEncodeEvent>,
  maxExportBytes: number,
  expected: EncodedContentProof
): AsyncIterable<DatasetEncodeEvent> => ({
  async *[Symbol.asyncIterator]() {
    const digest = createHash("sha256");
    let contentLength = 0;
    let pending: EncodedChunk | undefined;
    try {
      for await (const event of makeEvents()) {
        const immutable = immutableEncodedChunk(
          event,
          maxExportBytes - contentLength
        );
        const { bytes } = immutable;
        contentLength += bytes.byteLength;
        digest.update(bytes);
        if (pending !== undefined) {
          yield pending;
        }
        if (bytes.byteLength > 0) {
          pending = immutable;
        }
      }
      assertEncodedContentProof(contentLength, digest, expected);
      if (pending !== undefined) {
        yield pending;
      }
    } catch (error) {
      if (isSafeExportInterruption(error)) {
        throw error;
      }
      throw new DatasetExportInvariantError();
    }
  },
});

const loadReadyDataset = async (
  datasets: DatasetPersistencePort,
  request: ExportDatasetRequest
): Promise<DomainResult<StoredDataset, ExportDatasetFailure>> => {
  const scope = { workspaceId: request.actor.workspaceId } as const;
  const stored = await datasets.getDataset(scope, request.datasetId);
  if (
    stored === undefined ||
    stored.dataset.workspaceId !== scope.workspaceId ||
    stored.dataset.datasetId !== request.datasetId ||
    stored.materialization.workspaceId !== scope.workspaceId ||
    stored.materialization.datasetId !== request.datasetId
  ) {
    return fail({
      code: "dataset-not-found",
      message: "The dataset does not exist in this workspace.",
    });
  }
  if (stored.materialization.state !== "ready") {
    return fail({
      code: "dataset-not-ready",
      message: "The dataset materialization is not ready for export.",
    });
  }
  return succeed(stored);
};

const resolveExportFields = async (
  datasets: DatasetPersistencePort,
  request: ExportDatasetRequest,
  stored: StoredDataset
): Promise<DomainResult<readonly Field[], ExportDatasetFailure>> => {
  const fields = selectFields(stored.fields, request.fieldIds);
  if (fields === undefined) {
    return fail({
      code: "field-selection-invalid",
      message:
        "Requested export fields must be unique and belong to the dataset.",
    });
  }
  if (
    request.format === "csv" &&
    !(await datasets.isFieldSetComplete(
      { workspaceId: request.actor.workspaceId },
      request.datasetId,
      fields.map((field) => field.fieldId)
    ))
  ) {
    return fail({
      code: "sparse-csv-unsupported",
      message:
        "CSV export requires every selected field to be present in every record.",
    });
  }
  return succeed(fields);
};

const contactDeliveryIsUnconfigured = (
  contactPrivacy: ExportDatasetDependencies["contactPrivacy"],
  authorization: ContactExportAuthorization
): boolean =>
  authorization !== undefined &&
  authorization.records.length > 0 &&
  (contactPrivacy.policy === undefined ||
    contactPrivacy.prepareDelivery === undefined);

const datasetEncodeEventsFactory = (
  dependencies: ExportDatasetDependencies,
  codec: DatasetCodecPort,
  request: ExportDatasetRequest,
  stored: StoredDataset,
  fields: readonly Field[],
  contactSubjects: Parameters<ContactPrivacyGuardPort["allows"]>[1]
): (() => AsyncIterable<DatasetEncodeEvent>) => {
  const scope = { workspaceId: request.actor.workspaceId } as const;
  return () => {
    const encodedEvents = codec.encode(
      encodeInput(
        stored.dataset,
        fields,
        request.maxRecordBytes,
        filteredRecords(
          dependencies.datasets.streamRecords(scope, request.datasetId),
          fields
        )
      )
    );
    return contactSubjects.length === 0
      ? encodedEvents
      : privacyGuardedEvents(encodedEvents, async () => {
          try {
            return await dependencies.contactPrivacy.guard.allows(
              scope,
              contactSubjects
            );
          } catch {
            return false;
          }
        });
  };
};

const finishDatasetExport = async (
  dependencies: ExportDatasetDependencies,
  request: ExportDatasetRequest,
  stored: StoredDataset,
  fields: readonly Field[],
  contactAuthorization: ContactExportAuthorization,
  proof: EncodedContentProof,
  events: AsyncIterable<DatasetEncodeEvent>
): Promise<DomainResult<DatasetExport, ExportDatasetFailure>> => {
  const common = {
    contentHash: proof.contentHash,
    contentLength: proof.contentLength,
    dataset: stored.dataset,
    events,
    fields,
    format: request.format,
  } as const;
  if (
    contactAuthorization === undefined ||
    contactAuthorization.records.length === 0
  ) {
    return succeed(common);
  }
  const prepared = await prepareContactDelivery(
    dependencies.contactPrivacy,
    request,
    contactAuthorization,
    {
      ...common,
      recordCount: stored.materialization.recordCount,
    }
  );
  if (!prepared.ok) {
    return prepared;
  }
  return succeed({
    ...common,
    delivery: prepared.value.delivery,
    events: prepared.value.events,
  });
};

export const makeExportDataset = (dependencies: ExportDatasetDependencies) => {
  const maxExportBytes = dependencies.maxExportBytes ?? 1024 * 1024 * 1024;
  const limitsAreValid =
    Number.isSafeInteger(maxExportBytes) && maxExportBytes > 0;

  return async function exportDataset(
    request: ExportDatasetRequest
  ): Promise<DomainResult<DatasetExport, ExportDatasetFailure>> {
    if (!limitsAreValid) {
      return fail({
        code: "codec-configuration-invalid",
        message: "Dataset export byte limits are not configured correctly.",
      });
    }
    if (!request.actor.permissions.includes(dependencies.requiredPermission)) {
      return fail({
        code: "authority-permission-missing",
        message: "The authenticated actor lacks permission to export datasets.",
      });
    }
    const codec = dependencies.codecs[request.format];
    if (codec === undefined || codec.format !== request.format) {
      return fail({
        code: "codec-configuration-invalid",
        message:
          "The selected dataset codec is not configured for this format.",
      });
    }
    const loaded = await loadReadyDataset(dependencies.datasets, request);
    if (!loaded.ok) {
      return loaded;
    }
    const stored = loaded.value;
    const contactExport = await authorizeContactExport(
      dependencies.contactPrivacy,
      request,
      stored.materialization.recordCount
    );
    if (!contactExport.ok) {
      return contactExport;
    }
    const contactAuthorization = contactExport.value;
    const selectedFields = await resolveExportFields(
      dependencies.datasets,
      request,
      stored
    );
    if (!selectedFields.ok) {
      return selectedFields;
    }
    const fields = selectedFields.value;
    if (
      contactDeliveryIsUnconfigured(
        dependencies.contactPrivacy,
        contactAuthorization
      )
    ) {
      return fail({
        code: "contact-export-policy-unavailable",
        message:
          "Contact dataset delivery is not configured with a current server-side policy.",
      });
    }

    const contactSubjects =
      contactAuthorization?.records.flatMap((record) => record.subjects) ?? [];
    const makeEvents = datasetEncodeEventsFactory(
      dependencies,
      codec,
      request,
      stored,
      fields,
      contactSubjects
    );
    const encodedPreflight = await preflightEncodedContent(
      makeEvents(),
      maxExportBytes
    );
    if (!encodedPreflight.ok) {
      return encodedPreflight;
    }
    const events = verifiedEncodedEvents(
      makeEvents,
      maxExportBytes,
      encodedPreflight.value
    );
    return finishDatasetExport(
      dependencies,
      request,
      stored,
      fields,
      contactAuthorization,
      encodedPreflight.value,
      events
    );
  };
};
