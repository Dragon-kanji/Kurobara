export const isAmount = (value: number): boolean =>
  Number.isFinite(value) && value >= 0;

const AMOUNT_ULP_TOLERANCE = 4;

export const amountsEqual = (left: number, right: number): boolean =>
  isAmount(left) &&
  isAmount(right) &&
  Math.abs(left - right) <=
    Number.EPSILON *
      AMOUNT_ULP_TOLERANCE *
      Math.max(1, Math.abs(left), Math.abs(right));
