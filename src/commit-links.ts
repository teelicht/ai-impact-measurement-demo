import type { Commit } from './model.js';

export function isUnitTestPath(path: string): boolean {
  return /(^|\/)(?:tests?|__tests__)\//i.test(path) ||
    /(^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path) ||
    /(^|\/)[^/]+_test\.go$/i.test(path) ||
    /(^|\/)test_[^/]+\.py$/i.test(path);
}

export function classifyCommitLink(commit: Commit, knownTickets: ReadonlySet<string>):
  'linked' | 'unlinked' | 'ambiguous' {
  const ids = new Set(commit.ticketIds);
  return ids.size > 1 ? 'ambiguous' : ids.size === 1 && knownTickets.has([...ids][0])
    ? 'linked' : 'unlinked';
}