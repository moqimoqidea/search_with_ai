import { IToolCall } from '../../interface.js';

type PendingToolCall = Pick<IToolCall, 'id' | 'name' | 'args'>;

export class StructuredToolCallTracker {
  private readonly pendingByTag = new Map<string, PendingToolCall[]>();

  registerPending(toolCalls: Partial<IToolCall>[], fallbackName: string): IToolCall[] {
    const pendingCalls = toolCalls.map((toolCall, index) => {
      const name = toolCall.name || fallbackName;
      const pendingCall: PendingToolCall = {
        id: toolCall.id || `${name}-${Date.now()}-${index}`,
        name,
        args: toolCall.args ?? {},
      };
      const list = this.pendingByTag.get(name) ?? [];
      list.push(pendingCall);
      this.pendingByTag.set(name, list);
      return {
        ...pendingCall,
        status: 'pending' as const,
        result: '',
      };
    });

    return pendingCalls;
  }

  complete(tag: string, result: string): IToolCall[] {
    const pendingCall = this.shift(tag);
    if (!pendingCall) {
      return [];
    }
    return [{
      ...pendingCall,
      status: 'completed',
      result,
    }];
  }

  error(tag: string, message: string): IToolCall[] {
    const pendingCall = this.shift(tag);
    if (!pendingCall) {
      return [];
    }
    return [{
      ...pendingCall,
      status: 'error',
      result: message,
    }];
  }

  interruptPending(): IToolCall[] {
    const interruptedCalls: IToolCall[] = [];
    for (const [tag, calls] of this.pendingByTag.entries()) {
      for (const pendingCall of calls) {
        interruptedCalls.push({
          ...pendingCall,
          status: 'interrupted',
          result: '',
        });
      }
      this.pendingByTag.delete(tag);
    }
    return interruptedCalls;
  }

  private shift(tag: string): PendingToolCall | undefined {
    const list = this.pendingByTag.get(tag);
    if (!list || list.length === 0) {
      return undefined;
    }
    const pendingCall = list.shift();
    if (!list.length) {
      this.pendingByTag.delete(tag);
    } else {
      this.pendingByTag.set(tag, list);
    }
    return pendingCall;
  }
}
