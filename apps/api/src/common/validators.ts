import { Transform } from 'class-transformer';

/** Trims strings; empty string becomes null (clears the value on update, absent on create). */
export const TrimToNull = () =>
  Transform(({ value }) => {
    if (typeof value !== 'string') return value;
    const v = value.trim();
    return v === '' ? null : v;
  });

export const Trim = () => Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

export const Upper = () => Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value));

/** Accepts an array of strings, trims items and drops empties. */
export const CleanList = () =>
  Transform(({ value }) =>
    Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v.trim() : v)).filter((v) => v !== '') : value,
  );

export const MONEY_REGEX = /^\d{1,10}(\.\d{1,2})?$/;
export const ID_REGEX = /^[a-z0-9]{20,40}$/;
export const HTTP_URL_REGEX = /^https?:\/\/\S+$/i;
