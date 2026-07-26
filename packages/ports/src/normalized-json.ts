export type NormalizedJsonValue =
  | boolean
  | null
  | number
  | string
  | readonly NormalizedJsonValue[]
  | Readonly<{ [key: string]: NormalizedJsonValue }>;
