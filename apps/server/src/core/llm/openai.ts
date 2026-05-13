import OpenAI from 'openai';
import {
  ChatCompletionMessageParam,
  ChatCompletionChunk,
  ChatCompletion,
} from 'openai/resources/chat/completions/completions.js';
import {
  Response,
  ResponseInputItem,
  ResponseStatus,
} from 'openai/resources/responses/responses.js';
import {
  IChatInputToolMessage,
  IChatMessage,
  IChatResponse,
  IStreamHandler,
  OpenAIAPIMode,
} from '../../interface.js';
import { BaseChat } from './base.js';
import { IChatOptions, IProviderClientOptions } from './type.js';

const DEFAULT_OPENAI_API_MODE: OpenAIAPIMode = 'openai-completions';

export class BaseOpenAIChat implements BaseChat {
  private openai: OpenAI | null = null;
  public provider: string;
  private apiMode: OpenAIAPIMode;

  constructor(provider: string, apiKey?: string, baseURL?: string, options?: IProviderClientOptions) {
    this.provider = provider;
    this.apiMode = options?.apiMode ?? DEFAULT_OPENAI_API_MODE;
    if (options?.client) {
      this.openai = options.client;
    } else if (apiKey) {
      this.openai = new OpenAI({
        baseURL,
        apiKey,
      });
    }
  }

  async chat(options: IChatOptions, onMessage?: IStreamHandler) {
    if (!this.openai) {
      throw new Error(`${this.provider} key is not set`);
    }

    if (this.apiMode === 'openai-responses') {
      return this.chatWithResponses(options, onMessage);
    }

    return this.chatWithCompletions(options, onMessage);
  }

  async listModels() {
    if (!this.openai) throw new Error(`${this.provider} Key is Required.`);
    const models = await this.openai.models.list();
    return models.data.map((model) => model.id);
  }

  private async chatWithCompletions(options: IChatOptions, onMessage?: IStreamHandler): Promise<IChatResponse> {
    if (!this.openai) {
      throw new Error(`${this.provider} key is not set`);
    }

    const { model, system, temperature } = options;
    const messages = this.toCompletionMessages(options.messages, system);

    if (typeof onMessage === 'function') {
      const stream = await this.openai.chat.completions.create({
        messages,
        model,
        stream: true,
        temperature
      });

      let content = '';
      let reasoningContent = '';
      for await (const chunk of stream) {
        const response = this.mapCompletionChunk(chunk);
        if (!response) {
          continue;
        }
        content += response.content;
        reasoningContent += response.reasoningContent ?? '';
        onMessage(response);
      }
      return {
        content,
        reasoningContent,
        role: 'assistant' as const
      };
    }

    const res = await this.openai.chat.completions.create({
      messages,
      model,
      temperature
    });

    return this.mapCompletionResponse(res);
  }

  private async chatWithResponses(options: IChatOptions, onMessage?: IStreamHandler): Promise<IChatResponse> {
    if (!this.openai) {
      throw new Error(`${this.provider} key is not set`);
    }

    const { model, system, temperature } = options;
    const input = this.toResponseInput(options.messages);

    if (typeof onMessage === 'function') {
      const stream = this.openai.responses.stream({
        model,
        input,
        instructions: system,
        temperature,
        stream: true,
      });

      let content = '';
      let reasoningContent = '';
      for await (const event of stream) {
        if (event.type === 'response.failed' || event.type === 'response.incomplete') {
          this.assertSuccessfulResponse(event.response);
        }

        if (event.type === 'response.output_text.delta') {
          content += event.delta;
          onMessage({ role: 'assistant', content: event.delta });
          continue;
        }

        if (event.type === 'response.reasoning_text.delta') {
          reasoningContent += event.delta;
          continue;
        }
      }

      const finalResponse = await stream.finalResponse();
      this.assertSuccessfulResponse(finalResponse);
      const mapped = this.mapResponseToChatResponse(finalResponse);

      if (!content && mapped.content) {
        onMessage({ role: 'assistant', content: mapped.content });
        content = mapped.content;
      }

      return {
        role: 'assistant' as const,
        content,
        reasoningContent: reasoningContent || mapped.reasoningContent,
        usage: mapped.usage,
      };
    }

    const response = await this.openai.responses.create({
      model,
      input,
      instructions: system,
      temperature,
      stream: false,
    });

    if (!this.isResponseObject(response)) {
      throw new Error(`${this.provider} returned an unexpected streaming response`);
    }

    this.assertSuccessfulResponse(response);

    return this.mapResponseToChatResponse(response);
  }

  private toCompletionMessages(messages: IChatMessage[], system?: string) {
    const transformed = messages.map((msg): ChatCompletionMessageParam => {
      if (msg.role === 'tool') {
        const toolMsg = msg as IChatInputToolMessage;
        return {
          role: 'tool',
          content: toolMsg.content,
          tool_call_id: toolMsg.tool_call_id,
        };
      }

      return {
        role: msg.role,
        content: msg.content,
      };
    });

    if (system) {
      transformed.unshift({
        role: 'system',
        content: system,
      });
    }

    return transformed;
  }

  private toResponseInput(messages: IChatMessage[]): ResponseInputItem[] {
    return messages.map((message): ResponseInputItem => {
      if (message.role === 'tool') {
        const toolMessage = message as IChatInputToolMessage;
        return {
          type: 'function_call_output',
          call_id: toolMessage.tool_call_id,
          output: toolMessage.content,
        };
      }

      return {
        type: 'message',
        role: message.role === 'system' ? 'developer' : message.role,
        content: [
          {
            type: 'input_text',
            text: message.content,
          }
        ],
      };
    });
  }

  private mapCompletionChunk(chunk: ChatCompletionChunk): IChatResponse | null {
    const choice = chunk.choices[0];
    if (!choice) {
      return null;
    }

    return {
      role: 'assistant',
      content: choice.delta?.content ?? '',
      reasoningContent: this.getReasoningContent(choice.delta),
    };
  }

  private mapCompletionResponse(res: ChatCompletion): IChatResponse {
    const message = res.choices[0]?.message;
    return {
      content: message?.content || '',
      reasoningContent: this.getReasoningContent(message),
      role: 'assistant',
      usage: res.usage ? {
        inputTokens: res.usage.prompt_tokens,
        outputTokens: res.usage.completion_tokens,
      } : undefined,
    };
  }

  private mapResponseToChatResponse(response: Response): IChatResponse {
    const content = this.extractResponseText(response);
    const reasoningContent = this.extractReasoningText(response);
    return {
      content,
      reasoningContent,
      role: 'assistant',
      usage: response.usage ? {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      } : undefined,
    };
  }

  private extractResponseText(response: Response): string {
    if (typeof response.output_text === 'string' && response.output_text.length > 0) {
      return response.output_text;
    }

    return response.output
      .flatMap(item => item.type === 'message' ? item.content : [])
      .filter(item => item.type === 'output_text')
      .map(item => item.text)
      .join('');
  }

  private extractReasoningText(response: Response): string {
    return response.output
      .flatMap(item => item.type === 'reasoning' ? item.content ?? [] : [])
      .filter(item => item.type === 'reasoning_text')
      .map(item => item.text)
      .join('') || response.output
      .flatMap(item => item.type === 'reasoning' ? item.summary : [])
      .filter(item => item.type === 'summary_text')
      .map(item => item.text)
      .join('');
  }

  private getReasoningContent(message: unknown): string {
    if (!message || typeof message !== 'object') {
      return '';
    }

    const value = message as { reasoning_content?: unknown };
    return typeof value.reasoning_content === 'string' ? value.reasoning_content : '';
  }

  private isResponseObject(
    value: Awaited<ReturnType<OpenAI['responses']['create']>>
  ): value is Response {
    return typeof value === 'object'
      && value !== null
      && 'output' in value
      && Array.isArray((value as { output?: unknown }).output);
  }

  private assertSuccessfulResponse(response: Response): void {
    const status = response.status;
    if (status === 'failed') {
      throw new Error(`${this.provider} Responses API failed: ${this.getResponseErrorMessage(response)}`);
    }

    if (status === 'incomplete') {
      throw new Error(`${this.provider} Responses API incomplete: ${this.getIncompleteReason(response)}`);
    }

    if (status && !this.isTerminalSuccessStatus(status)) {
      throw new Error(`${this.provider} Responses API did not complete: ${status}`);
    }
  }

  private getResponseErrorMessage(response: Response): string {
    return response.error?.message ?? 'unknown error';
  }

  private getIncompleteReason(response: Response): string {
    return response.incomplete_details?.reason ?? 'unknown reason';
  }

  private isTerminalSuccessStatus(status: ResponseStatus): boolean {
    return status === 'completed';
  }
}
