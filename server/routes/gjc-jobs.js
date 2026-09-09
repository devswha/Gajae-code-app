import crypto from 'node:crypto';

import express from 'express';
import { Octokit } from '@octokit/rest';

import { githubTokensDb } from '../modules/database/index.js';
import { getProductionJobAuthority, getProductionJobOrchestrator } from '../services/gjc-job-orchestrator.js';
import { getProductionGjcJobGitService } from '../services/gjc-job-git.service.js';
import { asyncHandler } from '../shared/utils.js';

const MAX_LIST_LIMIT = 100;
const MAX_SAFE_U64 = Number.MAX_SAFE_INTEGER;
const NATIVE_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const CONFLICT_CODES = new Set(['already_exists', 'invalid_transition', 'lease_held', 'stale_lease', 'terminal_job', 'event_conflict', 'worktree_conflict', 'authority_held', 'conflict', 'capacity_exhausted']);
const MIN_REPLAY_BYTE_BUDGET = 4 * 1024;
const MAX_REPLAY_BYTE_BUDGET = 48 * 1024;
const writer = { send() {} };
const text = value => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const invalidQuery = message => Object.assign(new Error(message), { code: 'invalid_request' });
const queryValue = (value, name) => {
  if (value === undefined) return undefined;
  if (Array.isArray(value) || typeof value !== 'string') throw invalidQuery(`${name} must be a single query value.`);
  return value.trim();
};
const u64 = (value, name) => {
  const source = queryValue(value, name);
  if (!source) return undefined;
  if (!/^(?:0|[1-9]\d*)$/u.test(source)) throw invalidQuery(`${name} must be an unsigned integer.`);
  const parsed = Number(source);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_SAFE_U64) throw invalidQuery(`${name} is outside the supported range.`);
  return parsed;
};
export const decodeListQuery = query => {
  const limit = u64(query.limit, 'limit');
  if (limit === 0) throw invalidQuery('limit must be at least 1.');
  const cursor = queryValue(query.cursor, 'cursor');
  if (cursor && !NATIVE_ID.test(cursor)) throw invalidQuery('cursor is invalid.');
  const archived = queryValue(query.archived, 'archived') ?? 'exclude';
  if (!['exclude', 'include', 'only'].includes(archived)) throw invalidQuery('archived must be exclude, include, or only.');
  return { archived, ...(cursor ? { afterCursor: cursor } : {}), ...(limit === undefined ? {} : { limit: Math.min(limit, MAX_LIST_LIMIT) }) };
};
export const decodeReplayQuery = query => {
  const after = u64(query.cursor, 'cursor');
  const rawBudget = queryValue(query.byteBudget, 'byteBudget');
  if (rawBudget !== undefined && !/^(?:0|[1-9]\d*)$/u.test(rawBudget)) throw invalidQuery('byteBudget must be an unsigned integer.');
  const byteBudget = rawBudget === undefined ? undefined : Number(rawBudget);
  if (byteBudget !== undefined && (!Number.isSafeInteger(byteBudget) || byteBudget > MAX_SAFE_U64)) throw invalidQuery('byteBudget is outside the supported range.');
  return { ...(after === undefined ? {} : { after }), ...(byteBudget === undefined ? {} : { byteBudget: Math.max(MIN_REPLAY_BYTE_BUDGET, Math.min(MAX_REPLAY_BYTE_BUDGET, byteBudget)) }) };
};
export const decodeGitSummariesQuery = query => {
  const source = queryValue(query.jobIds, 'jobIds');
  if (!source) throw invalidQuery('jobIds must include between 1 and 50 unique job IDs.');
  const jobIds = source.split(',');
  if (jobIds.length > 50 || jobIds.some(jobId => !NATIVE_ID.test(jobId)) || new Set(jobIds).size !== jobIds.length) {
    throw invalidQuery('jobIds must include between 1 and 50 unique safe job IDs.');
  }
  const refresh = queryValue(query.refresh, 'refresh');
  if (refresh !== undefined && refresh !== 'true') throw invalidQuery('refresh must be true when provided.');
  return { jobIds, forceRefresh: refresh === 'true' };
};
export const statusForGjcError = error => {
  const code = error?.code;
  if (code === 'GJC_JOB_AUTHORITY_UNAVAILABLE' || code === 'authority_unavailable' || code === 'authority-down' || code === 'authority_down' || /authority is unavailable/u.test(error?.message ?? '')) return 503;
  if (code === 'storage_failure') return 503;
  if (code === 'not_found') return 404;
  if (CONFLICT_CODES.has(code) || error?.name === 'GjcCapacityExhaustedError') return 409;
  return 400;
};
const fail = (res, error) => res.status(statusForGjcError(error)).json({ error: error instanceof Error ? error.message : 'GJC job request failed.', code: error?.code });
const appSession = body => text(body.appSessionId) ?? `gjc-${crypto.randomUUID()}`;
const jobResponse = (res, handle, appSessionId) => res.status(202).json({ provider: 'gjc', appSessionId, jobId: handle.jobId, runId: handle.runId });
const listResponse = value => {
  const source = Array.isArray(value) ? { items: value } : value && typeof value === 'object' ? value : {};
  return {
    items: Array.isArray(source.items) ? source.items : [],
    nextCursor: typeof source.nextCursor === 'string' ? source.nextCursor : null,
  };
};
export function createGjcJobsRouter({
  authority = getProductionJobAuthority(),
  orchestrator = getProductionJobOrchestrator(),
  gitService = getProductionGjcJobGitService(
    getProductionJobAuthority(),
    (jobId, eventId, payload) => getProductionJobOrchestrator().appendAdminEvent(jobId, eventId, payload),
  ),
} = {}) {
  const router = express.Router();
const jobGit = () => gitService;

router.post('/jobs', asyncHandler(async (req, res) => {
  const message = text(req.body?.message); const projectPath = text(req.body?.projectPath);
  if (!message || !projectPath) return res.status(400).json({ error: 'message and projectPath are required.' });
  // Managed job worktrees live under <repo>/.gjc-worktrees/<jobId>; accepting one
  // as a job target would nest worktrees. The client already filters these out,
  // but the HTTP surface must reject them too (defense in depth for direct calls).
  if (projectPath.split(/[\\/]/u).includes('.gjc-worktrees')) return res.status(400).json({ error: 'projectPath must not target a managed job worktree.', code: 'managed_worktree_project' });
  try { const appSessionId = appSession(req.body); const handle = await orchestrator.start('gjc', appSessionId, projectPath, message, { writer, provider: 'gjc', appSessionId, model: text(req.body.model), effort: text(req.body.effort) }); return jobResponse(res, handle, appSessionId); } catch (error) { return fail(res, error); }
}));
router.post('/jobs/:jobId/turns', asyncHandler(async (req, res) => {
  const message = text(req.body?.message); const appSessionId = text(req.body?.appSessionId) ?? text(req.body?.sessionId);
  if (!message || !appSessionId) return res.status(400).json({ error: 'message and appSessionId are required.' });
  try {
    const currentOrchestrator = orchestrator;
    const bound = await orchestrator.resolveBinding('gjc', appSessionId);
    if (!bound || bound.jobId !== req.params.jobId) return res.status(409).json({ error: 'appSessionId is not bound to this job.' });
    const handle = await currentOrchestrator.turnStart('gjc', appSessionId, message, { writer, provider: 'gjc', appSessionId, model: text(req.body.model), effort: text(req.body.effort) });
    return jobResponse(res, handle, appSessionId);
  } catch (error) { return fail(res, error); }
}));
router.post('/jobs/:jobId/resume', asyncHandler(async (req, res) => {
  const message = text(req.body?.message) ?? ''; const appSessionId = text(req.body?.appSessionId) ?? text(req.body?.sessionId);
  if (!appSessionId) return res.status(400).json({ error: 'appSessionId is required.' });
  try {
    // The orchestrator re-checks ownership, but only after the state check, and
    // it throws a plain Error that `fail` maps to 400. Mirroring the `/turns`
    // guard keeps a cross-session resume a 409 on both routes.
    const bound = await orchestrator.resolveBinding('gjc', appSessionId);
    if (!bound || bound.jobId !== req.params.jobId) return res.status(409).json({ error: 'appSessionId is not bound to this job.' });
    const handle = await orchestrator.resume(req.params.jobId, appSessionId, message, { writer, provider: 'gjc', appSessionId, model: text(req.body.model), effort: text(req.body.effort) });
    return jobResponse(res, handle, appSessionId);
  } catch (error) { return fail(res, error); }
}));
router.post('/jobs/:jobId/abort', asyncHandler(async (req, res) => { try { return res.status(202).json({ provider: 'gjc', jobId: req.params.jobId, aborted: await orchestrator.abort(req.params.jobId) }); } catch (error) { return fail(res, error); } }));
router.post('/jobs/:jobId/archive', asyncHandler(async (req, res) => { try { return res.json(await authority.archive({ jobId: req.params.jobId })); } catch (error) { return fail(res, error); } }));
router.post('/jobs/:jobId/unarchive', asyncHandler(async (req, res) => { try { return res.json(await authority.unarchive({ jobId: req.params.jobId })); } catch (error) { return fail(res, error); } }));
router.get('/jobs', asyncHandler(async (req, res) => {
  try {
    return res.json(listResponse(await authority.list(decodeListQuery(req.query))));
  } catch (error) {
    return fail(res, error);
  }
}));
router.get('/jobs/git-summaries', asyncHandler(async (req, res) => {
  try {
    const { jobIds, forceRefresh } = decodeGitSummariesQuery(req.query);
    return res.json(await jobGit().summaries(jobIds, { forceRefresh }));
  } catch (error) {
    return fail(res, error);
  }
}));
router.get('/jobs/:jobId', asyncHandler(async (req, res) => { try { return res.json(await authority.get({ jobId: req.params.jobId })); } catch (error) { return fail(res, error); } }));
router.get('/jobs/:jobId/events', asyncHandler(async (req, res) => {
  try {
    return res.json(await authority.replayEvents({ jobId: req.params.jobId, ...decodeReplayQuery(req.query) }));
  } catch (error) {
    return fail(res, error);
  }
}));
router.get('/jobs/:jobId/git/status', asyncHandler(async (req, res) => { try { return res.json(await jobGit().status(req.params.jobId)); } catch (error) { return fail(res, error); } }));
router.get('/jobs/:jobId/git/diff', asyncHandler(async (req, res) => { try { return res.json(await jobGit().diff(req.params.jobId)); } catch (error) { return fail(res, error); } }));
router.post('/jobs/:jobId/git/publish', asyncHandler(async (req, res) => { try { return res.json(await jobGit().publish(req.params.jobId)); } catch (error) { return fail(res, error); } }));
router.post('/jobs/:jobId/git/commit', asyncHandler(async (req, res) => { try { return res.status(201).json(await jobGit().commit(req.params.jobId, req.body?.message, req.body?.paths)); } catch (error) { return fail(res, error); } }));
router.post('/jobs/:jobId/git/pr', asyncHandler(async (req, res) => {
  try {
    const result = await jobGit().createPullRequest(req.params.jobId, async context => {
      const match = context.remoteUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/u);
      if (!match) throw new Error('The job remote is not a GitHub repository.');
      const token = githubTokensDb.getActiveGithubToken(req.user?.id);
      if (!token) throw new Error('GitHub token required to create a pull request.');
      const { data } = await new Octokit({ auth: token }).pulls.create({ owner: match[1], repo: match[2], head: context.branch, base: context.baseBranch, title: text(req.body?.title) ?? context.branch, body: text(req.body?.body) ?? '' });
      return { number: data.number, url: data.html_url, branch: context.branch, baseBranch: context.baseBranch };
    });
    return res.status(201).json(result);
  } catch (error) { return fail(res, error); }
}));

  return router;
}
export default createGjcJobsRouter();
