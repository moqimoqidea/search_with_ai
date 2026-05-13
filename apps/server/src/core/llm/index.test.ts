import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { getProviderClient } from './index.js';

test('getProviderClient accepts explicit openai-responses mode override', async () => {
  const requests: Record<string, unknown>[] = [];
  const mockClient = {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>) => {
          requests.push({ kind: 'completions', request });
          return {
            choices: [{ message: { content: 'completion' } }],
          };
        },
      },
    },
    responses: {
      create: async (request: Record<string, unknown>) => {
        requests.push({ kind: 'responses', request });
        return {
          id: 'resp_123',
          output_text: 'response',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'response' }],
            },
          ],
          error: null,
          incomplete_details: null,
        };
      },
      stream: () => {
        throw new Error('not used');
      },
    },
    models: {
      list: async () => ({ data: [] }),
    },
  };

  const subject = getProviderClient('siliconflow', 'test-key', 'https://example.com/v1', {
    apiMode: 'openai-responses',
    client: mockClient as unknown as OpenAI,
  });

  await subject.chat({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.kind, 'responses');
});

test('getProviderClient defaults OpenAI providers to chat completions when apiMode is not configured', async () => {
  const requests: Record<string, unknown>[] = [];
  const mockClient = {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>) => {
          requests.push({ kind: 'completions', request });
          return {
            choices: [{ message: { content: 'completion' } }],
          };
        },
      },
    },
    responses: {
      create: () => {
        throw new Error('not used');
      },
      stream: () => {
        throw new Error('not used');
      },
    },
    models: {
      list: async () => ({ data: [] }),
    },
  };

  const subject = getProviderClient('siliconflow', 'test-key', 'https://example.com/v1', {
    client: mockClient as unknown as OpenAI,
  });

  await subject.chat({
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.kind, 'completions');
});
