import { Button } from '@potools/ui';
import { APP_VERSION } from '../lib/version.ts';
import { useI18n } from '../i18n/index.tsx';
import { useSettings } from '../lib/settings.ts';
import { AppLogo } from './AppLogo.tsx';
import { TitleBar } from './TitleBar.tsx';
import englishLicense from '../../src-tauri/license/English.txt?raw';
import chineseLicense from '../../src-tauri/license/ChineseSimplified.txt?raw';

export function LicenseAgreement({ onAccept, onDecline }: { onAccept: () => void; onDecline: () => void }) {
  const { t, tf, locale } = useI18n();
  const settings = useSettings();
  const agreement = locale === 'en' ? englishLicense : chineseLicense;

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas text-ink">
      <TitleBar
        brand={<span className="flex items-center gap-2"><AppLogo className="h-[18px] w-[18px]" /><span className="text-[12.5px] font-semibold">PoTools</span></span>}
        title={t('license.windowTitle')}
      />
      <main className="min-h-0 flex-1 overflow-y-auto">
        <section className="mx-auto flex min-h-full w-full max-w-[900px] flex-col px-6 py-7 md:px-10 md:py-9">
          <header className="mb-5 shrink-0">
            <h1 className="text-[23px] font-semibold tracking-[-.025em]">{t('license.title')}</h1>
            <p className="mt-1.5 text-[12px] text-muted">{tf('license.subtitle', { version: APP_VERSION })}</p>
          </header>

          <div
            aria-label={t('license.documentLabel')}
            className="min-h-[230px] flex-1 overflow-y-auto rounded-control border border-line bg-surface px-5 py-4 shadow-sm md:px-7 md:py-6"
            role="region"
            tabIndex={0}
          >
            <pre className="whitespace-pre-wrap break-words font-sans text-[12.5px] leading-[1.8] text-ink">{agreement}</pre>
          </div>

          <p className="mt-3 shrink-0 text-[12px] leading-5 text-muted">{t('license.prompt')}</p>

          <footer className="mt-5 flex shrink-0 flex-col gap-4 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
            <label className="flex items-center gap-2 text-[12px] text-muted">
              <span>{t('license.language')}</span>
              <select
                aria-label={t('license.language')}
                className="h-9 min-w-36 rounded-control border border-line bg-surface px-3 text-[12px] text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent/35"
                value={settings.locale}
                onChange={(event) => settings.set('locale', event.currentTarget.value as 'zh-CN' | 'en')}
              >
                <option value="zh-CN">简体中文</option>
                <option value="en">English</option>
              </select>
            </label>
            <div className="flex items-center justify-end gap-2">
              <Button variant="secondary" onClick={onDecline}>{t('license.decline')}</Button>
              <Button variant="primary" onClick={onAccept}>{t('license.accept')}</Button>
            </div>
          </footer>
        </section>
      </main>
    </div>
  );
}
