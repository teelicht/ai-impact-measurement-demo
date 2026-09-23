import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('default CLI writes one synthetic report as HTML, monthly CSV and evidence JSON', () => {
  const output = mkdtempSync(join(tmpdir(), 'ai-report-'));
  try {
    const result = spawnSync(process.execPath, [cli, '--out', output], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(output).sort(), [
      'api-team.html', 'api-team-monthly.csv', 'api-team-evidence.json',
    ].sort());
    const html = readFileSync(join(output, 'api-team.html'), 'utf8');
    const csv = readFileSync(join(output, 'api-team-monthly.csv'), 'utf8');
    const evidence = JSON.parse(readFileSync(join(output, 'api-team-evidence.json'), 'utf8'));
    assert.match(html, /synthetic/i);
    assert.match(html, /Total AI cost: unassessed/i);
    assert.match(html, /human effort[\s\S]*unassessed/i);
    assert.doesNotMatch(html, /https?:\/\/(?:[^"\s]*jira|[^"\s]*git(?:hub|lab))/i);
    const [header, ...rows] = csv.trim().split('\n').map(line => line.split(','));
    const month = header.indexOf('month');
    const approved = header.indexOf('approvedParents');
    assert.ok(month >= 0 && approved >= 0);
    assert.equal(rows.length, 12);
    assert.deepEqual(rows.map(row => row[month]).slice(0, 2), ['2025-09', '2025-10']);
    assert.equal(rows.slice(0, 6).reduce((sum, row) => sum + Number(row[approved]), 0), 126);
    assert.equal(rows.slice(6).reduce((sum, row) => sum + Number(row[approved]), 0), 168);
    assert.equal(evidence.sourceKind, 'synthetic');
    assert.equal(evidence.context.owner, 'Engineering lead (fictional)');
    for (const source of ['tickets', 'commits', 'usage', 'charges']) {
      assert.ok(evidence.coverage.some((entry: { source: string }) => entry.source === source));
    }
    assert.equal(evidence.totalAiCost, null);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('a missing configured input fails without creating synthetic output', () => {
  const output = mkdtempSync(join(tmpdir(), 'ai-report-bad-'));
  try {
    const result = spawnSync(process.execPath, [cli, '--config', join(output, 'missing.json'), '--out', output],
      { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /config.*missing\.json/i);
    assert.equal(existsSync(join(output, 'api-team.html')), false);
    assert.equal(existsSync(join(output, 'api-team-monthly.csv')), false);
    assert.equal(existsSync(join(output, 'api-team-evidence.json')), false);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('configured ticket exports keep their actual window and unavailable sources', () => {
  const output = mkdtempSync(join(tmpdir(), 'ai-report-config-'));
  const config = fileURLToPath(new URL('../../examples/config.json', import.meta.url));
  try {
    const result = spawnSync(process.execPath, [cli, '--config', config, '--out', output],
      { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const html = readFileSync(join(output, 'example-api-team.html'), 'utf8');
    const csv = readFileSync(join(output, 'example-api-team-monthly.csv'), 'utf8');
    const evidence = JSON.parse(readFileSync(join(output, 'example-api-team-evidence.json'), 'utf8'));
    assert.match(html, /Configured sources/);
    assert.match(html, /live status unverified/i);
    assert.doesNotMatch(html, /M7 split|Synthetic example, not a live team result/);
    assert.equal(csv.trim().split('\n').length, 2);
    assert.match(csv, /2026-03/);
    assert.equal(evidence.sourceKind, 'configured');
    assert.equal(evidence.context, null);
    assert.equal(evidence.periods.length, 0);
    assert.equal(evidence.coverage.find((entry: { source: string }) => entry.source === 'commits').status,
      'unavailable');
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('configured report metadata appears in HTML and evidence without synthetic fallback', () => {
  const output = mkdtempSync(join(tmpdir(), 'ai-report-context-'));
  const example = fileURLToPath(new URL('../../examples/config.json', import.meta.url));
  try {
    const configuration = JSON.parse(readFileSync(example, 'utf8'));
    configuration.sources = {};
    configuration.context = { owner: 'Service lead', updatedAt: '2026-04-02',
      description: 'Fictional checkout service', repositories: ['Synthetic checkout history'] };
    const configPath = join(output, 'config.json');
    writeFileSync(configPath, JSON.stringify(configuration));
    const result = spawnSync(process.execPath, [cli, '--config', configPath, '--out', output],
      { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const html = readFileSync(join(output, 'example-api-team.html'), 'utf8');
    const evidence = JSON.parse(readFileSync(join(output, 'example-api-team-evidence.json'), 'utf8'));
    assert.match(html, /Service lead/);
    assert.match(html, /Fictional checkout service/);
    assert.doesNotMatch(html, /Synthetic API commit history/);
    assert.equal(evidence.context.updatedAt, '2026-04-02');
    assert.deepEqual(evidence.context.repositories, ['Synthetic checkout history']);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('one-month partial incoming bugs retain the numeric count and status in both exports', () => {
  const output = mkdtempSync(join(tmpdir(), 'ai-report-partial-'));
  const example = fileURLToPath(new URL('../../examples/config.json', import.meta.url));
  try {
    const config = JSON.parse(readFileSync(example, 'utf8'));
    config.scope = 'API team';
    writeFileSync(join(output, 'config.json'), JSON.stringify(config));
    writeFileSync(join(output, 'tickets.json'), JSON.stringify({ version: 1, tickets: [
      { id: 'BUG-1', type: 'Bug', createdAt: '2026-03-05T09:00:00Z', production: true,
        statusEvents: [] },
      { id: 'BUG-2', type: 'Bug', createdAt: '2026-03-06T09:00:00Z', statusEvents: [] },
    ] }));
    const result = spawnSync(process.execPath, [cli, '--config', join(output, 'config.json'), '--out', output],
      { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const [header, values] = readFileSync(join(output, 'api-team-monthly.csv'), 'utf8').trim().split('\n')
      .map(line => line.split(','));
    for (const measure of ['approvedParents', 'createdParents', 'openParents', 'incomingBugs',
      'commits', 'testTouchCommits', 'tokens', 'toolSpend']) {
      assert.equal(header.indexOf(`${measure}Status`), header.indexOf(measure) + 1);
    }
    assert.equal(values[header.indexOf('incomingBugs')], '1');
    assert.equal(values[header.indexOf('incomingBugsStatus')], 'partial');
    assert.equal(values[header.indexOf('commits')], '');
    assert.equal(values[header.indexOf('commitsStatus')], 'unavailable');
    const evidence = JSON.parse(readFileSync(join(output, 'api-team-evidence.json'), 'utf8'));
    assert.equal(evidence.monthly.length, 1);
    assert.equal(evidence.monthly[0].month, '2026-03');
    assert.equal(evidence.monthly[0].incomingBugs, 1);
    assert.equal(evidence.monthly[0].measureStatus.incomingBugs, 'partial');
    assert.equal(evidence.monthly[0].commits, null);
    assert.equal(evidence.monthly[0].measureStatus.commits, 'unavailable');
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('repeating --out rejects the default-valued first occurrence before writing files', () => {
  const output = mkdtempSync(join(tmpdir(), 'ai-report-repeat-'));
  try {
    const result = spawnSync(process.execPath, [cli, '--out', 'output', '--out', 'another'],
      { encoding: 'utf8', cwd: output });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /repeated option: --out/i);
    assert.equal(existsSync(join(output, 'output')), false);
    assert.equal(existsSync(join(output, 'another')), false);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('configured exports use safe scope slugs and a predictable fallback for empty slugs', () => {
  const root = mkdtempSync(join(tmpdir(), 'ai-report-scope-'));
  const example = fileURLToPath(new URL('../../examples/config.json', import.meta.url));
  const tickets = fileURLToPath(new URL('../../examples/tickets.json', import.meta.url));
  const config = JSON.parse(readFileSync(example, 'utf8'));
  config.sources.tickets.path = tickets;
  const output = join(root, 'exports');
  try {
    for (const [scope, base] of [
      ['../Finance / Platform', 'finance-platform'],
      ['.../../', 'team-report'],
    ]) {
      config.scope = scope;
      const configPath = join(root, 'config.json');
      writeFileSync(configPath, JSON.stringify(config));
      const result = spawnSync(process.execPath, [cli, '--config', configPath, '--out', output],
        { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(readdirSync(output).sort(), [
        `${base}.html`, `${base}-monthly.csv`, `${base}-evidence.json`,
      ].sort());
      const evidence = JSON.parse(readFileSync(join(output, `${base}-evidence.json`), 'utf8'));
      assert.equal(evidence.scope, scope);
      rmSync(output, { recursive: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});