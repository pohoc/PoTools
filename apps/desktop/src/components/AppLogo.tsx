/** Theme-aware in-app logo. Native package icons remain static assets. */
export function AppLogo({ className = '' }: { className?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 1024 1024" className={className} xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="app-logo-page" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgb(var(--ui-accent-ink))" />
          <stop offset="1" stopColor="rgb(var(--ui-accent-soft))" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="224" fill="rgb(var(--ui-accent))" />
      <circle cx="806" cy="206" r="252" fill="rgb(var(--ui-accent-ink))" opacity=".13" />
      <g transform="rotate(-9 440 440)">
        <rect x="286" y="240" width="308" height="400" rx="36" fill="rgb(var(--ui-accent-ink))" opacity=".5" />
      </g>
      <g transform="rotate(-3 540 520)">
        <path d="M412 300h198l92 92v308a40 40 0 0 1-40 40H412a40 40 0 0 1-40-40V340a40 40 0 0 1 40-40z" fill="url(#app-logo-page)" />
        <path d="M610 300l92 92h-52a40 40 0 0 1-40-40z" fill="rgb(var(--ui-accent))" opacity=".22" />
        <rect x="422" y="474" width="140" height="38" rx="19" fill="rgb(var(--ui-accent))" />
        <rect x="422" y="552" width="230" height="38" rx="19" fill="rgb(var(--ui-accent))" opacity=".72" />
        <rect x="422" y="630" width="150" height="38" rx="19" fill="rgb(var(--ui-accent))" opacity=".45" />
      </g>
      <circle cx="716" cy="716" r="126" fill="rgb(var(--ui-accent-ink))" />
      <rect x="639" y="695" width="154" height="42" rx="21" fill="rgb(var(--ui-accent))" />
      <rect x="695" y="639" width="42" height="154" rx="21" fill="rgb(var(--ui-accent))" />
    </svg>
  );
}
