import test from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import { BaseOpenAIChat } from './openai.js';

type MockResponse = {
  id: string;
  output_text?: string;
  output: unknown[];
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  status?: string;
  error: { message?: string } | null;
  incomplete_details: { reason?: string } | null;
};

function createAsyncIterable<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) {
        yield item;
      }
    }
  };
}

function createMockClient() {
  const state: {
    completionRequest?: Record<string, unknown>;
    responseRequest?: Record<string, unknown>;
    streamRequest?: Record<string, unknown>;
    responseOverride?: MockResponse;
    streamFinalResponseOverride?: MockResponse;
  } = {};

  const client = {
    chat: {
      completions: {
        create: async (request: Record<string, unknown>) => {
          state.completionRequest = request;
          return {
            choices: [{ message: { content: 'hello from completions' } }],
            usage: {
              prompt_tokens: 5,
              completion_tokens: 7,
            },
          };
        },
      },
    },
    responses: {
      create: async (request: Record<string, unknown>) => {
        state.responseRequest = request;
        if (state.responseOverride) {
          return state.responseOverride;
        }
        return {
          id: 'resp_123',
          output_text: 'hello from responses',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'hello from responses' }],
            },
          ],
          usage: {
            input_tokens: 9,
            output_tokens: 4,
          },
          error: null,
          incomplete_details: null,
        };
      },
      stream: (request: Record<string, unknown>) => {
        state.streamRequest = request;
        const events = createAsyncIterable([
          { type: 'response.output_text.delta', delta: 'hello ' },
          { type: 'response.output_text.delta', delta: 'world' },
        ]);
        return {
          [Symbol.asyncIterator]: events[Symbol.asyncIterator].bind(events),
          finalResponse: async () => ({
            ...state.streamFinalResponseOverride,
            id: 'resp_456',
            output_text: 'hello world',
            output: [
              {
                type: 'message',
                content: [{ type: 'output_text', text: 'hello world' }],
              },
            ],
            usage: {
              input_tokens: 3,
              output_tokens: 2,
            },
            error: null,
            incomplete_details: null,
            ...state.streamFinalResponseOverride,
          }),
        };
      },
    },
    models: {
      list: async () => ({ data: [{ id: 'mock-model' }] }),
    },
  } as unknown as OpenAI;

  return { client, state };
}

test('defaults to chat completions mode when apiMode is omitted', async () => {
  const { client, state } = createMockClient();
  const subject = new BaseOpenAIChat('mock-provider', undefined, undefined, {
    client,
  });

  const response = await subject.chat({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hi' }],
  });

  assert.equal(response.content, 'hello from completions');
  assert.equal(state.completionRequest?.model, 'gpt-test');
  assert.deepEqual(state.completionRequest?.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(state.responseRequest, undefined);
});

test('uses responses.create with full transcript replay when apiMode is openai-responses', async () => {
  const { client, state } = createMockClient();
  const subject = new BaseOpenAIChat('mock-provider', undefined, undefined, {
    client,
    apiMode: 'openai-responses',
  });

  const response = await subject.chat({
    model: 'gpt-test',
    system: 'be concise',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ],
  });

  assert.equal(response.content, 'hello from responses');
  assert.equal(state.responseRequest?.model, 'gpt-test');
  assert.equal(state.responseRequest?.instructions, 'be concise');
  assert.deepEqual(state.responseRequest?.input, [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello' }],
    },
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'input_text', text: 'hi there' }],
    },
  ]);
  assert.equal(state.completionRequest, undefined);
});

test('streams responses output_text deltas when apiMode is openai-responses', async () => {
  const { client, state } = createMockClient();
  const subject = new BaseOpenAIChat('mock-provider', undefined, undefined, {
    client,
    apiMode: 'openai-responses',
  });
  const deltas: string[] = [];

  const response = await subject.chat({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
  }, (chunk) => {
    if (chunk && typeof chunk !== 'string') {
      deltas.push(chunk.content);
    }
  });

  assert.deepEqual(deltas, ['hello ', 'world']);
  assert.equal(response.content, 'hello world');
  assert.equal(state.streamRequest?.model, 'gpt-test');
  assert.deepEqual(state.streamRequest?.input, [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello' }],
    },
  ]);
});

test('extracts non-streaming Responses reasoning text content', async () => {
  const { client, state } = createMockClient();
  state.responseOverride = {
    id: 'resp_reasoning',
    output_text: 'answer',
    output: [
      {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'brief summary' }],
        content: [{ type: 'reasoning_text', text: 'private reasoning' }],
      },
      {
        type: 'message',
        content: [{ type: 'output_text', text: 'answer' }],
      },
    ],
    error: null,
    incomplete_details: null,
  };

  const subject = new BaseOpenAIChat('mock-provider', undefined, undefined, {
    client,
    apiMode: 'openai-responses',
  });

  const response = await subject.chat({
    model: 'gpt-test',
    messages: [{ role: 'user', content: 'hello' }],
  });

  assert.equal(response.reasoningContent, 'private reasoning');
});

test('throws when non-streaming Responses API returns failed status', async () => {
  const { client, state } = createMockClient();
  state.responseOverride = {
    id: 'resp_failed',
    output: [],
    status: 'failed',
    error: { message: 'model failed' },
    incomplete_details: null,
  };

  const subject = new BaseOpenAIChat('mock-provider', undefined, undefined, {
    client,
    apiMode: 'openai-responses',
  });

  await assert.rejects(
    subject.chat({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
    }),
    /mock-provider Responses API failed: model failed/
  );
});

test('throws when streaming Responses API final response is incomplete', async () => {
  const { client, state } = createMockClient();
  state.streamFinalResponseOverride = {
    id: 'resp_incomplete',
    output_text: 'partial',
    output: [
      {
        type: 'message',
        content: [{ type: 'output_text', text: 'partial' }],
      },
    ],
    status: 'incomplete',
    error: null,
    incomplete_details: { reason: 'max_output_tokens' },
  };

  const subject = new BaseOpenAIChat('mock-provider', undefined, undefined, {
    client,
    apiMode: 'openai-responses',
  });

  await assert.rejects(
    subject.chat({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
    }, () => {}),
    /mock-provider Responses API incomplete: max_output_tokens/
  );
});
