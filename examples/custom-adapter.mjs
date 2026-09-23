export async function loadSource(config) {
  return {
    tickets: [{
      id: 'API-901', type: 'Story', status: 'open',
      createdAt: '2026-03-04T09:00:00Z', approvals: [],
      provenance: { source: 'example-module', recordId: 'API-901' },
    }],
    coverage: [{
      source: 'tickets', status: 'partial', eligible: 2, extracted: 1,
      linked: 0, excluded: 0, missing: 1,
      reason: `One ${config.scope} ticket was not exported.`,
    }],
  };
}