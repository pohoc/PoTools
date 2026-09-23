import { useMemo, useState } from 'react';
import { Icon, Input, Section } from '@potools/ui';
import { assessPasswordStrength } from 'core';
import type { PasswordStrengthTip } from 'core';
import { useI18n } from '../i18n/index.tsx';

export function PasswordStrengthPanel() {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false);
  const assessment = useMemo(() => assessPasswordStrength(password), [password]);
  const levelKey = password ? `passwordStrength.level.${assessment.level}` : 'passwordStrength.pending';
  const meterClass = ['bg-bad', 'bg-bad', 'bg-warn', 'bg-accent', 'bg-ok'][assessment.score]!;
  const tips: PasswordStrengthTip[] = password ? assessment.tips : [];

  return (
    <Section title={t('passwordStrength.inputTitle')} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <label htmlFor="password-strength-input" className="text-[13px] font-medium text-ink">
          {t('passwordStrength.inputLabel')}
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="password-strength-input"
            type={visible ? 'text' : 'password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={t('passwordStrength.placeholder')}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 font-mono"
            aria-describedby="password-strength-privacy"
          />
          <button
            type="button"
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-control border border-line bg-panel px-3 text-[12px] text-muted hover:bg-hover"
            onClick={() => setVisible((value) => !value)}
            aria-pressed={visible}
          >
            <Icon name={visible ? 'eye-off' : 'eye'} size={14} />
            {t(visible ? 'passwordStrength.hide' : 'passwordStrength.show')}
          </button>
        </div>
        <p id="password-strength-privacy" className="text-[11px] leading-4 text-faint">
          {t('passwordStrength.localOnly')}
        </p>
      </div>

      <div className="rounded-card border border-line bg-panel-subtle p-4" aria-live="polite">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-medium text-ink">{t('passwordStrength.resultTitle')}</span>
          <span className={`text-[13px] font-semibold ${assessment.score < 2 ? 'text-bad' : assessment.score === 2 ? 'text-warn' : assessment.score === 3 ? 'text-accent' : 'text-ok'}`}>
            {t(levelKey)}
          </span>
        </div>
        <div className="mt-3 grid grid-cols-5 gap-1.5" role="img" aria-label={t(levelKey)}>
          {Array.from({ length: 5 }, (_, index) => (
            <span key={index} className={`h-1.5 rounded-full ${password && index < assessment.score ? meterClass : 'bg-line'}`} />
          ))}
        </div>
        <p className="mt-2 text-[11px] text-faint">{password ? t('passwordStrength.length', { count: assessment.length }) : t('passwordStrength.empty')}</p>
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-[12px] font-semibold text-ink">{t('passwordStrength.tipsTitle')}</h3>
        {tips.length ? (
          <ul className="flex flex-col gap-1.5">
            {tips.map((tip) => <li key={tip} className="flex gap-2 text-[12px] leading-5 text-muted"><span className="text-faint">•</span>{t(`passwordStrength.tip.${tip}`)}</li>)}
          </ul>
        ) : (
          <p className="flex items-center gap-1.5 text-[12px] leading-5 text-ok"><Icon name="check" size={14} />{t('passwordStrength.good')}</p>
        )}
      </div>
    </Section>
  );
}
