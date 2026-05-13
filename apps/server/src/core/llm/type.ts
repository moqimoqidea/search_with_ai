import OpenAI from 'openai';
import { IChatMessage, OpenAIAPIMode } from '../../interface.js';

export interface IChatOptions {
  messages: IChatMessage[];
  model: string;
  system?: string;
  temperature?: number;
}

export interface IProviderClientOptions {
  apiMode?: OpenAIAPIMode;
  client?: OpenAI;
}
