export type DomainResult<Value, Failure> =
  | Readonly<{ ok: true; value: Value }>
  | Readonly<{ ok: false; error: Failure }>;

export const succeed = <Value>(value: Value): DomainResult<Value, never> => ({
  ok: true,
  value,
});

export const fail = <Failure>(
  error: Failure
): DomainResult<never, Failure> => ({
  error,
  ok: false,
});
