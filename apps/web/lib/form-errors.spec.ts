import { ApiError } from './api-client';
import { apiFieldErrors } from './form-errors';

describe('apiFieldErrors', () => {
  it('maps server validation messages to fields', () => {
    const err = new ApiError(400, 'VALIDATION', ['timezone must be a valid IANA timezone', 'name must be longer']);
    expect(apiFieldErrors(err, ['name', 'timezone'])).toEqual({
      timezone: 'timezone must be a valid IANA timezone',
      name: 'name must be longer',
    });
  });
  it('ignores non-validation errors', () => {
    expect(apiFieldErrors(new ApiError(403, 'X', 'no'), ['name'])).toEqual({});
  });
});
