import { ApiError, defaultMessageForCode, isApiErrorCode } from './api-error';

describe('ApiError', () => {
  describe('isApiErrorCode', () => {
    it('recognises documented backend codes', () => {
      expect(isApiErrorCode('INVALID_TRANSITION')).toBe(true);
      expect(isApiErrorCode('CONFLICT_OPEN_REQUESTS')).toBe(true);
      expect(isApiErrorCode('TIMER_MIN_DURATION')).toBe(true);
    });

    it('rejects the frontend-only NETWORK_ERROR and unknowns', () => {
      expect(isApiErrorCode('NETWORK_ERROR')).toBe(false);
      expect(isApiErrorCode('WHATEVER')).toBe(false);
    });
  });

  describe('fromHttp', () => {
    it('maps status 0 to NETWORK_ERROR', () => {
      const err = ApiError.fromHttp(0, null);
      expect(err.code).toBe('NETWORK_ERROR');
      expect(err.status).toBe(0);
    });

    it('reads a recognised uniform error envelope verbatim', () => {
      const err = ApiError.fromHttp(409, {
        error: { code: 'INVALID_TRANSITION', message: 'Cannot go there', details: { from: 'NEW' } },
      });
      expect(err.code).toBe('INVALID_TRANSITION');
      expect(err.message).toBe('Cannot go there');
      expect(err.status).toBe(409);
      expect(err.details).toEqual({ from: 'NEW' });
    });

    it('maps MANDATORY_FIELD and VALIDATION_FAILED envelopes', () => {
      expect(
        ApiError.fromHttp(409, { error: { code: 'MANDATORY_FIELD', message: 'x' } }).code,
      ).toBe('MANDATORY_FIELD');
      expect(
        ApiError.fromHttp(400, { error: { code: 'VALIDATION_FAILED', message: 'x' } }).code,
      ).toBe('VALIDATION_FAILED');
    });

    it('supplies a default message when the envelope omits one', () => {
      const err = ApiError.fromHttp(409, { error: { code: 'CONFLICT_OPEN_REQUESTS' } });
      expect(err.code).toBe('CONFLICT_OPEN_REQUESTS');
      expect(err.message).toBe(defaultMessageForCode('CONFLICT_OPEN_REQUESTS'));
    });

    it('falls back by status when the body is not a recognised envelope', () => {
      expect(ApiError.fromHttp(404, 'plain text').code).toBe('NOT_FOUND');
      expect(ApiError.fromHttp(403, {}).code).toBe('FORBIDDEN');
      expect(ApiError.fromHttp(401, null).code).toBe('FORBIDDEN');
      expect(ApiError.fromHttp(400, {}).code).toBe('VALIDATION_FAILED');
      expect(ApiError.fromHttp(500, undefined).code).toBe('INTERNAL_ERROR');
    });

    it('ignores an unknown code in the envelope and falls back by status', () => {
      const err = ApiError.fromHttp(409, { error: { code: 'MADE_UP', message: 'x' } });
      expect(err.code).toBe('INVALID_TRANSITION'); // status-based fallback for 409
    });
  });
});
