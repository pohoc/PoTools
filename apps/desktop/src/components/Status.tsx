import type { CSSProperties } from 'react';

type StatusProps = {
  color: string;
  active?: boolean;
  label?: string;
};

export function Status({ color, active = false, label = '状态' }: StatusProps) {
  const style = { '--status-dot-color': color } as CSSProperties;

  return (
    <span className={`status-dot${active ? ' status-dot-active' : ''}`} style={style} role="status" aria-label={label} />
  );
}
