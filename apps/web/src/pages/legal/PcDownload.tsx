import { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import Topbar from '../../components/Topbar.js';
import { PcLinkShare, PcSteps } from '../../components/PcSetup.js';
import { PC_PAGE_PATH, WINDOWS_DOWNLOAD_URL, detectPhoneLike } from '../../lib/pcDownload.js';

/** Size and system of the current Windows installer (v0.1.0 is 98.9 MB). Update with each release. */
export const INSTALLER_FACTS = '99 MB · Windows 10/11';

/** The unsigned installer gets Windows SmartScreen's warning; say what to press before it scares anyone. */
function SmartScreenHelp() {
  return (
    <p className="pc-smartscreen">
      If Windows says <strong>“Windows protected your PC”</strong> or <strong>“Unknown publisher”</strong>, click{' '}
      <strong>More info</strong>, then <strong>Run anyway</strong>. Windows shows this for new apps it doesn’t know yet.
    </p>
  );
}

/** Public page (no sign-in): printqs.com/pc, the installer for the shop's counter computer. */
export default function PcDownload() {
  const [phone] = useState(detectPhoneLike);
  const { pathname } = useLocation();

  // printqs.com/PC or /pc/ (typed on a shop computer) opens the same page under its real address.
  if (pathname !== PC_PAGE_PATH && pathname.toLowerCase().replace(/\/+$/, '') === PC_PAGE_PATH) {
    return <Navigate to={PC_PAGE_PATH} replace />;
  }

  return (
    <main className="page pc-page">
      <Topbar right={<Link to="/dashboard/login">Shop sign in</Link>} />
      <header className="pc-head">
        <span className="eyebrow-label">For shop owners</span>
        <h1>PrintQs for your shop computer</h1>
        <p>Install this on the Windows computer next to your printer. It sends PrintQs orders to your printer.</p>
      </header>
      {phone ? (
        <>
          {/* A phone or tablet can't install it: sending the link to the counter computer comes first. */}
          <PcLinkShare />
          <section className="connect-panel pc-download">
            <PcSteps />
            <p className="pc-download-alt">
              On the shop computer already?{' '}
              <a href={WINDOWS_DOWNLOAD_URL}>Download for Windows</a> <span className="dim">({INSTALLER_FACTS})</span>
            </p>
            <SmartScreenHelp />
          </section>
        </>
      ) : (
        <section className="connect-panel pc-download">
          <a className="button-link large" href={WINDOWS_DOWNLOAD_URL}>Download PrintQs Shop for Windows</a>
          <p className="pc-download-facts">{INSTALLER_FACTS}</p>
          <SmartScreenHelp />
          <PcSteps onPcPage />
        </section>
      )}
      <p className="dim pc-foot">
        New to PrintQs? <Link to="/dashboard/register">Register your shop</Link> first. Stuck? <Link to="/support">Get help</Link>.
      </p>
    </main>
  );
}
