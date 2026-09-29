import { create } from 'zustand';
import type { JobRequest, JobSnapshot, ToolId } from 'core';
import { getTransport } from '../lib/transport.ts';
import { useSettings } from '../lib/settings.ts';
import { useEngine } from './engine.ts';

interface JobState {
  jobs: JobSnapshot[];
  attached: boolean;
  attach: () => void;
  submit: (job: Omit<JobRequest, 'id' | 'createdAt'>) => Promise<JobSnapshot>;
  cancel: (jobId: string) => Promise<void>;
  clearFinished: () => Promise<void>;
  refresh: () => Promise<void>;
}

const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const RANK: Record<JobSnapshot['progress']['state'], number> = {
  queued: 0,
  running: 1,
  succeeded: 2,
  failed: 2,
  cancelled: 2,
};
/** Orders snapshots so the late `job.submit` reply cannot rewind an already streamed job. */
const rankOf = (job: JobSnapshot): number => RANK[job.progress.state] * 1_000 + job.progress.percent;
const STALE_EVENT_MS = 3_000;
const WATCHDOG_TICK_MS = 1_000;

let watchdog: ReturnType<typeof setInterval> | null = null;
let lastEventAt = 0;

/**
 * Safety net for a silently dead event stream: while a job is non-terminal and
 * no frame has arrived, reconcile the list from `job.list` every few seconds.
 */
function armWatchdog(): void {
  if (watchdog) return;
  watchdog = setInterval(() => {
    const timer = watchdog;
    if (!timer) return;
    const state = useJobs.getState();
    if (!state.jobs.some((job) => !TERMINAL.has(job.progress.state))) {
      clearInterval(timer);
      watchdog = null;
      return;
    }
    if (Date.now() - lastEventAt < STALE_EVENT_MS) return;
    lastEventAt = Date.now();
    void state.refresh();
  }, WATCHDOG_TICK_MS);
}

export const useJobs = create<JobState>((set, get) => ({
  jobs: [],
  attached: false,

  attach: () => {
    if (get().attached) return;
    set({ attached: true });
    getTransport().onEvent((event) => {
      lastEventAt = Date.now();
      if (event.event !== 'job.updated') return;
      const incoming = event.job;
      const previous = get().jobs.find((job) => job.id === incoming.id);
      set((state) => {
        const index = state.jobs.findIndex((job) => job.id === incoming.id);
        if (index === -1) return { jobs: [incoming, ...state.jobs] };
        const next = [...state.jobs];
        next[index] = incoming;
        return { jobs: next };
      });
      armWatchdog();
      if (
        previous &&
        previous.progress.state !== 'succeeded' &&
        incoming.progress.state === 'succeeded' &&
        incoming.artifacts[0]?.path
      ) {
        const settings = useSettings.getState();
        if (settings.autoOpen) {
          void useEngine
            .getState()
            .call('shell.reveal', { path: incoming.artifacts[0].path })
            .catch(() => undefined);
        }
      }
    });
    void get().refresh().then(armWatchdog);
  },

  submit: async (job) => {
    const id = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const request: JobRequest = { ...job, id, createdAt: Date.now() };
    const snapshot = await useEngine.getState().call<JobSnapshot>('job.submit', { job: request });
    set((state) => {
      const local = state.jobs.find((item) => item.id === snapshot.id);
      if (!local) return { jobs: [snapshot, ...state.jobs] };
      if (rankOf(snapshot) <= rankOf(local)) return { jobs: state.jobs };
      return { jobs: state.jobs.map((item) => (item.id === snapshot.id ? snapshot : item)) };
    });
    armWatchdog();
    return snapshot;
  },

  cancel: async (jobId) => {
    await useEngine.getState().call('job.cancel', { jobId });
  },

  clearFinished: async () => {
    const ids = get()
      .jobs.filter((job) => TERMINAL.has(job.progress.state))
      .map((job) => job.id);
    if (!ids.length) return;
    await useEngine.getState().call('job.clear', { jobIds: ids });
    set((state) => ({ jobs: state.jobs.filter((job) => !ids.includes(job.id)) }));
  },

  refresh: async () => {
    try {
      const jobs = await useEngine.getState().call<JobSnapshot[]>('job.list');
      set((state) => {
        const known = new Map(state.jobs.map((job) => [job.id, job]));
        const merged = jobs.map((job) => {
          const local = known.get(job.id);
          // Event frames strip base64 payloads; keep the richer local copy.
          if (local && local.artifacts.some((a) => a.dataBase64) && !job.artifacts.some((a) => a.dataBase64)) {
            return local.progress.state === job.progress.state ? local : { ...job, artifacts: job.artifacts };
          }
          return job;
        });
        return { jobs: merged };
      });
    } catch {
      // engine offline: keep whatever is cached
    }
  },
}));

export function useLatestJobFor(tool: ToolId | undefined): JobSnapshot | undefined {
  return useJobs((state) =>
    state.jobs.find((job) => (tool ? job.tool === tool : true) && job.progress.state !== 'queued'),
  );
}

export function isTerminal(job: JobSnapshot): boolean {
  return TERMINAL.has(job.progress.state);
}
