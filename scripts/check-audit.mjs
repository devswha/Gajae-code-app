#!/usr/bin/env node
// Keep npm's high/critical gate. A reviewed backport is recognized only after
// verifying its exact installed integrity; it is never a blanket advisory skip.
import { execFile as execFileCallback } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { applyExtractZipPatch } from './apply-extract-zip-patch.mjs';

const execFile = promisify(execFileCallback);
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BLOCKING_SEVERITIES = new Set(['high', 'critical']);
const ADVISORY_PATTERN = /GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}/iu;

export const EXCEPTIONS = [
  {
    advisory: 'GHSA-jmr9-qjv8-65gv',
    package: 'extract-zip',
    reviewedOn: '2026-09-09',
    reviewBy: '2026-11-30',
    reason: 'extract-zip has no patched release at review. It reaches us through '
      + '@gajae-code/coding-agent -> puppeteer-core 24.x -> @puppeteer/browsers 2.x; '
      + 'removing it needs a Puppeteer major upgrade. Retain the constrained-use exception: '
      + 'the app does not unpack attacker-supplied archives with extract-zip; its caller is '
      + 'Puppeteer browser acquisition from the pinned vendor download URL. Additionally require '
      + 'the canonical PR160 backport. PR160 does not establish remediation of this advisory in '
      + 'its full scope: symlinks themselves remain supported, and subsequent consumers or a '
      + 'concurrent local writer are outside the archive-only guarantee.',
  },
  {
    advisory: 'GHSA-7pqw-9j4j-h8q3',
    package: 'extract-zip',
    reviewedOn: '2026-09-09',
    reviewBy: '2026-11-30',
    reason: 'Backported the exact PR160 archive-only symlink-leaf fix to extract-zip 2.0.1; '
      + 'the PR was open/unmerged at review. Require the canonical manifest, package metadata, '
      + 'post-hash and single installed copy. This does not close the lstat/open race against '
      + 'a concurrent same-UID writer and is not sandbox protection.',
  },
];

const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

async function auditReport() {
  try {
    const { stdout } = await execFile('npm', ['audit', '--json'], { cwd: REPOSITORY_ROOT, maxBuffer: 32 * 1024 * 1024 });
    return JSON.parse(stdout);
  } catch (error) {
    // npm reports advisories with a nonzero exit. Network/error-only JSON is
    // rejected by evaluateAuditReport, not misinterpreted as a clean report.
    if (typeof error.stdout === 'string' && error.stdout.trim()) return JSON.parse(error.stdout);
    throw new Error('npm audit did not produce a report: ' + error.message);
  }
}

export async function evaluateAuditReport(report, {
  installRoot = REPOSITORY_ROOT, today = new Date().toISOString().slice(0, 10), exceptions = EXCEPTIONS,
} = {}) {
  const errors = [];
  const honored = [];
  if (!validDate(today) || report?.error || report?.auditReportVersion !== 2 || !report.vulnerabilities
    || typeof report.vulnerabilities !== 'object' || Array.isArray(report.vulnerabilities)
    || !report.metadata?.vulnerabilities) {
    return { errors: ['npm audit returned an invalid or incomplete report.'], honored };
  }
  let patchVerified = false;
  try {
    await applyExtractZipPatch(installRoot, { checkOnly: true });
    patchVerified = true;
  } catch (error) { errors.push('Canonical extract-zip patch verification failed: ' + error.message); }

  const blocking = [];
  for (const vulnerability of Object.values(report.vulnerabilities)) {
    if (!BLOCKING_SEVERITIES.has(vulnerability.severity)) continue;
    if (!Array.isArray(vulnerability.via) || !vulnerability.via.length) {
      errors.push('Blocking advisory has no evidence: ' + vulnerability.name);
      continue;
    }
    for (const via of vulnerability.via) {
      // String edges refer to the advisory-bearing dependency, never an
      // exception of their own. A dangling edge is not a clean audit.
      if (typeof via === 'string') {
        if (!report.vulnerabilities[via]) errors.push('Missing audit dependency evidence: ' + via);
        continue;
      }
      if (!via || typeof via !== 'object') {
        errors.push('Malformed audit advisory: ' + vulnerability.name);
        continue;
      }
      if (!BLOCKING_SEVERITIES.has(via.severity ?? vulnerability.severity)) continue;
      const advisory = ADVISORY_PATTERN.exec(via.url ?? via.title ?? '')?.[0]?.toUpperCase();
      if (!advisory) { errors.push('Unidentified blocking advisory: ' + vulnerability.name); continue; }
      blocking.push({ advisory, package: via.name ?? vulnerability.name, owner: vulnerability.name,
        nodes: vulnerability.nodes, severity: via.severity ?? vulnerability.severity, title: via.title ?? '' });
    }
  }

  const recognized = new Set();
  for (const exception of exceptions) {
    const advisory = exception.advisory.toUpperCase();
    const matches = blocking.filter(live => live.advisory === advisory && live.package === exception.package && live.owner === exception.package);
    if (!matches.length) {
      errors.push('Exception for ' + advisory + ' no longer matches a high or critical advisory; remove or re-review it.');
      continue;
    }
    if (!validDate(exception.reviewedOn) || !validDate(exception.reviewBy) || exception.reviewedOn > today
      || exception.reviewBy < today || exception.reviewBy < exception.reviewedOn || !exception.reason?.trim()) {
      errors.push('Missing, future or expired review for ' + advisory + ' (review by ' + exception.reviewBy + ').');
      continue;
    }
    if (matches.some(live => !Array.isArray(live.nodes) || live.nodes.length !== 1 || live.nodes[0] !== 'node_modules/extract-zip')) {
      errors.push('Unreviewed installed paths for ' + advisory + '; nested/unknown extract-zip copies are not covered.');
      continue;
    }
    if (!patchVerified) continue;
    for (const live of matches) recognized.add(live);
    honored.push(advisory + ' (' + exception.package + ', canonical archive-only backport; reviewed '
      + exception.reviewedOn + ', review by ' + exception.reviewBy + ')');
  }
  for (const live of blocking) {
    if (!recognized.has(live)) errors.push(live.severity + ' advisory ' + live.advisory + ' in ' + live.package + ': ' + live.title);
  }
  return { errors, honored };
}

async function main() {
  const report = await auditReport();
  const { errors, honored } = await evaluateAuditReport(report);
  if (errors.length) {
    console.error('Dependency audit failed:\n' + errors.map(error => '  - ' + error).join('\n'));
    console.error('\nRun npm audit for the full report. Do not bypass the integrity or review gates.');
    process.exitCode = 1;
    return;
  }
  const belowGate = Object.entries(report.metadata.vulnerabilities)
    .filter(([severity, count]) => !BLOCKING_SEVERITIES.has(severity) && severity !== 'total' && count > 0)
    .map(([severity, count]) => count + ' ' + severity).join(', ');
  console.log('Dependency audit passed (no unexpected high or critical advisories' + (belowGate ? '; below the gate: ' + belowGate : '') + ').');
  for (const entry of honored) console.log('  verified, time-bounded exception: ' + entry);
}

const entry = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => null) : null;
if (entry !== null && entry === await realpath(fileURLToPath(import.meta.url))) {
  main().catch(error => { console.error('Dependency audit failed: ' + error.message); process.exitCode = 1; });
}
