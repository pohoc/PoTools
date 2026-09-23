import { useMemo, useState } from 'react';
import { Button, Card, Checkbox, Icon, Input as HeroInput, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@potools/ui';
import type { InvoiceArchiveResult, InvoiceScanEntry, InvoiceScanResult, InvoiceUndoResult } from 'core';
import { useI18n } from '../i18n/index.tsx';
import { isTauri, nativePickDirectory } from '../lib/tauri.ts';
import { useEngine } from '../stores/engine.ts';

type EditableField = keyof InvoiceScanEntry['fields'];

const FIELD_KEYS: Array<[EditableField, string]> = [
  ['date', 'invoice.date'], ['seller', 'invoice.seller'], ['buyer', 'invoice.buyer'],
  ['invoiceNo', 'invoice.number'], ['amount', 'invoice.amount'], ['type', 'invoice.type'],
];

export function InvoiceOrganizerPage() {
  const { t } = useI18n();
  const call = useEngine((state) => state.call);
  const [sourceDirectory, setSourceDirectory] = useState('');
  const [targetDirectory, setTargetDirectory] = useState('');
  const [recursive, setRecursive] = useState(true);
  const [scan, setScan] = useState<InvoiceScanResult | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [directoryTemplate, setDirectoryTemplate] = useState('{year}/{month}/{seller}');
  const [fileTemplate, setFileTemplate] = useState('{date}_{seller}_{invoiceNo}_{amount}_{originalName}');
  const [conflict, setConflict] = useState<'rename' | 'skip'>('rename');
  const [busy, setBusy] = useState<'scan' | 'archive' | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<InvoiceArchiveResult | null>(null);
  const [undoResult, setUndoResult] = useState<InvoiceUndoResult | null>(null);

  const targetPaths = useMemo(() => Object.fromEntries((scan?.files ?? []).map((entry) => [
    entry.path,
    `${renderTemplate(directoryTemplate, entry, t)}/${renderTemplate(fileTemplate, entry, t)}${extensionOf(entry.name)}`.replace(/^\/+|\/+$/g, ''),
  ])), [directoryTemplate, fileTemplate, scan, t]);

  const pickDirectory = async (which: 'source' | 'target') => {
    const value = await nativePickDirectory();
    if (!value) return;
    if (which === 'source') {
      setSourceDirectory(value);
      setScan(null);
      setResult(null);
    } else {
      setTargetDirectory(value);
      setScan(null);
      setResult(null);
    }
  };

  const runScan = async () => {
    setBusy('scan');
    setError('');
    setResult(null);
    try {
      const value = await call<InvoiceScanResult>('invoice.scan', {
        directory: sourceDirectory,
        recursive,
        excludeDirectory: targetDirectory || undefined,
      });
      setScan(value);
      setSelected(Object.fromEntries(value.files.map((entry) => [entry.path, entry.recognition !== 'failed'])));
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : String(issue));
    } finally {
      setBusy(null);
    }
  };

  const updateField = (path: string, field: EditableField, value: string) => {
    setScan((current) => current ? {
      ...current,
      files: current.files.map((entry) => entry.path === path ? { ...entry, fields: { ...entry.fields, [field]: value } } : entry),
    } : current);
  };

  const archive = async () => {
    if (!scan || !targetDirectory) return;
    setBusy('archive');
    setError('');
    try {
      const files = scan.files.map((entry) => ({
        path: entry.path,
        sha256: entry.sha256,
        enabled: selected[entry.path] !== false,
        relativePath: targetPaths[entry.path] ?? entry.name,
        fields: entry.fields,
      }));
      const value = await call<InvoiceArchiveResult>('invoice.archive', {
        sourceDirectory: scan.sourceDirectory,
        targetDirectory,
        conflict,
        files,
      });
      setResult(value);
      setUndoResult(null);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : String(issue));
    } finally {
      setBusy(null);
    }
  };

  const undo = async () => {
    if (!result || !targetDirectory) return;
    setBusy('archive');
    setError('');
    try {
      const value = await call<InvoiceUndoResult>('invoice.undo', { archiveId: result.archiveId });
      setUndoResult(value);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : String(issue));
    } finally {
      setBusy(null);
    }
  };

  const selectedCount = scan?.files.filter((entry) => selected[entry.path] !== false).length ?? 0;

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4">
      <header>
        <h2 className="text-[16px] font-semibold tracking-tight">{t('tool.invoiceOrganize.name')}</h2>
        <p className="mt-1 text-[12.5px] leading-5 text-muted">{t('tool.invoiceOrganize.desc')}</p>
      </header>

      {!isTauri() ? (
        <Card className="flex items-start gap-3 border-warn/40 bg-warn/5 p-4 text-[12px] leading-5 text-ink">
          <Icon name="warning" size={16} className="mt-0.5 shrink-0 text-warn" />{t('invoice.desktopOnly')}
        </Card>
      ) : null}
      <Card className="flex items-start gap-3 border-warn/40 bg-warn/5 p-4 text-[12px] leading-5 text-ink">
        <Icon name="warning" size={16} className="mt-0.5 shrink-0 text-warn" />{t('invoice.ocrNotice')}
      </Card>

      <Card className="grid gap-4 p-4 lg:grid-cols-2">
        <DirectoryField label={t('invoice.source')} value={sourceDirectory} placeholder={t('invoice.chooseSource')} onPick={() => void pickDirectory('source')} disabled={!isTauri() || busy !== null} />
        <DirectoryField label={t('invoice.target')} value={targetDirectory} placeholder={t('invoice.chooseTarget')} onPick={() => void pickDirectory('target')} disabled={!isTauri() || busy !== null} />
        <label className="inline-flex items-center gap-2 text-[12px] lg:col-span-2"><Checkbox checked={recursive} onChange={(event) => setRecursive(event.target.checked)} />{t('invoice.recursive')}</label>
        <div className="flex items-center justify-between gap-3 border-t border-line pt-3 lg:col-span-2">
          <p className="text-[11px] leading-5 text-faint">{t('invoice.scanLimits')}</p>
          <Button disabled={!isTauri() || !sourceDirectory || busy !== null} onClick={() => void runScan()}>
            <Icon name="scan" size={14} />{busy === 'scan' ? t('invoice.scanning') : t('invoice.scan')}
          </Button>
        </div>
      </Card>

      {scan ? (
        <>
          <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="text-[12px] text-muted">{t('invoice.scanCount').replace('{count}', String(scan.files.length))}{scan.skipped.length ? ` · ${t('invoice.skippedCount').replace('{count}', String(scan.skipped.length))}` : ''}</div>
            <label className="flex items-center gap-2 text-[11.5px] text-muted">
              <span>{t('invoice.conflict')}</span>
              <Select value={conflict} onValueChange={(value) => setConflict(value as 'rename' | 'skip')}>
                <SelectTrigger className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="rename">{t('invoice.conflictRename')}</SelectItem>
                  <SelectItem value="skip">{t('invoice.conflictSkip')}</SelectItem>
                </SelectContent>
              </Select>
            </label>
          </Card>
          <Card className="grid gap-3 p-4 md:grid-cols-2">
            <TemplateField label={t('invoice.folderRule')} value={directoryTemplate} onChange={setDirectoryTemplate} />
            <TemplateField label={t('invoice.fileRule')} value={fileTemplate} onChange={setFileTemplate} />
            <p className="text-[10.5px] text-faint md:col-span-2">{t('invoice.templateVars')}</p>
          </Card>
          {scan.warnings.map((warning) => <p key={warning} className="text-[11px] leading-5 text-warn">{t(`invoice.warning.${warning}`)}</p>)}
          <div className="flex flex-col gap-3">
            {scan.files.map((entry) => (
              <InvoiceCard
                key={entry.path}
                entry={entry}
                targetPath={targetPaths[entry.path] ?? entry.name}
                checked={selected[entry.path] !== false}
                onCheck={(checked) => setSelected((current) => ({ ...current, [entry.path]: checked }))}
                onFieldChange={(field, value) => updateField(entry.path, field, value)}
              />
            ))}
            {!scan.files.length ? <p className="py-6 text-center text-[12px] text-faint">{t('invoice.empty')}</p> : null}
          </div>
          <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t border-line bg-canvas/95 py-3 backdrop-blur">
            <p className="text-[11px] text-muted">{t('invoice.confirmHint').replace('{count}', String(selectedCount))}</p>
            <Button disabled={!isTauri() || !targetDirectory || !selectedCount || busy !== null} onClick={() => void archive()}>
              <Icon name="file-text" size={14} />{busy === 'archive' ? t('invoice.archiving') : t('invoice.archive')}
            </Button>
          </div>
        </>
      ) : null}

      {error ? <p role="alert" className="rounded-control bg-bad/10 px-3 py-2 text-[12px] leading-5 text-bad">{error}</p> : null}
      {result ? (
        <Card className="flex flex-col gap-1 p-4 text-[12px] leading-5 text-ink">
          <strong>{t('invoice.done').replace('{count}', String(result.copied.length))}</strong>
          {result.reportPath ? <span>{t('invoice.report')}: {result.reportPath}</span> : null}
          {result.csvReportPath ? <span>{t('invoice.csvReport')}: {result.csvReportPath}</span> : null}
          {result.warnings.map((warning) => <span key={warning} className="text-warn">{t(`invoice.warning.${warning}`)}</span>)}
          {result.skipped.length ? <span>{t('invoice.skippedCount').replace('{count}', String(result.skipped.length))}</span> : null}
          {result.failed.length ? <span className="text-bad">{t('invoice.failedCount').replace('{count}', String(result.failed.length))}</span> : null}
          {undoResult ? <span>{t('invoice.undoResult').replace('{removed}', String(undoResult.removed.length)).replace('{skipped}', String(undoResult.skipped.length))}</span> : null}
          {!undoResult && result.copied.length ? <div className="mt-2"><Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void undo()}>{t('invoice.undo')}</Button></div> : null}
        </Card>
      ) : null}
    </div>
  );
}

function DirectoryField({ label, value, placeholder, onPick, disabled }: { label: string; value: string; placeholder: string; onPick: () => void; disabled: boolean }) {
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-[11px] font-medium text-muted">{label}</p>
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate rounded-control border border-line bg-canvas px-3 py-2 text-[11.5px] text-ink" title={value}>{value || placeholder}</span>
        <Button variant="outline" size="sm" disabled={disabled} onClick={onPick}><Icon name="folder" size={14} />{label}</Button>
      </div>
    </div>
  );
}

function TemplateField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <HeroInput type="text" aria-label={label} className="min-w-0" value={value as unknown as number} onChange={(event) => onChange(String(event.target.value))} />;
}

function InvoiceCard({ entry, targetPath, checked, onCheck, onFieldChange }: { entry: InvoiceScanEntry; targetPath: string; checked: boolean; onCheck: (checked: boolean) => void; onFieldChange: (field: EditableField, value: string) => void }) {
  const { t } = useI18n();
  return (
    <Card className="p-4">
      <div className="flex min-w-0 items-start gap-3">
        <Checkbox checked={checked} onChange={(event) => onCheck(event.target.checked)} aria-label={t('invoice.include')} className="mt-0.5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <strong className="max-w-full truncate text-[12px] text-ink" title={entry.relativePath}>{entry.relativePath}</strong>
            <span className={`rounded px-1.5 py-0.5 text-[10px] ${entry.recognition === 'native-text' ? 'bg-ok/10 text-ok' : entry.recognition === 'failed' ? 'bg-bad/10 text-bad' : 'bg-warn/10 text-warn'}`}>{t(`invoice.status.${entry.recognition}`)}</span>
            <span className="text-[10px] text-faint">{formatBytes(entry.sizeBytes)}{entry.pageCount ? ` · ${t('invoice.pages').replace('{count}', String(entry.pageCount))}` : ''}</span>
          </div>
          {entry.error ? <p className="mt-1 text-[10.5px] text-bad">{entry.error}</p> : null}
          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {FIELD_KEYS.map(([field, labelKey]) => <HeroInput key={field} type="text" aria-label={t(labelKey)} className="min-w-0" value={entry.fields[field] as unknown as number} onChange={(event) => onFieldChange(field, String(event.target.value))} />)}
          </div>
          <p className="mt-3 break-all rounded bg-canvas px-2 py-1.5 text-[10px] leading-4 text-muted">{targetPath}</p>
          {entry.extractedText ? <details className="mt-2"><summary className="cursor-pointer text-[10.5px] text-accent">{t('invoice.nativeText')}</summary><pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-canvas p-2 text-[10px] leading-4 text-muted">{entry.extractedText.slice(0, 6000)}</pre></details> : null}
        </div>
      </div>
    </Card>
  );
}

function renderTemplate(template: string, entry: InvoiceScanEntry, t: (key: string) => string): string {
  const date = entry.fields.date.replace(/[年月]/g, '-').replace(/日/g, '').replace(/[./]/g, '-');
  const [year = '', month = ''] = date.split('-');
  const values: Record<string, string> = {
    year: year || t('invoice.placeholder.year'), month: month.padStart(2, '0') || t('invoice.placeholder.month'), date: safePart(entry.fields.date || t('invoice.placeholder.date')),
    seller: safePart(entry.fields.seller || t('invoice.placeholder.seller')), buyer: safePart(entry.fields.buyer || t('invoice.placeholder.buyer')),
    invoiceNo: safePart(entry.fields.invoiceNo || t('invoice.placeholder.invoiceNo')), amount: safePart(entry.fields.amount || t('invoice.placeholder.amount')),
    type: safePart(entry.fields.type || t('invoice.placeholder.type')), originalName: safePart(entry.name.replace(/\.[^.]+$/, '')),
    ext: extensionOf(entry.name).replace(/^\./, ''),
  };
  return template
    .replace(/\\/g, '/')
    .replace(/\{([A-Za-z]+)\}/g, (_match, key: string) => values[key] ?? '')
    .split('/')
    .filter(Boolean)
    .map((segment) => safePart(segment.replace(/[<>:"|?*\x00-\x1f]/g, '_')))
    .join('/');
}

function safePart(value: string): string {
  return value.replace(/[\\/<>:"|?*\x00-\x1f]/g, '_').replace(/\.\.+/g, '.').replace(/[ .]+$/g, '').trim().slice(0, 120) || '_';
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
