import {
  legacyReasonStrings,
  toCompatConnectivityState,
  type ReasonRef,
} from '../domain/operational-health.types.js';

describe('operational-health compatibility projection', () => {
  it('collapses health DEGRADED/CRITICAL into the legacy connectivity.state alias', () => {
    expect(toCompatConnectivityState('ONLINE', 'HEALTHY')).toBe('ONLINE');
    expect(toCompatConnectivityState('ONLINE', 'DEGRADED')).toBe('DEGRADED');
    expect(toCompatConnectivityState('ONLINE', 'CRITICAL')).toBe('DEGRADED');
    expect(toCompatConnectivityState('ONLINE', 'UNKNOWN')).toBe('UNKNOWN');
  });

  it('passes link OFFLINE / UNKNOWN / NEVER_SEEN straight through', () => {
    expect(toCompatConnectivityState('OFFLINE', 'UNKNOWN')).toBe('OFFLINE');
    expect(toCompatConnectivityState('OFFLINE', 'CRITICAL')).toBe('OFFLINE');
    expect(toCompatConnectivityState('UNKNOWN', 'UNKNOWN')).toBe('UNKNOWN');
    expect(toCompatConnectivityState('NEVER_SEEN', 'UNKNOWN')).toBe(
      'NEVER_SEEN',
    );
  });

  it('flattens structured reasons to a de-duplicated string list', () => {
    const reasons: ReasonRef[] = [
      { code: 'REPORTED_OFFLINE', source: 'RECORDER' },
      { code: 'RECORDER_VERIFIED_OFFLINE', source: 'RECORDER' },
      { code: 'REPORTED_OFFLINE', source: 'RECORDER' },
    ];

    expect(legacyReasonStrings(reasons)).toEqual([
      'REPORTED_OFFLINE',
      'RECORDER_VERIFIED_OFFLINE',
    ]);
  });

  it('collection-quality codes never influence the connectivity alias', () => {
    // Only link + health feed the alias; a PARTIAL collection with an
    // OPTIONAL_ENRICHMENT_UNAVAILABLE issue keeps the alias ONLINE.
    expect(toCompatConnectivityState('ONLINE', 'HEALTHY')).toBe('ONLINE');
  });
});
