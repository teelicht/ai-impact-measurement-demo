import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Coverage, SourceBundle, SourceName, SourceSelector } from '../model.js';
import { validateBundle } from '../validate.js';
import { loadChargeFile, loadTicketFile, loadUsageFile } from './files.js';
import { loadLocalGit } from './git.js';
import { classifyCommitLink } from '../commit-links.js';

type Config = Pick<SourceBundle, 'scope' | 'startDate' | 'endDate' | 'timezone' |
  'extractedAt' | 'currency' | 'completenessAttestation'> & {
  version: 1;
  sources: Partial<Record<SourceName, SourceSelector>>;
  context?: SourceBundle['context'];
};

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}: must be an object`);
  }
  return value as Record<string, unknown>;
}

function parseConfig(value: unknown, path: string): Config {
  const data = object(value, `config ${path}`);
  if (data.version !== 1) throw new Error(`config ${path}: expected version 1`);
  const sources = object(data.sources, `config ${path}: sources`);
  for (const [name, value] of Object.entries(sources)) {
    if (!(['tickets', 'commits', 'usage', 'charges'] as string[]).includes(name)) {
      throw new Error(`config ${path}: unsupported source ${name}`);
    }
    const selector = object(value, `config ${path}: ${name}`);
    if (!['synthetic', 'file', 'git', 'module'].includes(String(selector.kind))) {
      throw new Error(`config ${path}: ${name} has unsupported kind`);
    }
    if (selector.kind === 'synthetic') {
      throw new Error(`config ${path}: configured synthetic selectors are not supported; use the no-config demo`);
    }
    if ((selector.kind === 'file' || selector.kind === 'module') &&
        (typeof selector.path !== 'string' || selector.path.trim() === '')) {
      throw new Error(`config ${path}: ${name} requires path`);
    }
    if (selector.path !== undefined && typeof selector.path !== 'string') {
      throw new Error(`config ${path}: ${name} path must be a string`);
    }
    if (selector.revision !== undefined && typeof selector.revision !== 'string') {
      throw new Error(`config ${path}: ${name} revision must be a string`);
    }
    if (selector.kind === 'git') {
      if (name !== 'commits' || typeof selector.path !== 'string' || !selector.path.trim() ||
          typeof selector.revision !== 'string' || !selector.revision.trim()) {
        throw new Error(`config ${path}: Git commits require path and revision`);
      }
      if (selector.ticketPattern !== undefined && typeof selector.ticketPattern !== 'string') {
        throw new Error(`config ${path}: Git ticketPattern must be a string`);
      }
      if (selector.botAuthors !== undefined && (!Array.isArray(selector.botAuthors) ||
          !selector.botAuthors.every((author: unknown) => typeof author === 'string' && author.trim()))) {
        throw new Error(`config ${path}: Git botAuthors must be a list of names`);
      }
    }
  }
  return data as unknown as Config;
}

export async function loadModule(path: string, config?: Config): Promise<Partial<SourceBundle>> {
  const imported: unknown = await import(pathToFileURL(resolve(path)).href);
  const module = object(imported, `module ${path}`);
  if (typeof module.loadSource !== 'function') {
    throw new Error(`module ${path}: expected export loadSource(config)`);
  }
  const result: unknown = await module.loadSource(config);
  return object(result, `module ${path}: result`) as Partial<SourceBundle>;
}

const names: SourceName[] = ['tickets', 'commits', 'usage', 'charges'];

export async function loadConfigured(configPath: string): Promise<SourceBundle> {
  let configJson: unknown;
  try {
    configJson = JSON.parse(await readFile(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`config ${configPath}: cannot read JSON: ${String(error)}`);
  }
  const config = parseConfig(configJson, configPath);
  const coverage: Coverage[] = [];
  const bundle: SourceBundle = {
    scope: config.scope, startDate: config.startDate, endDate: config.endDate,
    timezone: config.timezone, extractedAt: config.extractedAt, currency: config.currency,
    completenessAttestation: config.completenessAttestation,
    ...(config.context !== undefined && { context: config.context }),
    sourceKind: 'configured', coverage, sources: { ...config.sources },
  };
  for (const name of names) {
    const selector = config.sources[name];
    if (!selector) {
      coverage.push({ source: name, status: 'unavailable', eligible: 0, extracted: 0,
        linked: 0, excluded: 0, missing: 0, reason: 'No source configured.' });
      continue;
    }
    const sourcePath = selector.path ? resolve(dirname(configPath), selector.path) : undefined;
    let result: Partial<SourceBundle>;
    try {
      if (selector.kind === 'module' && sourcePath) {
        result = await loadModule(sourcePath, config);
      } else if (selector.kind === 'file' && sourcePath) {
        if (name === 'tickets') result = { tickets: await loadTicketFile(sourcePath) };
        else if (name === 'usage') result = { usage: await loadUsageFile(sourcePath) };
        else if (name === 'charges') result = { charges: await loadChargeFile(sourcePath) };
        else throw new Error('commit file imports are not supported; use a module or Git adapter');
      } else if (selector.kind === 'git' && name === 'commits' && sourcePath && selector.revision) {
        const loaded = loadLocalGit(sourcePath, selector.revision, config.startDate, config.endDate,
          config.timezone, selector.ticketPattern, selector.botAuthors);
        result = { commits: loaded.commits, coverage: [{ ...loaded.coverage,
          reason: `${loaded.coverage.reason} Git extracted at ${loaded.extractedAt}.` }] };
        bundle.sources = { ...bundle.sources, commits: { kind: 'git', revision: loaded.inspectedRevision } };
      } else {
        throw new Error('missing source path');
      }
      for (const other of names) {
        if (other !== name && result[other] !== undefined) {
          throw new Error(`unexpected ${other} records in ${name} source`);
        }
      }
      const entries = result.coverage?.filter(entry => entry.source === name) ?? [];
      if ((result.coverage?.length ?? 0) !== entries.length || entries.length > 1) {
        throw new Error(`coverage must describe only ${name} once`);
      }
      if (selector.kind === 'module' && entries.length !== 1) {
        throw new Error(`coverage required for ${name} module`);
      }
      const fileCoverage = selector.kind === 'file' ? selector.coverage : undefined;
      if (selector.kind === 'file' && fileCoverage === undefined) {
        throw new Error(`coverage required for ${name} file`);
      }
      const items = result[name];
      if (items === undefined && entries[0]?.status !== 'unavailable') {
        throw new Error(`missing ${name} records`);
      }
      const declaredCoverage = entries[0] ?? (fileCoverage !== undefined
        ? { ...fileCoverage, source: name }
        : { source: name, status: 'available' as const, eligible: items?.length ?? 0,
            extracted: items?.length ?? 0, linked: 0, excluded: 0, missing: 0, reason: '' });
      if (items !== undefined && !Array.isArray(items)) {
        throw new Error(`${name} records must be an array`);
      }
      if (items !== undefined && declaredCoverage.extracted !== items.length) {
        throw new Error(`${name} coverage extracted must match returned records`);
      }
      if (items !== undefined) Object.assign(bundle, { [name]: items });
      coverage.push(declaredCoverage);
    } catch (error) {
      throw new Error(`${name} ${selector.kind === 'git' ? 'git' : sourcePath ?? selector.kind}: ${String(error)}`);
    }
  }
  if (config.sources.commits?.kind === 'git' && bundle.commits) {
    const gitCoverage = coverage.find(entry => entry.source === 'commits');
    if (gitCoverage) {
      if (bundle.tickets) {
        const knownTickets = new Set(bundle.tickets.map(ticket => ticket.id));
        let unlinked = 0;
        let ambiguous = 0;
        for (const commit of bundle.commits) {
          if (commit.bot || commit.parents.length > 1) continue;
          const link = classifyCommitLink(commit, knownTickets);
          if (link === 'linked') gitCoverage.linked++;
          else {
            unlinked++;
            if (link === 'ambiguous') ambiguous++;
          }
        }
        gitCoverage.reason += ` Verified against supplied ticket source: ${gitCoverage.linked} verified links, ` +
          `${unlinked} unlinked (including ${ambiguous} ambiguous).`;
      } else {
        gitCoverage.reason += ' Ticket links unverified without a supplied ticket source.';
      }
    }
  }
  return validateBundle(bundle);
}