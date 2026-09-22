import { useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Upload } from 'lucide-react';
import { cn } from '../../utils';

export function FileUpload({ accept, multiple = false, disabled, onFiles, children, className }: { accept?: string; multiple?: boolean; disabled?: boolean; onFiles: (files: File[]) => void; children?: ReactNode; className?: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const readFiles = (files: FileList | null) => { if (files?.length) onFiles(Array.from(files)); };
  const onDrop = (event: DragEvent<HTMLDivElement>) => { event.preventDefault(); setDragging(false); if (!disabled) readFiles(event.dataTransfer.files); };
  return <div role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} onClick={() => !disabled && inputRef.current?.click()} onKeyDown={(event) => { if (!disabled && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); inputRef.current?.click(); } }} onDragOver={(event) => { event.preventDefault(); if (!disabled) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop} className={cn('flex min-h-24 cursor-pointer flex-col items-center justify-center gap-2 rounded-card border border-dashed border-line bg-surface px-4 py-5 text-center text-muted outline-none transition hover:border-accent hover:bg-raised/40 focus-visible:ring-2 focus-visible:ring-accent/30', dragging && 'border-accent bg-accent-soft', disabled && 'cursor-not-allowed opacity-50', className)}>
    <input ref={inputRef} type="file" accept={accept} multiple={multiple} disabled={disabled} className="sr-only" onChange={(event) => { readFiles(event.target.files); event.currentTarget.value = ''; }} />
    {children ?? <><Upload size={18} className="text-faint" /><span className="text-[12px]">Choose files or drop them here</span></>}
  </div>;
}
