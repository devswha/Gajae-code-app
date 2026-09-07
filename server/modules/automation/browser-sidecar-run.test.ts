import assert from 'node:assert/strict';
import test from 'node:test';

import type { CDPSession } from 'puppeteer-core';

import { evaluateBrowserScript } from './browser-sidecar.js';

function cdpFixture(responses: Array<Record<string, unknown> | Error>) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const cdp = {
    async send(method: string, params: Record<string, unknown>) {
      calls.push({ method, params });
      if (method === 'Runtime.releaseObjectGroup') return {};
      const response = responses.shift();
      if (response instanceof Error) throw response;
      assert.ok(response, `Unexpected command: ${method}`);
      return response;
    },
  } as unknown as Pick<CDPSession, 'send'>;
  return { cdp, calls };
}

test('page scripts use top-level-await evaluation without disabling CSP', async () => {
  const { cdp, calls } = cdpFixture([{ result: { type: 'number', value: 42 } }]);
  const code = 'const answer = await Promise.resolve(42); answer';
  assert.equal(await evaluateBrowserScript(cdp, code), 42);
  assert.equal(calls[0]!.method, 'Runtime.evaluate');
  assert.equal(calls[0]!.params.expression, code);
  assert.equal(calls[0]!.params.replMode, true);
  assert.equal(calls[0]!.params.awaitPromise, true);
  assert.equal(calls[0]!.params.allowUnsafeEvalBlockedByCSP, false);
  assert.deepEqual(calls.at(-1), { method: 'Runtime.releaseObjectGroup', params: { objectGroup: calls[0]!.params.objectGroup } });
});

test('ordinary Promise completions are awaited rather than serialized as empty objects', async () => {
  const { cdp, calls } = cdpFixture([
    { result: { type: 'object', subtype: 'promise', objectId: 'promise-1' } },
    { result: { type: 'object', value: { done: true } } },
  ]);
  assert.deepEqual(await evaluateBrowserScript(cdp, 'Promise.resolve({done:true})'), { done: true });
  assert.deepEqual(calls[1], { method: 'Runtime.awaitPromise', params: { promiseObjectId: 'promise-1', returnByValue: true } });
  assert.equal(calls.filter((call) => call.method === 'Runtime.evaluate').length, 1);
});

test('object results are read from their handle without rerunning the source', async () => {
  const { cdp, calls } = cdpFixture([
    { result: { type: 'object', objectId: 'object-1' } },
    { result: { type: 'object', value: { count: 1 } } },
  ]);
  assert.deepEqual(await evaluateBrowserScript(cdp, '({ count: ++window.count })'), { count: 1 });
  assert.equal(calls[1]!.method, 'Runtime.callFunctionOn');
  assert.equal(calls[1]!.params.objectId, 'object-1');
  assert.equal(calls[1]!.params.functionDeclaration, 'function() { return this; }');
  assert.equal(calls.filter((call) => call.method === 'Runtime.evaluate').length, 1);
});

test('script and promise errors propagate while their remote objects are released', async () => {
  const exception = { exceptionId: 1, text: 'Uncaught', lineNumber: 0, columnNumber: 0,
    exception: { type: 'object', subtype: 'error', className: 'SyntaxError', description: 'SyntaxError: script failed' } };
  for (const promise of [false, true]) {
    const { cdp, calls } = cdpFixture([
      ...(promise ? [{ result: { type: 'object', subtype: 'promise', objectId: 'promise-error' } }] : []),
      { result: { type: 'undefined' }, exceptionDetails: exception },
    ]);
    await assert.rejects(evaluateBrowserScript(cdp, 'window.count++; throw new SyntaxError("script failed")'), /script failed/);
    assert.equal(calls.filter((call) => call.method === 'Runtime.evaluate').length, 1);
    assert.equal(calls.at(-1)!.method, 'Runtime.releaseObjectGroup');
  }
});

test('context closure is not mistaken for successful script completion', async () => {
  const failure = new Error('Target closed');
  const { cdp, calls } = cdpFixture([failure]);
  await assert.rejects(evaluateBrowserScript(cdp, 'await new Promise(() => {})'), error => error === failure);
  assert.equal(calls.at(-1)!.method, 'Runtime.releaseObjectGroup');
});
