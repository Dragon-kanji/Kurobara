import {
  type ContactPrivacySubject,
  capabilityId,
  contentHash,
  createContactCandidate,
  createContactIdentityResolution,
  createContactProviderIdentity,
  createContactWorkEmailResolution,
  datasetGenerationId,
  datasetGenerationPlanId,
  type InternalContactCandidate,
  instant,
  type RevealedInternalContactCandidate,
  recordId,
} from "@kurobara/kernel";
import type {
  ContactDatasetExportAuthorization,
  ContactDatasetExportDataClass,
  ContactDatasetExportPrivacySourcePort,
  ContactDatasetExportRecordAuthorization,
  ContactIdentitySourcePort,
  DatasetPersistencePort,
  SelectedContactEnrichmentSourcePort,
  SelectedContactWorkEmailSource,
  WorkspaceScope,
} from "@kurobara/ports";
import type postgres from "postgres";

import { parseRecordPayload } from "./dataset-payload.ts";
import { DatabasePayloadError } from "./errors.ts";

type ContactSourceRow = Readonly<{
  provider_key: string | null;
  provider_subject_id: string | null;
  record: unknown;
  record_id: string;
}>;

type ContactExportGenerationRow = Readonly<{
  capability_id: string;
  capability_version: string;
  generation_id: string;
  generation_plan_id: string;
  plan_hash: string;
}>;

const SHORTLIST_CONTACT_SCHEMA = Object.freeze({
  department: "string",
  display_name: "string",
  identity_completeness: "string",
  job_title: "string",
  observed_at_ms: "number",
  organization_domain: "string",
  organization_id: "string",
  organization_name: "string",
  person_country_code: "string",
  profile_url: "string",
  seniority: "string",
} as const);

const IDENTITY_CONTACT_SCHEMA = Object.freeze({
  ...SHORTLIST_CONTACT_SCHEMA,
  first_name: "string",
  identity_observed_at_ms: "number",
  identity_status: "string",
  last_name: "string",
} as const);

const WORK_EMAIL_CONTACT_SCHEMA = Object.freeze({
  ...IDENTITY_CONTACT_SCHEMA,
  work_email: "string",
  work_email_confidence: "number",
  work_email_observed_at_ms: "number",
  work_email_source: "string",
  work_email_status: "string",
  work_email_verification: "string",
} as const);

type ContactFieldSchema = Readonly<Record<string, "number" | "string">>;

const fieldsMatchSchema = (
  fields: NonNullable<
    Awaited<ReturnType<DatasetPersistencePort["getDataset"]>>
  >["fields"],
  schema: ContactFieldSchema
): boolean => {
  const fieldKeys = new Set(fields.map((field) => field.key));
  return (
    fieldKeys.size === fields.length &&
    fields.length === Object.keys(schema).length &&
    fields.every((field) => schema[field.key] === field.valueType)
  );
};

const hasContactReservedField = (
  fields: NonNullable<
    Awaited<ReturnType<DatasetPersistencePort["getDataset"]>>
  >["fields"]
): boolean =>
  fields.some((field) => Object.hasOwn(WORK_EMAIL_CONTACT_SCHEMA, field.key));

const isStrictGeneratedContactDataset = (
  stored: NonNullable<Awaited<ReturnType<DatasetPersistencePort["getDataset"]>>>
): boolean => {
  if (stored.materialization.origin.kind !== "generation") {
    return false;
  }
  if (
    fieldsMatchSchema(stored.fields, SHORTLIST_CONTACT_SCHEMA) ||
    fieldsMatchSchema(stored.fields, IDENTITY_CONTACT_SCHEMA) ||
    fieldsMatchSchema(stored.fields, WORK_EMAIL_CONTACT_SCHEMA)
  ) {
    return true;
  }
  if (hasContactReservedField(stored.fields)) {
    return invalidStoredContact();
  }
  return false;
};

const nullableString = (value: unknown): value is null | string =>
  value === null || typeof value === "string";

const seniorityIsValid = (
  value: unknown
): value is InternalContactCandidate["candidate"]["seniority"] =>
  value === null ||
  value === "owner" ||
  value === "c_suite" ||
  value === "vp" ||
  value === "director" ||
  value === "manager" ||
  value === "senior" ||
  value === "individual_contributor";

const invalidStoredContact = (): never => {
  throw new DatabasePayloadError(
    "The stored contact record or its restricted provider lineage is malformed."
  );
};

const storedValues = (
  row: ContactSourceRow,
  stored: NonNullable<Awaited<ReturnType<DatasetPersistencePort["getDataset"]>>>
): ReadonlyMap<string, unknown> => {
  const record = parseRecordPayload(
    row.record,
    stored.dataset,
    stored.fields,
    row.record_id
  );
  const fieldKeys = new Map(
    stored.fields.map((field) => [field.fieldId, field.key] as const)
  );
  const values = new Map<string, unknown>();
  for (const entry of record.values) {
    const key = fieldKeys.get(entry.fieldId);
    if (key === undefined || values.has(key)) {
      return invalidStoredContact();
    }
    values.set(key, entry.value);
  }
  return values;
};

const projectContact = (
  row: ContactSourceRow,
  stored: NonNullable<Awaited<ReturnType<DatasetPersistencePort["getDataset"]>>>
): InternalContactCandidate => {
  if (row.provider_key === null || row.provider_subject_id === null) {
    return invalidStoredContact();
  }
  const values = storedValues(row, stored);
  const department = values.get("department");
  const displayName = values.get("display_name");
  const identityCompleteness = values.get("identity_completeness");
  const jobTitle = values.get("job_title");
  const observedAt = values.get("observed_at_ms");
  const organizationDomain = values.get("organization_domain");
  const organizationId = values.get("organization_id");
  const organizationName = values.get("organization_name");
  const personCountryCode = values.get("person_country_code");
  const profileUrl = values.get("profile_url");
  const seniority = values.get("seniority");
  if (
    !nullableString(department) ||
    typeof displayName !== "string" ||
    (identityCompleteness !== "full" &&
      identityCompleteness !== "obfuscated") ||
    typeof jobTitle !== "string" ||
    typeof observedAt !== "number" ||
    !Number.isSafeInteger(observedAt) ||
    observedAt < 0 ||
    typeof organizationDomain !== "string" ||
    typeof organizationId !== "string" ||
    typeof organizationName !== "string" ||
    !nullableString(personCountryCode) ||
    !nullableString(profileUrl) ||
    !seniorityIsValid(seniority)
  ) {
    return invalidStoredContact();
  }
  const candidate = createContactCandidate({
    contactId: row.record_id as Parameters<
      typeof createContactCandidate
    >[0]["contactId"],
    department,
    displayName,
    identityCompleteness,
    jobTitle,
    observedAt: instant(observedAt),
    organizationDomain,
    organizationId,
    organizationName,
    personCountryCode,
    profileUrl,
    seniority,
  });
  const providerIdentity = createContactProviderIdentity({
    providerKey: row.provider_key,
    providerSubjectId: row.provider_subject_id,
  });
  if (!(candidate.ok && providerIdentity.ok)) {
    return invalidStoredContact();
  }
  return {
    candidate: candidate.value,
    providerIdentity: providerIdentity.value,
  };
};

const projectRevealedContact = (
  row: ContactSourceRow,
  stored: NonNullable<Awaited<ReturnType<DatasetPersistencePort["getDataset"]>>>
): RevealedInternalContactCandidate => {
  const contact = projectContact(row, stored);
  const values = storedValues(row, stored);
  const firstName = values.get("first_name");
  const identityObservedAt = values.get("identity_observed_at_ms");
  const identityStatus = values.get("identity_status");
  const lastName = values.get("last_name");
  if (
    contact.candidate.identityCompleteness !== "full" ||
    identityStatus !== "found" ||
    typeof firstName !== "string" ||
    typeof lastName !== "string" ||
    typeof identityObservedAt !== "number" ||
    !Number.isSafeInteger(identityObservedAt) ||
    identityObservedAt < 0
  ) {
    return invalidStoredContact();
  }
  const identity = createContactIdentityResolution({
    displayName: contact.candidate.displayName,
    firstName,
    identityCompleteness: "full",
    lastName,
    observedAt: instant(identityObservedAt),
    profileUrl: contact.candidate.profileUrl,
  });
  if (!identity.ok) {
    return invalidStoredContact();
  }
  return {
    candidate: { ...contact.candidate, identityCompleteness: "full" },
    identity: identity.value,
    providerIdentity: contact.providerIdentity,
  };
};

const projectWorkEmail = (
  row: ContactSourceRow,
  stored: NonNullable<Awaited<ReturnType<DatasetPersistencePort["getDataset"]>>>
): SelectedContactWorkEmailSource => {
  const contact = projectRevealedContact(row, stored);
  const values = storedValues(row, stored);
  const confidence = values.get("work_email_confidence");
  const email = values.get("work_email");
  const observedAt = values.get("work_email_observed_at_ms");
  const source = values.get("work_email_source");
  const status = values.get("work_email_status");
  const verification = values.get("work_email_verification");
  if (
    status !== "found" ||
    typeof email !== "string" ||
    !(
      confidence === null ||
      (typeof confidence === "number" &&
        Number.isFinite(confidence) &&
        confidence >= 0 &&
        confidence <= 1)
    ) ||
    typeof observedAt !== "number" ||
    !Number.isSafeInteger(observedAt) ||
    observedAt < 0 ||
    (source !== "inferred" &&
      source !== "public" &&
      source !== "provider_unspecified") ||
    (verification !== "accept_all" &&
      verification !== "invalid" &&
      verification !== "unknown" &&
      verification !== "valid")
  ) {
    return invalidStoredContact();
  }
  const workEmail = createContactWorkEmailResolution({
    confidence,
    email,
    observedAt: instant(observedAt),
    source,
    verification,
  });
  if (!workEmail.ok) {
    return invalidStoredContact();
  }
  return { contact, workEmail: workEmail.value };
};

type LoadedContactSource = Readonly<{
  row: ContactSourceRow;
  stored: NonNullable<
    Awaited<ReturnType<DatasetPersistencePort["getDataset"]>>
  >;
}>;

const loadContactSource = async (
  sql: postgres.Sql,
  datasets: DatasetPersistencePort,
  scope: WorkspaceScope,
  contactDatasetId: Parameters<ContactIdentitySourcePort["load"]>[1],
  contactRecordId: Parameters<ContactIdentitySourcePort["load"]>[2]
): Promise<LoadedContactSource | undefined> => {
  const stored = await datasets.getDataset(scope, contactDatasetId);
  if (stored?.materialization.state !== "ready") {
    return;
  }
  const rows = await sql<readonly ContactSourceRow[]>`
    SELECT
      record.record_id,
      record.record,
      lineage.provider_key,
      lineage.provider_subject_id
    FROM kurobara_core.dataset_records AS record
    JOIN kurobara_core.dataset_materializations AS materialization
      ON materialization.workspace_id = record.workspace_id
      AND materialization.dataset_id = record.dataset_id
      AND materialization.materialization_id = record.materialization_id
    JOIN kurobara_core.dataset_generation_record_lineage AS lineage
      ON lineage.workspace_id = record.workspace_id
      AND lineage.dataset_id = record.dataset_id
      AND lineage.record_id = record.record_id
    WHERE record.workspace_id = ${scope.workspaceId}
      AND record.dataset_id = ${contactDatasetId}
      AND record.record_id = ${contactRecordId}
      AND materialization.state = 'ready'
    LIMIT 1
  `;
  const row = rows[0];
  return row === undefined ? undefined : { row, stored };
};

export const createPostgresContactIdentitySource = (
  sql: postgres.Sql,
  datasets: DatasetPersistencePort
): ContactIdentitySourcePort => ({
  load: async (scope, contactDatasetId, contactRecordId) => {
    const loaded = await loadContactSource(
      sql,
      datasets,
      scope,
      contactDatasetId,
      contactRecordId
    );
    return loaded === undefined
      ? undefined
      : projectContact(loaded.row, loaded.stored);
  },
});

export const createPostgresSelectedContactEnrichmentSource = (
  sql: postgres.Sql,
  datasets: DatasetPersistencePort
): SelectedContactEnrichmentSourcePort => ({
  loadIdentity: async (scope, contactDatasetId, contactRecordId) => {
    const loaded = await loadContactSource(
      sql,
      datasets,
      scope,
      contactDatasetId,
      contactRecordId
    );
    return loaded === undefined
      ? undefined
      : projectRevealedContact(loaded.row, loaded.stored);
  },
  loadWorkEmail: async (scope, contactDatasetId, contactRecordId) => {
    const loaded = await loadContactSource(
      sql,
      datasets,
      scope,
      contactDatasetId,
      contactRecordId
    );
    return loaded === undefined
      ? undefined
      : projectWorkEmail(loaded.row, loaded.stored);
  },
});

const observedInstant = (values: ReadonlyMap<string, unknown>, key: string) => {
  const value = values.get(key);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return invalidStoredContact();
  }
  return instant(value);
};

const contactExportObservations = (
  values: ReadonlyMap<string, unknown>
): ContactDatasetExportRecordAuthorization["observations"] => {
  const employment = observedInstant(values, "observed_at_ms");
  const identityObservedAt = values.has("identity_observed_at_ms")
    ? observedInstant(values, "identity_observed_at_ms")
    : employment;
  const observations: Partial<
    Record<ContactDatasetExportDataClass, ReturnType<typeof instant>>
  > = {
    "contact-identity": identityObservedAt,
    employment,
    "professional-social-profile": identityObservedAt,
  };
  const profileUrl = values.get("profile_url");
  if (
    profileUrl !== null &&
    profileUrl !== undefined &&
    typeof profileUrl !== "string"
  ) {
    return invalidStoredContact();
  }
  const email = values.get("work_email");
  if (email !== undefined && email !== null) {
    if (typeof email !== "string") {
      return invalidStoredContact();
    }
    observations["professional-email"] = observedInstant(
      values,
      "work_email_observed_at_ms"
    );
  }
  return observations;
};

const contactExportRecords = (
  rows: readonly ContactSourceRow[],
  stored: NonNullable<Awaited<ReturnType<DatasetPersistencePort["getDataset"]>>>
): readonly ContactDatasetExportRecordAuthorization[] | undefined => {
  if (rows.length !== stored.materialization.recordCount) {
    return invalidStoredContact();
  }
  if (rows.length === 0) {
    return [];
  }
  const protectedRows = rows.filter(
    (row) => row.provider_key !== null || row.provider_subject_id !== null
  );
  if (protectedRows.length === 0) {
    return invalidStoredContact();
  }
  if (protectedRows.length !== rows.length) {
    return invalidStoredContact();
  }
  const records: ContactDatasetExportRecordAuthorization[] = [];
  for (const row of protectedRows) {
    if (row.provider_key === null || row.provider_subject_id === null) {
      return invalidStoredContact();
    }
    const values = storedValues(row, stored);
    const subjects: ContactPrivacySubject[] = [
      {
        kind: "provider-subject",
        providerKey: row.provider_key,
        value: row.provider_subject_id,
      },
    ];
    const email = values.get("work_email");
    if (email !== undefined && email !== null) {
      if (typeof email !== "string") {
        return invalidStoredContact();
      }
      subjects.push({ kind: "email", value: email });
    }
    records.push({
      observations: contactExportObservations(values),
      recordId: recordId(row.record_id),
      subjects,
    });
  }
  return records;
};

export const createPostgresContactDatasetExportPrivacySource = (
  sql: postgres.Sql,
  datasets: DatasetPersistencePort
): ContactDatasetExportPrivacySourcePort => ({
  loadAuthorization: async (scope, contactDatasetId) => {
    const stored = await datasets.getDataset(scope, contactDatasetId);
    if (stored?.materialization.state !== "ready") {
      return;
    }
    if (!isStrictGeneratedContactDataset(stored)) {
      return;
    }
    const generations = await sql<readonly ContactExportGenerationRow[]>`
      SELECT
        generation.generation_id,
        generation.generation_plan_id,
        generation.plan_hash,
        generation.capability_id,
        generation.capability_version
      FROM kurobara_core.dataset_generations AS generation
      WHERE generation.workspace_id = ${scope.workspaceId}
        AND generation.dataset_id = ${contactDatasetId}
        AND generation.state = 'completed'
      LIMIT 1
    `;
    const generation = generations[0];
    if (generation === undefined) {
      return invalidStoredContact();
    }
    const rows = await sql<readonly ContactSourceRow[]>`
      SELECT
        record.record_id,
        record.record,
        lineage.provider_key,
        lineage.provider_subject_id
      FROM kurobara_core.dataset_records AS record
      JOIN kurobara_core.dataset_materializations AS materialization
        ON materialization.workspace_id = record.workspace_id
        AND materialization.dataset_id = record.dataset_id
        AND materialization.materialization_id = record.materialization_id
      LEFT JOIN kurobara_core.dataset_generation_record_lineage AS lineage
        ON lineage.workspace_id = record.workspace_id
        AND lineage.dataset_id = record.dataset_id
        AND lineage.record_id = record.record_id
      WHERE record.workspace_id = ${scope.workspaceId}
        AND record.dataset_id = ${contactDatasetId}
        AND materialization.state = 'ready'
      ORDER BY record.record_id
    `;
    const records = contactExportRecords(rows, stored);
    if (records === undefined) {
      return invalidStoredContact();
    }
    const providerKeys = [
      ...new Set(
        rows.map((row) => {
          if (row.provider_key === null) {
            return invalidStoredContact();
          }
          return row.provider_key;
        })
      ),
    ].sort();
    const authorization: ContactDatasetExportAuthorization = {
      providerKeys,
      records,
      source: {
        capability: {
          capabilityId: capabilityId(generation.capability_id),
          capabilityVersion: generation.capability_version,
        },
        generationId: datasetGenerationId(generation.generation_id),
        generationPlanId: datasetGenerationPlanId(
          generation.generation_plan_id
        ),
        kind: "generated-dataset",
        planHash: contentHash(generation.plan_hash),
      },
    };
    return authorization;
  },
});
