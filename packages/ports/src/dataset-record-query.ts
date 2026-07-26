import type {
  Dataset,
  DatasetId,
  DatasetMaterialization,
  DatasetMaterializationId,
  Record as DatasetRecord,
  Field,
} from "@kurobara/kernel";

import type { WorkspaceScope } from "./run-persistence.ts";

export type DatasetRecordPageEntry = Readonly<{
  ordinal: number;
  record: DatasetRecord;
}>;

export type DatasetRecordPage = Readonly<{
  dataset: Dataset;
  fields: readonly Field[];
  hasMore: boolean;
  items: readonly DatasetRecordPageEntry[];
  materialization: DatasetMaterialization;
}>;

export type DatasetRecordPageQuery = Readonly<{
  afterOrdinal: number;
  datasetId: DatasetId;
  limit: number;
  materializationId: DatasetMaterializationId;
}>;

/** Read-only keyset projection for one immutable ready materialization. */
export interface DatasetRecordPageQueryPort {
  listPage(
    scope: WorkspaceScope,
    query: DatasetRecordPageQuery
  ): Promise<DatasetRecordPage | undefined>;
}
