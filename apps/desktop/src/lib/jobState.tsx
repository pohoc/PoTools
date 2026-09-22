import { Icon } from '@potools/ui';
import type { BadgeTone, ProgressTone } from '@potools/ui';
import type { ReactNode } from 'react';
import type { JobState } from 'core';

/**
 * Maps the engine's job states onto the UI package's semantic tones, keeping
 * business vocabulary out of the shared components. Labels come from i18n
 * (`job.queued`, `job.running`, …).
 */
export function jobBadgeTone(state: JobState): BadgeTone {
  if (state === 'running') return 'accent';
  if (state === 'succeeded') return 'ok';
  if (state === 'failed') return 'bad';
  return 'muted';
}

export function jobProgress(state: JobState): { tone: ProgressTone; striped: boolean } {
  if (state === 'failed') return { tone: 'bad', striped: false };
  if (state === 'cancelled') return { tone: 'idle', striped: false };
  if (state === 'succeeded') return { tone: 'ok', striped: false };
  return { tone: 'accent', striped: state === 'running' };
}

export function jobStateIcon(state: JobState): ReactNode {
  if (state === 'running') return <Icon name="spinner" size={11} className="animate-spin" />;
  if (state === 'succeeded') return <Icon name="check" size={11} />;
  if (state === 'failed') return <Icon name="warning" size={11} />;
  return null;
}

export function jobStateLabelKey(state: JobState): string {
  return `job.${state}`;
}
