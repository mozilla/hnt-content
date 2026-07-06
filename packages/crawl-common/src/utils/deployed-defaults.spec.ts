import { describe, expect, it } from 'vitest';
import { deployedProjectId, deployedRedisHost } from './deployed-defaults.js';

describe('deployedRedisHost', () => {
  it('returns the Memorystore IP per deploy environment', () => {
    expect(deployedRedisHost('dev')).toBe('172.16.37.52');
    expect(deployedRedisHost('stage')).toBe('172.16.37.60');
    expect(deployedRedisHost('prod')).toBe('172.16.18.188');
  });

  it('returns empty for an unknown or unset environment', () => {
    expect(deployedRedisHost(undefined)).toBe('');
    expect(deployedRedisHost('local')).toBe('');
    expect(deployedRedisHost('')).toBe('');
  });
});

describe('deployedProjectId', () => {
  it('returns the GCP project id per deploy environment', () => {
    expect(deployedProjectId('dev')).toBe('moz-fx-hnt-nonprod');
    expect(deployedProjectId('stage')).toBe('moz-fx-hnt-nonprod');
    expect(deployedProjectId('prod')).toBe('moz-fx-hnt-prod');
  });

  it('returns empty for an unknown or unset environment', () => {
    expect(deployedProjectId(undefined)).toBe('');
    expect(deployedProjectId('local')).toBe('');
    expect(deployedProjectId('')).toBe('');
  });
});
