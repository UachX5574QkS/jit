import { DEFAULT_API_CONFIG, isApiUrl } from './api-config';

describe('isApiUrl', () => {
  const config = DEFAULT_API_CONFIG;

  it('matches root-relative API paths', () => {
    expect(isApiUrl('/api/auth/me', config)).toBe(true);
    expect(isApiUrl('/api', config)).toBe(true);
  });

  it('matches absolute URLs whose path is under the base', () => {
    expect(isApiUrl('https://host.example/api/requests', config)).toBe(true);
  });

  it('rejects non-API paths', () => {
    expect(isApiUrl('/assets/logo.svg', config)).toBe(false);
    expect(isApiUrl('/apixyz/thing', config)).toBe(false);
    expect(isApiUrl('https://host.example/other', config)).toBe(false);
  });
});
