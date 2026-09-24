import { EngineError } from '../errors.ts';
import { localeOf, makeMsg } from '../lib/messages.ts';
import type { ToolContext, ToolImpl } from '../types.ts';
import { emitText, optStr } from './time-core.ts';

interface RegexWorkerResult {
  ready?: true;
  matches?: Array<{ value: string; index: number; groups: string[] }>;
  text?: string;
  error?: 'syntax' | 'runtime';
}

interface RegexWorker {
  postMessage(message: unknown): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<RegexWorkerResult>) => void) | null;
  onerror: (() => void) | null;
}

function runIsolatedRegex(input: {
  pattern: string;
  flags: string;
  source: string;
  mode: 'test' | 'replace';
  replacement: string;
}): Promise<RegexWorkerResult> {
  if (typeof Worker === 'undefined') return Promise.reject(new Error('worker-unavailable'));
  const worker = new Worker(new URL('./regex-runner.worker.ts', import.meta.url), { type: 'module' }) as unknown as RegexWorker;
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    worker.onmessage = ({ data }) => {
      if (data.ready) {
        timeout = setTimeout(() => {
          worker.terminate();
          reject(new Error('regex-timeout'));
        }, 150);
        worker.postMessage(input);
        return;
      }
      if (timeout) clearTimeout(timeout);
      worker.terminate();
      resolve(data);
    };
    worker.onerror = () => {
      if (timeout) clearTimeout(timeout);
      worker.terminate();
      reject(new Error('regex-runtime'));
    };
  });
}

export const embeddedRegexTool: ToolImpl = {
  id: 'regex-test',
  async run(ctx: ToolContext) {
    const msg = makeMsg(localeOf(ctx));
    const pattern = optStr(ctx, 'pattern');
    const source = optStr(ctx, 'input');
    const flags = optStr(ctx, 'flags');
    const mode = optStr(ctx, 'mode') === 'replace' ? 'replace' : 'test';
    if (!source.trim()) throw new EngineError('bad_request', msg('dev.error.empty'));
    if (!pattern) throw new EngineError('bad_request', msg('dev.error.regex'));
    if (source.length > 1_000_000) throw new EngineError('bad_request', msg('dev.error.tooLarge'));

    let result: RegexWorkerResult;
    try {
      result = await runIsolatedRegex({ pattern, flags, source, mode, replacement: optStr(ctx, 'replacement') });
    } catch (error) {
      const failure = (error as Error).message;
      if (failure === 'regex-timeout') throw new EngineError('bad_request', msg('dev.error.regexTimeout'));
      if (failure === 'worker-unavailable') throw new EngineError('unsupported', msg('dev.error.regex'));
      throw new EngineError('bad_request', msg('dev.error.regex'));
    }
    if (result.error) throw new EngineError('bad_request', msg('dev.error.regex'));

    const matches = result.matches ?? [];
    const text = mode === 'replace'
      ? result.text ?? ''
      : matches.length
        ? matches.map((match, index) => `${index + 1}. ${JSON.stringify(match.value)} @ ${match.index}${match.groups.length ? `  (${match.groups.map((group) => JSON.stringify(group)).join(', ')})` : ''}`).join('\n')
        : msg('dev.regex.noMatches');
    await emitText(ctx, 'regex-result.txt', text);
    return { extra: { mode, matches: matches.length } };
  },
};
