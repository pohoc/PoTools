interface RegexRequest {
  pattern: string;
  flags: string;
  source: string;
  mode: 'test' | 'replace';
  replacement: string;
}

interface RegexResult {
  ready?: true;
  matches?: Array<{ value: string; index: number; groups: string[] }>;
  text?: string;
  error?: 'syntax' | 'runtime';
}

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<RegexRequest>) => void) | null;
  postMessage(message: RegexResult): void;
};

scope.onmessage = ({ data }) => {
  try {
    const expression = new RegExp(data.pattern, data.mode === 'test' && !data.flags.includes('g') ? `${data.flags}g` : data.flags);
    if (data.mode === 'replace') {
      scope.postMessage({ text: data.source.replace(expression, data.replacement) });
      return;
    }
    const matches: Array<{ value: string; index: number; groups: string[] }> = [];
    for (const match of data.source.matchAll(expression)) {
      matches.push({ value: match[0], index: match.index, groups: match.slice(1) });
      if (matches.length >= 1000) break;
    }
    scope.postMessage({ matches });
  } catch (error) {
    scope.postMessage({ error: error instanceof SyntaxError ? 'syntax' : 'runtime' });
  }
};

scope.postMessage({ ready: true });
