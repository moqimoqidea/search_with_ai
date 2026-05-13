import test from 'node:test';
import assert from 'node:assert/strict';
import { StructuredToolCallTracker } from './tool-call-tracker.js';

test('completes structured tool calls with the original pending id', () => {
  const tracker = new StructuredToolCallTracker();

  const [pendingCall] = tracker.registerPending([
    {
      id: 'call_generate_query',
      name: 'generate_query',
      args: {
        topic: 'latest OpenAI updates',
      },
    },
  ], 'generate_query');

  assert.deepEqual(pendingCall, {
    id: 'call_generate_query',
    name: 'generate_query',
    args: {
      topic: 'latest OpenAI updates',
    },
    status: 'pending',
    result: '',
  });

  const [completedCall] = tracker.complete('generate_query', 'done');

  assert.deepEqual(completedCall, {
    id: 'call_generate_query',
    name: 'generate_query',
    args: {
      topic: 'latest OpenAI updates',
    },
    status: 'completed',
    result: 'done',
  });
});

test('interrupts only the remaining pending structured tool calls', () => {
  const tracker = new StructuredToolCallTracker();

  tracker.registerPending([
    {
      id: 'call_reflection_1',
      name: 'reflection',
      args: {
        attempt: 1,
      },
    },
    {
      id: 'call_reflection_2',
      name: 'reflection',
      args: {
        attempt: 2,
      },
    },
  ], 'reflection');

  const [completedCall] = tracker.complete('reflection', 'first completed');
  assert.equal(completedCall.id, 'call_reflection_1');

  const interruptedCalls = tracker.interruptPending();

  assert.deepEqual(interruptedCalls, [
    {
      id: 'call_reflection_2',
      name: 'reflection',
      args: {
        attempt: 2,
      },
      status: 'interrupted',
      result: '',
    },
  ]);
});
