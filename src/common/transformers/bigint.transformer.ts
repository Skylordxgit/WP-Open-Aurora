import { ValueTransformer } from 'typeorm';

/** Keep bigint timestamps numeric when PostgreSQL returns them as strings. */
export const BigIntNumberTransformer: ValueTransformer = {
  to: (value: number | null | undefined): number | null => value ?? null,
  from: (value: number | string | null): number | null => {
    if (value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  },
};
