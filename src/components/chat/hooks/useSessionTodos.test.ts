import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { NormalizedMessage } from '../../../stores/useSessionStore';

import { sessionTodos } from './useSessionTodos';

const todoCall = (id: string, ops: unknown, toolUseResult?: unknown, timestamp = '2026-01-01T00:00:00Z'): NormalizedMessage => ({
  id,
  sessionId: 'session',
  timestamp,
  provider: 'gjc',
  kind: 'tool_use',
  toolId: id,
  toolName: 'todo_write',
  toolInput: { ops },
  toolResult: { content: 'ok', isError: false, ...(toolUseResult !== undefined ? { toolUseResult } : {}) },
} as unknown as NormalizedMessage);

test('todo ops fold into the session plan in order', () => {
  const phases = sessionTodos([
    todoCall('w1', [
      { op: 'init', list: [
        { phase: 'Set up', items: ['read the repo', 'write the plan'] },
        { phase: 'Build', items: ['implement it'] },
      ] },
    ]),
    todoCall('w2', [
      { op: 'start', task: 'read the repo' },
      { op: 'done', task: 'read the repo' },
      { op: 'start', task: 'write the plan' },
      { op: 'note', task: 'write the plan', text: 'two phases is enough' },
    ]),
    todoCall('w3', [
      { op: 'append', phase: 'Build', items: ['verify it'] },
      { op: 'drop', task: 'implement it' },
      { op: 'rm', task: 'verify it' },
    ]),
  ]);

  assert.deepEqual(phases, [
    {
      name: 'Set up',
      tasks: [
        { content: 'read the repo', status: 'completed', notes: [] },
        { content: 'write the plan', status: 'in_progress', notes: ['two phases is enough'] },
      ],
    },
    {
      name: 'Build',
      tasks: [{ content: 'implement it', status: 'abandoned', notes: [] }],
    },
  ]);
});

test('a later init replaces the plan; messages that are not todo_write are ignored', () => {
  const phases = sessionTodos([
    { kind: 'text', role: 'assistant', content: 'working on it' } as unknown as NormalizedMessage,
    todoCall('w1', [{ op: 'init', list: [{ phase: 'Old', items: ['stale task'] }] }]),
    todoCall('w2', [{ op: 'init', list: [{ phase: 'New', items: ['fresh task'] }] }]),
  ]);

  assert.deepEqual(phases, [{ name: 'New', tasks: [{ content: 'fresh task', status: 'pending', notes: [] }] }]);
});

test('the latest structured result wins over folding the ops', () => {
  const phases = sessionTodos([
    todoCall('w1', [{ op: 'init', list: [{ phase: 'Plan', items: ['a', 'b'] }] }]),
    todoCall('w2', [{ op: 'done', task: 'a' }], {
      phases: [{ name: 'Plan', tasks: [
        { content: 'a', status: 'completed', notes: [] },
        { content: 'b', status: 'in_progress', notes: ['halfway'] },
      ] }],
      storage: 'session',
    }),
    todoCall('w3', [{ op: 'init', list: [{ phase: 'Plan', items: ['a', 'b'] }] }], {
      phases: [{ name: 'Plan', tasks: [{ content: 'only', status: 'pending' }] }],
      storage: 'session',
    }),
  ]);

  assert.deepEqual(phases, [{ name: 'Plan', tasks: [{ content: 'only', status: 'pending', notes: [] }] }]);
});

test('a chat session without todo_write has no plan', () => {
  assert.deepEqual(sessionTodos([{ kind: 'text', role: 'user', content: 'hi' } as unknown as NormalizedMessage]), []);
});
