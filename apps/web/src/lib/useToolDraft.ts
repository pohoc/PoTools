import { useCallback, useEffect, useRef, useState } from 'react';
import type { FieldValue, ProbedPdf, TextRunResult, ToolDescriptor } from 'core';
import { defaultOptions } from './core-bindings.ts';
import { areOptionsValid } from '../components/OptionForm.tsx';
import { useEngine, rpcErrorMessage } from '../stores/engine.ts';
import { useJobs } from '../stores/jobs.ts';
import { releasePickedFileBytes, toFileRef, type PickedFile } from '../lib/files.ts';
import { useSettings } from '../lib/settings.ts';

/** Stable identity used to de-duplicate picked files. */
function fileIdentity(file: PickedFile): string {
  return `${file.path ?? ''}|${file.name}|${file.size}`;
}

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
  run: (overrides?: Record<string, FieldValue>, outputDir?: string) => Promise<void>;
  runPrepared: (file: File, overrides?: Record<string, FieldValue>, outputDir?: string) => Promise<void>;
  /** Silent re-run for time-sensitive outputs; never toggles the running state. */
  refresh: () => void;
  /** Per-run output folder override; null follows the settings-resolved destination. */
  outputOverride: string | null;
  setOutputOverride: (dir: string | null) => void;
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
  // Per-run destination: set from the run panel's 保存位置 picker, wins over the
  // settings-resolved folder for this tool page only (state dies with remount).
  const [outputOverride, setOutputOverride] = useState<string | null>(null);
  const textTool = descriptor.layout === 'text';

  // Per-tool freshness comes from the call site rendering the workspace with
  // `key={descriptor.id}`, which remounts this hook and re-runs every `useState`
  // initialiser. An effect that reset the same state was therefore dead code
  // (and could not be made dependency-correct anyway, since it read the whole
  // descriptor). `files` is mirrored into a ref so `addFiles` below stays
  // referentially stable for the window paste listener.
  const filesRef = useRef(files);
  useEffect(() => {
    filesRef.current = files;
  }, [files]);

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
      // De-duplicate outside the state updater: React double-invokes updaters
      // under StrictMode (and may call them during a render that is later
      // discarded), so starting the probe inside one issued two `file.probe`
      // round trips per added file.
      const known = new Set(filesRef.current.map(fileIdentity));
      const fresh = incoming.filter((file) => !known.has(fileIdentity(file)));
      if (!fresh.length) return;
      // The updater itself stays pure; `prev` is still consulted so a second
      // batch in the same tick cannot re-add what the first one already did.
      setFiles((prev) => {
        const unseen = fresh.filter((file) => !prev.some((existing) => fileIdentity(existing) === fileIdentity(file)));
        if (!unseen.length) return prev;
        return descriptor.multiFile ? [...prev, ...unseen] : unseen.slice(0, 1);
      });
      void probe(fresh);
    },
    [descriptor.multiFile, probe],
  );

  const submitFiles = useCallback(
    async (inputFiles: PickedFile[], overrides?: Record<string, FieldValue>, outputDir?: string) => {
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
          // A per-run destination rides on the request itself; applyJobDefaults
          // lets an explicitly set job.output.dir win over the settings chain.
          ...(outputDir ? { output: { dir: outputDir } } : {}),
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
    async (overrides?: Record<string, FieldValue>, quiet = false) => {
      if (quiet) {
        // Background refresh for time-sensitive outputs (rolling TOTP codes):
        // never flashes the running state and keeps the last good result when
        // a refresh transiently fails.
        try {
          const result = await call<TextRunResult>('tool.run', {
            tool: descriptor.id,
            options: { ...options, ...overrides },
            globals: { locale, fontPath },
          });
          setTextResult(result);
        } catch {
          /* keep the previous result */
        }
        return;
      }
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

  // Live tools (`interaction: "live"`) re-run as the draft changes instead of
  // waiting for the run button. Edits are debounced; runs are chained so a
  // burst of keystrokes cannot interleave replies and let an older result
  // overwrite a newer one. With no text-ish content there is nothing to
  // compute: the stale result is dropped and no RPC is issued.
  const live = descriptor.interaction === 'live';
  const engineStatus = useEngine((state) => state.status);
  const runChainRef = useRef<Promise<void>>(Promise.resolve());
  const runInMemoryRef = useRef(runInMemory);
  useEffect(() => {
    runInMemoryRef.current = runInMemory;
  }, [runInMemory]);
  useEffect(() => {
    if (!live || engineStatus !== 'ready') return;
    // Structurally invalid options (missing required secret, out-of-range
    // number) suppress the auto-run; the form itself shows the field errors.
    if (!areOptionsValid(descriptor.fields, options)) return;
    // Fileless generators (password-gen, uuid-gen, totp) produce output from
    // options alone, so they run as soon as their defaults validate instead of
    // waiting for content.
    const fileless = descriptor.requiresInput === false;
    const hasContent = descriptor.fields.some((field) => {
      if (field.type !== 'textarea' && field.type !== 'text' && field.type !== 'dateTime' && field.type !== 'password') return false;
      return String(options[field.key] ?? '').trim() !== '';
    });
    if (!fileless && !hasContent) {
      setTextResult(null);
      return;
    }
    const timer = window.setTimeout(() => {
      runChainRef.current = runChainRef.current.then(() => runInMemoryRef.current());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [live, engineStatus, descriptor.fields, descriptor.requiresInput, options]);

  const run = useCallback(
    (overrides?: Record<string, FieldValue>, outputDir?: string) =>
      (textTool ? runInMemory(overrides) : submitFiles(files, overrides, outputDir)),
    [files, runInMemory, submitFiles, textTool],
  );
  const refresh = useCallback(() => {
    runChainRef.current = runChainRef.current.then(() => runInMemoryRef.current(undefined, true));
  }, []);
  const runPrepared = useCallback((file: File, overrides?: Record<string, FieldValue>, outputDir?: string) => submitFiles([{
    id: `prepared-${Date.now().toString(36)}`,
    name: file.name,
    size: file.size,
    path: null,
    file,
  }], overrides, outputDir), [submitFiles]);

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
    refresh,
    outputOverride,
    setOutputOverride,
    running,
    error,
    errorCode,
    textResult,
    jobId,
    probing,
  };
}
