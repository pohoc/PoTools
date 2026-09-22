import { useCallback, useEffect, useState } from 'react';
import type { FieldValue, ProbedPdf, TextRunResult, ToolDescriptor } from 'core';
import { defaultOptions } from 'core';
import { useEngine, rpcErrorMessage } from '../stores/engine.ts';
import { useJobs } from '../stores/jobs.ts';
import { releasePickedFileBytes, toFileRef, type PickedFile } from '../lib/files.ts';
import { useSettings } from '../lib/settings.ts';

function initialOptions(descriptor: ToolDescriptor): Record<string, FieldValue> {
  const options = defaultOptions(descriptor.id);
  let localZone: string | undefined;
  try {
    localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    localZone = undefined;
  }
  if (localZone) {
    for (const field of descriptor.fields) {
      if (field.type === 'timezone') options[field.key] = localZone;
    }
  }
  return options;
}

export interface ToolDraft {
  files: PickedFile[];
  probes: Record<string, ProbedPdf>;
  options: Record<string, FieldValue>;
  setOptions: (next: Record<string, FieldValue>) => void;
  setOption: (key: string, value: FieldValue) => void;
  resetOptions: () => void;
  addFiles: (incoming: PickedFile[]) => void;
  removeFile: (id: string) => void;
  reorder: (from: number, to: number) => void;
  clear: () => void;
  run: (overrides?: Record<string, FieldValue>) => Promise<void>;
  runPrepared: (file: File, overrides?: Record<string, FieldValue>) => Promise<void>;
  running: boolean;
  error: string | null;
  errorCode: string | null;
  textResult: TextRunResult | null;
  jobId: string | null;
  probing: boolean;
}

export function useToolDraft(descriptor: ToolDescriptor): ToolDraft {
  const call = useEngine((state) => state.call);
  const submit = useJobs((state) => state.submit);
  const namePattern = useSettings((state) => state.namePattern);
  const locale = useSettings((state) => state.locale);
  const fontPath = useSettings((state) => state.fontPath);
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [probes, setProbes] = useState<Record<string, ProbedPdf>>({});
  const [options, setOptions] = useState<Record<string, FieldValue>>(() => initialOptions(descriptor));
  const [running, setRunning] = useState(false);
  const [probing, setProbing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [textResult, setTextResult] = useState<TextRunResult | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const textTool = descriptor.layout === 'text';

  useEffect(() => {
    setFiles([]);
    setProbes({});
    setOptions(initialOptions(descriptor));
    setError(null);
    setErrorCode(null);
    setTextResult(null);
    setJobId(null);
  }, [descriptor.id]);

  const probe = useCallback(
    async (incoming: PickedFile[]) => {
      // Only PDF-accepting tools have page metadata to show.
      if (!descriptor.accept.startsWith('application/pdf')) return;
      setProbing(true);
      for (const picked of incoming) {
        try {
          const ref = await toFileRef(picked);
          const probed = await call<ProbedPdf>('file.probe', { file: ref });
          setProbes((prev) => ({ ...prev, [picked.id]: probed }));
        } catch (issue) {
          const info = rpcErrorMessage(issue);
          setError(info.hintKey ? info.hintKey : info.message);
        }
      }
      setProbing(false);
    },
    [call, descriptor.accept],
  );

  const addFiles = useCallback(
    (incoming: PickedFile[]) => {
      if (!incoming.length) return;
      setError(null);
      setFiles((prev) => {
        const known = new Set(prev.map((file) => `${file.path ?? ''}|${file.name}|${file.size}`));
        const fresh = incoming.filter((file) => !known.has(`${file.path ?? ''}|${file.name}|${file.size}`));
        if (!fresh.length) return prev;
        void probe(fresh);
        return descriptor.multiFile ? [...prev, ...fresh] : fresh.slice(0, 1);
      });
    },
    [descriptor.multiFile, probe],
  );

  const submitFiles = useCallback(
    async (inputFiles: PickedFile[], overrides?: Record<string, FieldValue>) => {
      const fileless = descriptor.requiresInput === false;
      if (!inputFiles.length && !fileless) return;
      setRunning(true);
      setError(null);
      setErrorCode(null);
      try {
        const refs = await Promise.all(inputFiles.map(toFileRef));
        for (const file of inputFiles) if (!file.path) releasePickedFileBytes(file);
        const snapshot = await submit({
          tool: descriptor.id,
          files: refs,
          options: { ...options, ...overrides },
          namePattern,
          label: descriptor.nameKey,
        });
        setJobId(snapshot.id);
      } catch (issue) {
        const info = rpcErrorMessage(issue);
        setError(info.hintKey ?? info.message);
        setErrorCode(info.code);
      } finally {
        setRunning(false);
      }
    },
    [descriptor.id, descriptor.nameKey, descriptor.requiresInput, namePattern, options, submit],
  );

  const runInMemory = useCallback(
    async (overrides?: Record<string, FieldValue>) => {
      setRunning(true);
      setError(null);
      setErrorCode(null);
      setTextResult(null);
      try {
        const result = await call<TextRunResult>('tool.run', {
          tool: descriptor.id,
          options: { ...options, ...overrides },
          globals: { locale, fontPath },
        });
        setTextResult(result);
      } catch (issue) {
        const info = rpcErrorMessage(issue);
        setError(info.hintKey ?? info.message);
        setErrorCode(info.code);
      } finally {
        setRunning(false);
      }
    },
    [call, descriptor.id, fontPath, locale, options],
  );

  const run = useCallback(
    (overrides?: Record<string, FieldValue>) => (textTool ? runInMemory(overrides) : submitFiles(files, overrides)),
    [files, runInMemory, submitFiles, textTool],
  );
  const runPrepared = useCallback((file: File, overrides?: Record<string, FieldValue>) => submitFiles([{
    id: `prepared-${Date.now().toString(36)}`,
    name: file.name,
    size: file.size,
    path: null,
    file,
  }], overrides), [submitFiles]);

  return {
    files,
    probes,
    options,
    setOptions,
    setOption: (key, value) => setOptions((prev) => ({ ...prev, [key]: value })),
    resetOptions: () => setOptions(initialOptions(descriptor)),
    addFiles,
    removeFile: (id) => {
      const removed = files.find((file) => file.id === id);
      if (removed) releasePickedFileBytes(removed);
      setFiles((prev) => prev.filter((file) => file.id !== id));
      setProbes((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    },
    reorder: (from, to) =>
      setFiles((prev) => {
        if (to < 0 || to >= prev.length) return prev;
        const next = [...prev];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved as PickedFile);
        return next;
      }),
    clear: () => {
      for (const file of files) releasePickedFileBytes(file);
      setFiles([]);
      setProbes({});
      setJobId(null);
    },
    run,
    runPrepared,
    running,
    error,
    errorCode,
    textResult,
    jobId,
    probing,
  };
}
