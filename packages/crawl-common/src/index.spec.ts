import { requireInt } from './index.js';

describe('requireInt', () => {
  const ENV_KEY = '__TEST_REQUIRE_INT__';

  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it('returns the fallback when env var is not set', () => {
    expect(requireInt(ENV_KEY, '42')).toBe(42);
  });

  it('reads from env var when set', () => {
    process.env[ENV_KEY] = '99';
    expect(requireInt(ENV_KEY, '42')).toBe(99);
  });

  it('throws on non-numeric value', () => {
    process.env[ENV_KEY] = 'abc';
    expect(() => requireInt(ENV_KEY, '42')).toThrow(/must be an integer/);
  });

  it('throws on fractional value', () => {
    process.env[ENV_KEY] = '3.5';
    expect(() => requireInt(ENV_KEY, '42')).toThrow(/must be an integer/);
  });

  it('throws when value is below min', () => {
    process.env[ENV_KEY] = '0';
    expect(() => requireInt(ENV_KEY, '42', 1)).toThrow(/must be an integer/);
  });

  it('throws when value exceeds max', () => {
    process.env[ENV_KEY] = '70000';
    expect(() => requireInt(ENV_KEY, '42', 0, 65535)).toThrow(
      /must be an integer/,
    );
  });
});
