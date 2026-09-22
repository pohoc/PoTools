import { useId, useState } from 'react';
import { Icon, Input as HeroInput, Textarea as HeroTextarea } from '@potools/ui';
import type { FieldValue, ToolField } from 'core';
import { isValidPageRanges } from 'core';
import { Button, Toggle } from '@potools/ui';
import { CONTROL_CLASS } from '@potools/ui';
import { Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Popover, PopoverContent, PopoverTrigger, Slider, Collapsible, CollapsibleContent, CollapsibleTrigger } from '@potools/ui';
import { useI18n } from '../i18n/index.tsx';
import { cn } from '@potools/ui';

type Values = Record<string, FieldValue>;

function isVisible(field: ToolField, values: Record<string, FieldValue>): boolean {
  if (!field.showIf) return true;
  return field.showIf.in.includes(values[field.showIf.field] ?? '');
}

const ALL_RANGES = new Set(['all', '*', '全部', '所有']);
const MILLIMETERS_PER_POINT = 25.4 / 72;

function toDisplayNumber(field: Extract<ToolField, { type: 'number' | 'slider' }>, value: number): number {
  return field.displayUnit === 'mm' ? Number((value * MILLIMETERS_PER_POINT).toFixed(1)) : value;
}

function fromDisplayNumber(field: Extract<ToolField, { type: 'number' | 'slider' }>, value: number): number {
  return field.displayUnit === 'mm' ? Number((value / MILLIMETERS_PER_POINT).toFixed(2)) : value;
}

function positionMarkerClass(value: string): string {
  const [vertical, horizontal] = value.split('-');
  const alignY = vertical === 'top' ? 'items-start' : vertical === 'bottom' ? 'items-end' : 'items-center';
  const alignX = horizontal === 'left' ? 'justify-start' : horizontal === 'right' ? 'justify-end' : 'justify-center';
  return cn('relative flex h-5 w-6', alignY, alignX);
}

let supportedZones: string[] | null | undefined;

const COMMON_ZONES = [
  'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Singapore', 'Asia/Hong_Kong',
  'Asia/Taipei', 'Asia/Kolkata', 'Asia/Dubai', 'Europe/London', 'Europe/Paris',
  'Europe/Berlin', 'Europe/Moscow', 'America/New_York', 'America/Los_Angeles',
  'America/Chicago', 'America/Toronto', 'America/Sao_Paulo', 'Australia/Sydney',
  'Pacific/Auckland', 'UTC',
];

const ZONE_LABELS: Record<string, string> = {
  'Asia/Shanghai': '中国标准时间 · 上海', 'Asia/Hong_Kong': '中国香港', 'Asia/Taipei': '中国台湾 · 台北',
  'Asia/Tokyo': '日本 · 东京', 'Asia/Seoul': '韩国 · 首尔', 'Asia/Singapore': '新加坡',
  'Asia/Kolkata': '印度 · 加尔各答', 'Asia/Dubai': '阿联酋 · 迪拜', 'Europe/London': '英国 · 伦敦',
  'Europe/Paris': '法国 · 巴黎', 'Europe/Berlin': '德国 · 柏林', 'Europe/Moscow': '俄罗斯 · 莫斯科',
  'America/New_York': '美国东部 · 纽约', 'America/Chicago': '美国中部 · 芝加哥',
  'America/Los_Angeles': '美国西部 · 洛杉矶', 'America/Toronto': '加拿大 · 多伦多',
  'America/Sao_Paulo': '巴西 · 圣保罗', 'Australia/Sydney': '澳大利亚 · 悉尼',
  'Pacific/Auckland': '新西兰 · 奥克兰', UTC: '协调世界时',
};

function zoneLabel(zone: string): string {
  return ZONE_LABELS[zone] ?? zone.split('/').at(-1)?.replaceAll('_', ' ') ?? zone;
}

function zoneNames(): string[] | null {
  if (supportedZones === undefined) {
    const list = typeof Intl === 'undefined'
      ? undefined
      : (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone');
    supportedZones = Array.isArray(list) && list.length
      ? [...new Set([...COMMON_ZONES, ...list])]
      : COMMON_ZONES;
  }
  return supportedZones;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** UTC offset of an IANA zone right now; null doubles as the "unknown zone" probe. */
function zoneOffsetLabel(zone: string): string | null {
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(now);
    const pick = (type: Intl.DateTimeFormatPartTypes): number =>
      Number(parts.find((part) => part.type === type)?.value ?? '0');
    const wallClock = Date.UTC(pick('year'), pick('month') - 1, pick('day'), pick('hour') % 24, pick('minute'), pick('second'));
    const minutes = Math.round((wallClock - Math.floor(now.getTime() / 1000) * 1000) / 60_000);
    const abs = Math.abs(minutes);
    return `UTC${minutes < 0 ? '-' : '+'}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
  } catch {
    return null;
  }
}

function fieldError(field: ToolField, value: FieldValue | undefined): 'required' | 'range' | 'format' | null {
  if (field.type === 'number' || field.type === 'slider') {
    if (field.type === 'number' && value === undefined) return null;
    if (field.type === 'number' && value === '') return null;
    if (value === undefined || value === '') return 'required';
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 'format';
    if ((field.min !== undefined && numeric < field.min) || (field.max !== undefined && numeric > field.max)) return 'range';
  }
  if (field.type === 'text' || field.type === 'textarea') {
    const text = String(value ?? '');
    if (field.required && !text.trim()) return 'required';
    if (field.maxLength !== undefined && text.length > field.maxLength) return 'range';
  }
  if (field.type === 'dateTime' && field.required && !String(value ?? '').trim()) return 'required';
  if (field.type === 'select' && !field.options.some((option) => String(option.value) === String(value))) {
    return 'required';
  }
  if (field.type === 'color' && !/^#[\da-f]{6}$/i.test(String(value ?? ''))) return 'format';
  if (field.type === 'pageRanges') {
    const text = String(value ?? '').trim();
    if (!text && !field.allowEmpty) return 'required';
    if (text && field.allowAll === false && ALL_RANGES.has(text.toLowerCase())) return 'range';
    if (text && !ALL_RANGES.has(text.toLowerCase()) && !['odd', 'even', '奇数', '偶数'].includes(text.toLowerCase()) && !isValidPageRanges(text)) return 'format';
  }
  return null;
}

export function areOptionsValid(fields: ToolField[], values: Record<string, FieldValue>): boolean {
  return fields.filter((field) => isVisible(field, values)).every((field) => fieldError(field, values[field.key]) === null);
}

const DEFAULT_HINTS: Record<string, string> = {
  'opt.position': 'opt.position.hint',
  'opt.margin': 'opt.margin.hint',
  'opt.pages': 'opt.pages.hint',
  'opt.ranges': 'opt.ranges.hint',
  'opt.opacity': 'opt.opacity.hint',
  'opt.fontSize': 'opt.fontSize.hint',
  'opt.images.dpi': 'opt.images.dpi.hint',
  'opt.images.quality': 'opt.images.quality.hint',
  'opt.compress.objectStreams': 'opt.compress.objectStreams.hint',
  'opt.extract.minSize': 'opt.extract.minSize.hint',
};

export function OptionForm({
  fields,
  values,
  onChange,
}: {
  fields: ToolField[];
  values: Values;
  onChange: (key: string, value: FieldValue) => void;
}) {
  const { t } = useI18n();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const visible = fields.filter((field) => isVisible(field, values));
  // UI-only controls (presets) stay rendered; they write into real fields.
  const main = visible.filter((field) => !field.section || field.section === 'main');
  const layout = visible.filter((field) => field.section === 'layout' && !field.uiOnly);
  const advanced = visible.filter((field) => field.section === 'advanced' && !field.uiOnly);

  return (
    <div className="tool-form flex flex-col gap-4">
      <Group fields={main} values={values} onChange={onChange} />
      {layout.length ? (
        <section aria-labelledby="option-layout-heading" className="form-section flex flex-col gap-2.5">
          <div>
            <h3 id="option-layout-heading" className="form-section-title">{t('opt.section.layout')}</h3>
            <p className="form-hint mt-0.5">{t('opt.section.layoutHint')}</p>
          </div>
          <Group fields={layout} values={values} onChange={onChange} bare />
        </section>
      ) : null}
      {advanced.length ? (
        <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen} className="form-section pt-3">
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="group h-auto w-full justify-start gap-1.5 border-transparent bg-transparent px-1 py-1 text-[12.5px] font-medium text-muted hover:bg-transparent hover:text-ink">
              <Icon name="chevronRight" size={13} className="transition-transform group-data-[state=open]:rotate-90" />
              <span>{t('opt.section.advanced')}</span>
              <span className="ml-auto rounded-full bg-raised px-1.5 text-[11px] text-faint">{advanced.length}</span>
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="overflow-hidden data-[state=closed]:hidden">
            <div className="flex flex-col gap-2.5 pt-2.5">
              <p className="form-hint">{t('opt.section.advancedHint')}</p>
              <Group fields={advanced} values={values} onChange={onChange} bare />
            </div>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

function Group({
  fields,
  values,
  onChange,
  bare,
}: {
  fields: ToolField[];
  values: Values;
  onChange: (key: string, value: FieldValue) => void;
  bare?: boolean;
}) {
  const rows = new Map<string, ToolField[]>();
  const stack: ToolField[] = [];
  for (const field of fields) {
    if (field.row) {
      const bucket = rows.get(field.row) ?? [];
      bucket.push(field);
      rows.set(field.row, bucket);
    } else {
      stack.push(field);
    }
  }

  const content = (
    <div className="form-field-stack">
      {stack.map((field) => (
        <Field key={field.key} field={field} value={values[field.key]} onChange={onChange} values={values} />
      ))}
      {[...rows.entries()].map(([row, group]) => (
        <div key={row} className={cn('grid gap-3', group.length > 1 ? 'grid-cols-2' : 'grid-cols-1')}>
          {group.map((field) => (
            <Field
              key={field.key}
              field={field}
              value={values[field.key]}
              onChange={onChange}
              values={values}
            />
          ))}
        </div>
      ))}
    </div>
  );

  if (!fields.length) return null;
  if (bare) return content;
  return <div>{content}</div>;
}

function Field({
  field,
  value,
  values,
  onChange,
}: {
  field: ToolField;
  value: FieldValue | undefined;
  values: Values;
  onChange: (key: string, value: FieldValue) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const label = t(field.labelKey);
  const hintKey = field.descriptionKey ?? DEFAULT_HINTS[field.labelKey];
  const hint = hintKey ? t(hintKey) : undefined;
  const error = fieldError(field, value);
  const errorText = error ? t(`form.error.${error}`) : undefined;
  const helpText = field.type === 'pageRanges' && field.key !== 'pages' ? t('opt.ranges.help') : hint;

  if (field.type === 'boolean') {
    return (
      <Toggle
        id={id}
        checked={value === true}
        onChange={(next) => onChange(field.key, next)}
        label={label}
        hint={hint}
      />
    );
  }

  return (
    <div className="form-field">
      <Label htmlFor={id} className="form-label">{label}{(field.type === 'text' || field.type === 'textarea' || field.type === 'dateTime') && field.required ? <span className="ml-1 text-bad">*</span> : null}</Label>
      <Control id={id} field={field} value={value} values={values} onChange={onChange} />
      {helpText ? <p className="form-hint">{helpText}</p> : null}
      {errorText ? <p className="text-[11px] leading-4 text-bad" role="alert">{errorText}</p> : null}
    </div>
  );
}

function Control({
  id,
  field,
  value,
  values,
  onChange,
}: {
  id: string;
  field: ToolField;
  value: FieldValue | undefined;
  values: Values;
  onChange: (key: string, value: FieldValue) => void;
}) {
  const { t } = useI18n();
  switch (field.type) {
    case 'number':
      {
        const current = value === undefined || value === '' ? '' : toDisplayNumber(field, Number(value));
        const min = field.min === undefined ? undefined : toDisplayNumber(field, field.min);
        const max = field.max === undefined ? undefined : toDisplayNumber(field, field.max);
        const step = field.displayUnit === 'mm' ? 0.5 : field.step ?? 1;
        const unit = field.displayUnit ? t('unit.mm') : field.suffixKey ? t(field.suffixKey) : '';
      return (
        <span className="relative flex items-center">
          <HeroInput
            type="number"
            id={id}
            className={cn('font-mono tabular-nums', unit && 'pr-10')}
            min={min}
            max={max}
            step={step}
            value={String(current)}
            aria-invalid={fieldError(field, value) !== null}
            onChange={(event) => {
              const raw = event.target.value;
              onChange(field.key, raw === '' ? '' : fromDisplayNumber(field, Number(raw)));
            }}
          />
          {unit ? (
            <span className="pointer-events-none absolute right-2.5 text-[11.5px] text-faint">
              {unit}
            </span>
          ) : null}
        </span>
      );
      }
    case 'select':
      {
      const current = value ?? field.default;
      const choose = (selected: string | number) => {
        const option = field.options.find((candidate) => String(candidate.value) === String(selected));
        if (!option) return;
        onChange(field.key, option.value);
        if (field.uiOnly && option.applies) {
          for (const [key, applied] of Object.entries(option.applies)) onChange(key, applied);
        }
      };
      const selected = (option: { value: string | number }) => String(current) === String(option.value);
      if (field.presentation === 'position-grid') {
        return (
          <div role="group" aria-label={t(field.labelKey)} className="grid w-fit grid-cols-3 gap-1 rounded-control border border-line bg-raised/60 p-1">
            {field.options.map((option) => (
              <Button
                key={String(option.value)}
                type="button"
                variant={selected(option) ? 'secondary' : 'ghost'}
                size="icon"
                title={t(option.labelKey)}
                aria-label={t(option.labelKey)}
                aria-pressed={selected(option)}
                onClick={() => choose(option.value)}
                className={cn('h-9 w-10 border-transparent p-0', selected(option) && 'border-accent/35 bg-accent-soft text-accent hover:bg-accent-soft')}
              >
                <span className={positionMarkerClass(String(option.value))} aria-hidden="true"><span className="h-1.5 w-1.5 rounded-full bg-current" /></span>
              </Button>
            ))}
          </div>
        );
      }
      if (field.presentation === 'cards') {
        return (
          <div role="group" aria-label={t(field.labelKey)} className="grid grid-cols-2 gap-1.5">
            {field.options.map((option) => (
              <Button
                key={String(option.value)}
                type="button"
                variant={selected(option) ? 'secondary' : 'outline'}
                aria-pressed={selected(option)}
                onClick={() => choose(option.value)}
                className={cn('h-auto min-h-12 justify-start whitespace-normal px-2.5 py-2 text-left', selected(option) && 'border-accent/35 bg-accent-soft text-accent hover:bg-accent-soft')}
              >
                <span className="flex min-w-0 flex-col items-start gap-0.5">
                  <span className="text-[11.5px] leading-4">{t(option.labelKey)}</span>
                  {option.descriptionKey ? <span className="whitespace-normal text-left text-[10px] font-normal leading-4 text-faint">{t(option.descriptionKey)}</span> : null}
                </span>
              </Button>
            ))}
          </div>
        );
      }
      if (field.options.length <= 4) {
        return (
          <div role="group" aria-label={t(field.labelKey)} className="flex flex-wrap gap-1.5">
            {field.options.map((option) => {
              const isSelected = selected(option);
              return (
                <Button
                  key={String(option.value)}
                  type="button"
                  variant={isSelected ? 'secondary' : 'outline'}
                  size="sm"
                  aria-pressed={isSelected}
                  onClick={() => choose(option.value)}
                  className={cn('h-auto min-h-8 whitespace-normal px-2.5 py-1 text-[11.5px] leading-4 font-normal', isSelected && 'border-accent/35 bg-accent-soft font-medium text-accent hover:bg-accent-soft')}
                >
                  <span className="flex flex-col items-start gap-0.5">
                    <span>{t(option.labelKey)}</span>
                    {option.descriptionKey ? <span className="text-left text-[10px] font-normal leading-4 text-faint">{t(option.descriptionKey)}</span> : null}
                  </span>
                </Button>
              );
            })}
          </div>
        );
      }
      return (
        <Select
          value={String(current)}
          onValueChange={choose}
        >
          <SelectTrigger id={id} aria-invalid={fieldError(field, value) !== null}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {field.options.map((option) => (
              <SelectItem key={String(option.value)} value={String(option.value)}>
                {t(option.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
      }
    case 'slider': {
      const numeric = Number(value ?? field.default);
      const displayValue = toDisplayNumber(field, numeric);
      const displayMin = toDisplayNumber(field, field.min);
      const displayMax = toDisplayNumber(field, field.max);
      const displayStep = field.displayUnit === 'mm' ? 0.5 : field.step;
      const unit = field.displayUnit
        ? t('unit.mm')
        : field.unit === 'percent' ? '%' : field.unit === 'dpi' ? ' DPI' : field.unit === 'deg' ? '°' : field.unit === 'px' ? ' px' : field.unit === 'kb' ? ' KB' : ' pt';
      return (
        <span className="flex flex-col gap-1.5">
          <span className="flex items-center gap-2.5">
          <Slider
            id={id}
            min={displayMin}
            max={displayMax}
            step={displayStep}
            value={[displayValue]}
            onValueChange={([next]) => onChange(field.key, fromDisplayNumber(field, next ?? displayValue))}
            aria-label={t(field.labelKey)}
            className="min-w-0 flex-1"
          />
          <span className="w-[54px] shrink-0 text-right font-mono text-[12px] tabular-nums text-muted">
            {displayValue}
            {unit}
          </span>
          </span>
          {field.presets?.length ? (
            <div className="flex flex-wrap gap-1">
              {field.presets.map((preset) => (
                <Button
                  key={preset.value}
                  type="button"
                  variant={numeric === preset.value ? 'secondary' : 'ghost'}
                  size="sm"
                  aria-pressed={numeric === preset.value}
                  onClick={() => onChange(field.key, preset.value)}
                  className={cn('h-6 px-2 text-[10.5px]', numeric === preset.value && 'border-accent/35 bg-accent-soft text-accent hover:bg-accent-soft')}
                >
                  {t(preset.labelKey)} <span className="ml-0.5 text-faint">{toDisplayNumber(field, preset.value)}{unit}</span>
                </Button>
              ))}
            </div>
          ) : null}
        </span>
      );
    }
    case 'color': {
      const hex = String(value ?? field.default);
      return (
        <span className="flex items-center gap-2">
          <input
            type="color"
            aria-label={t('opt.color')}
            value={hex}
            onChange={(event) => onChange(field.key, event.target.value)}
            className="h-8 w-10 shrink-0 cursor-pointer rounded-control border border-line bg-surface p-1"
          />
          <HeroInput
            type="text"
            id={id}
            className="font-mono uppercase"
            value={hex}
            maxLength={7}
            aria-invalid={fieldError(field, value) !== null}
            aria-label={t('form.colorValue')}
            onChange={(event) => onChange(field.key, event.target.value)}
          />
        </span>
      );
    }
    case 'pageRanges':
      return <PageRangesField id={id} field={field} value={String(value ?? field.default)} onChange={onChange} />;
    case 'timezone':
      return <TimezoneField id={id} field={field} value={String(value ?? field.default)} onChange={onChange} />;
    case 'dateTime':
      return <DateTimeField id={id} field={field} value={String(value ?? field.default)} onChange={onChange} />;
    case 'textarea':
      return <span className="flex flex-col gap-1.5">
        <HeroTextarea
          id={id}
          rows={field.rows ?? 4}
          className={cn(
            'min-h-[76px] resize-y leading-5',
            field.mono && 'font-mono',
            fieldError(field, value) !== null && 'border-bad focus:border-bad focus:ring-bad/25',
          )}
          value={field.default === 'now' && value === 'now' ? '' : String(value ?? field.default)}
          maxLength={field.maxLength}
          required={field.required}
          aria-invalid={fieldError(field, value) !== null}
          placeholder={field.placeholderKey ? t(field.placeholderKey) : undefined}
          onChange={(event) => onChange(field.key, event.target.value)}
        />
        {field.key === 'input' && field.default === 'now' ? <TimestampPicker value={String(value ?? '')} onChange={(next) => onChange(field.key, next)} /> : null}
        {field.default === 'now' && value === 'now' ? <Button type="button" variant="outline" size="sm" className="self-start h-7 rounded-full px-2.5 text-[11px]" onClick={() => onChange(field.key, 'now')}>{t('date.useNow')}</Button> : null}
      </span>;
    case 'text':
    default:
      return (
        <HeroInput
          type="text"
          id={id}
          className={field.type === 'text' && field.mono ? 'font-mono' : ''}
          value={String(value ?? field.default)}
          maxLength={field.type === 'text' ? field.maxLength : undefined}
          required={field.type === 'text' ? field.required : undefined}
          aria-invalid={fieldError(field, value) !== null}
          placeholder={field.type === 'text' && field.placeholderKey ? t(field.placeholderKey) : undefined}
          onChange={(event) => onChange(field.key, event.target.value)}
        />
      );
  }
}

function TimestampPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { t } = useI18n();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [day, setDay] = useState(now.getDate());
  const [hour, setHour] = useState(now.getHours());
  const [minute, setMinute] = useState(now.getMinutes());
  const [second, setSecond] = useState(now.getSeconds());
  const commit = () => {
    const next = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`;
    const current = value.trim();
    onChange(current && current !== 'now' ? `${current}\n${next}` : next);
  };
  const select = (current: string, set: (value: number) => void, options: number[]) => (
    <Select value={current} onValueChange={(next) => set(Number(next))}>
      <SelectTrigger className="h-8 min-w-[4.5rem] text-[11px]"><SelectValue /></SelectTrigger>
      <SelectContent className="max-h-56">{options.map((option) => <SelectItem key={option} value={String(option)}>{String(option).padStart(2, '0')}</SelectItem>)}</SelectContent>
    </Select>
  );
  return (
    <Popover>
      <PopoverTrigger asChild><Button type="button" variant="outline" size="sm" className="h-8 text-[11.5px]">{t('date.picker.add')}</Button></PopoverTrigger>
      <PopoverContent className="w-[19rem]">
        <p className="mb-2 text-[11px] text-muted">{t('date.picker.addHint')}</p>
        <div className="grid grid-cols-3 gap-1.5">
          {select(String(year), setYear, Array.from({ length: 11 }, (_, index) => now.getFullYear() - 5 + index))}
          {select(String(month), setMonth, Array.from({ length: 12 }, (_, index) => index + 1))}
          {select(String(day), setDay, Array.from({ length: 31 }, (_, index) => index + 1))}
          {select(String(hour), setHour, Array.from({ length: 24 }, (_, index) => index))}
          {select(String(minute), setMinute, Array.from({ length: 60 }, (_, index) => index))}
          {select(String(second), setSecond, Array.from({ length: 60 }, (_, index) => index))}
        </div>
        <Button type="button" size="sm" className="mt-3 w-full" onClick={commit}>{t('date.picker.confirm')}</Button>
      </PopoverContent>
    </Popover>
  );
}

function PageRangesField({
  id,
  field,
  value,
  onChange,
}: {
  id: string;
  field: ToolField;
  value: string;
  onChange: (key: string, value: FieldValue) => void;
}) {
  const { t } = useI18n();
  const error = fieldError(field, value);
  const invalid = error !== null;
  const presets = [
    ...(field.type === 'pageRanges' && field.allowAll === false ? [] : [{ value: 'all', labelKey: 'ranges.all' }]),
    { value: 'odd', labelKey: 'ranges.odd' },
    { value: 'even', labelKey: 'ranges.even' },
  ];
  return (
    <span className="flex flex-col gap-1.5">
      <span className="relative">
        <HeroInput
          type="text"
          id={id}
          className={cn('font-mono', invalid && 'border-bad focus:border-bad focus:ring-bad/25')}
          aria-invalid={invalid}
          aria-describedby={invalid ? `${id}-error` : undefined}
          value={value}
          placeholder={field.type === 'pageRanges' && field.placeholderKey ? t(field.placeholderKey) : t('opt.ranges.placeholder')}
          onChange={(event) => onChange(field.key, event.target.value)}
        />
        {invalid ? <Icon name="warning" size={14} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-bad" /> : null}
      </span>
      {invalid ? <span id={`${id}-error`} className="text-[11px] leading-4 text-bad" role="alert">{t(`form.error.${error}`)}</span> : null}
      <span className="flex flex-wrap items-center gap-1">
        {presets.map((preset) => (
          <Button
            key={preset.value}
            type="button"
            variant={value === preset.value ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => onChange(field.key, preset.value)}
            className={`h-6 rounded-full px-2 text-[11px] font-normal ${value === preset.value ? 'border-accent bg-accent-soft text-accent hover:bg-accent-soft' : 'text-muted'}`}
          >
            {t(preset.labelKey)}
          </Button>
        ))}
      </span>
    </span>
  );
}

type TimezoneInput = Extract<ToolField, { type: 'timezone' }>;
type DateTimeInput = Extract<ToolField, { type: 'dateTime' }>;

function TimezoneField({
  id,
  field,
  value,
  onChange,
}: {
  id: string;
  field: TimezoneInput;
  value: string;
  onChange: (key: string, value: FieldValue) => void;
}) {
  const { t } = useI18n();
  const zones = zoneNames();
  const normalized = value.trim();
  const offset = normalized ? zoneOffsetLabel(normalized) : null;
  const invalid = normalized.length > 0 && offset === null;
  const choices = zones ?? COMMON_ZONES;
  return (
    <span className="flex min-w-0 flex-col gap-1.5">
      <Select value={normalized} onValueChange={(next) => onChange(field.key, next)}>
        <SelectTrigger id={id} aria-invalid={invalid} className={invalid ? 'border-bad focus-visible:ring-bad/25' : undefined}>
          <SelectValue placeholder={t('timezone.placeholder')} />
        </SelectTrigger>
        <SelectContent className="max-h-[22rem]">
          {choices.map((zone) => (
            <SelectItem key={zone} value={zone}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{zoneLabel(zone)}</span>
                <span className="font-mono text-[10px] text-faint">{zone} · {zoneOffsetLabel(zone) ?? '—'}</span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {invalid ? (
        <p className="text-[11px] leading-4 text-bad" role="alert">{t('timezone.invalid')}</p>
      ) : null}
    </span>
  );
}

function DateTimeField({
  id,
  field,
  value,
  onChange,
}: {
  id: string;
  field: DateTimeInput;
  value: string;
  onChange: (key: string, value: FieldValue) => void;
}) {
  const { t } = useI18n();
  const invalid = fieldError(field, value) !== null;
  const active = value.trim().toLowerCase();
  const isNow = active === 'now';
  return (
    <span className="flex min-w-0 flex-col gap-1.5">
      <HeroInput
        type="text"
        id={id}
        spellCheck={false}
        value={isNow ? '' : value}
        required={field.required}
        placeholder={field.placeholderKey ? t(field.placeholderKey) : undefined}
        aria-invalid={invalid}
        onChange={(event) => onChange(field.key, event.target.value)}
        className={`min-w-0 ${field.mono ? 'font-mono' : ''} ${invalid ? 'border-bad focus:border-bad focus:ring-bad/25' : ''}`}
      />
      {field.presets?.length ? (
        <span role="group" aria-label={t('date.presets.aria')} className="flex flex-wrap gap-1">
          {field.presets.map((preset) => (
            <Button
              key={preset}
              type="button"
              variant={active === preset ? 'secondary' : 'outline'}
              size="sm"
              aria-pressed={active === preset}
              onClick={() => onChange(field.key, preset)}
              className={`h-6 rounded-full px-2 text-[11px] font-normal ${active === preset ? 'border-accent bg-accent-soft text-accent hover:bg-accent-soft' : 'text-muted'}`}
            >
              {t(`date.preset.${preset}`)}
            </Button>
          ))}
        </span>
      ) : null}
    </span>
  );
}
