import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { getToken } from '../api.js';
import { LEGAL_ENTITY_DESCRIPTION, LEGAL_LAST_UPDATED,LEGAL_LINKS, LEGAL_PRODUCT_NAME } from '../lib/legal.js';
import Topbar from './Topbar.js';

/** Where "back" should go for whoever is reading: never a dead end. */
function backLink(): { to: string; label: string } {
  try {
    if (getToken('shop')) return { to: '/dashboard', label: 'Dashboard' };
    if (getToken('student')) return { to: '/home', label: 'Home' };
  } catch {
    /* storage unavailable: fall through to the public home */
  }
  return { to: '/', label: 'Home' };
}

export function PolicyLinks({ current }: { current?: string }) {
  return (
    <nav className="policy-links" aria-label="Help and policies">
      {LEGAL_LINKS.map((l) => (
        <Link key={l.to} to={l.to} aria-current={current === l.to ? 'page' : undefined}>{l.label}</Link>
      ))}
    </nav>
  );
}

export default function LegalLayout({
  path,
  title,
  summary,
  dated = true,
  children,
}: {
  path: string;
  title: string;
  summary: string;
  dated?: boolean;
  children: ReactNode;
}) {
  const back = backLink();
  return (
    <main className="page legal-page">
      <Topbar right={<Link to={back.to}>{back.label}</Link>} />
      <header className="legal-head">
        <span className="eyebrow-label">Help &amp; policies</span>
        <h1>{title}</h1>
        <p className="legal-summary">{summary}</p>
        {dated && <p className="legal-updated">Last updated <time dateTime={LEGAL_LAST_UPDATED}>{LEGAL_LAST_UPDATED}</time></p>}
      </header>
      <article className="legal-body">{children}</article>
      <footer className="legal-foot">
        <PolicyLinks current={path} />
        <span>{LEGAL_ENTITY_DESCRIPTION ?? LEGAL_PRODUCT_NAME}</span>
      </footer>
    </main>
  );
}
