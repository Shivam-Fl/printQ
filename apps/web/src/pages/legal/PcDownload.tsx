import { useState } from 'react';
import { Link } from 'react-router-dom';
import Topbar from '../../components/Topbar.js';
import { PcLinkShare, PcSteps } from '../../components/PcSetup.js';
import { WINDOWS_DOWNLOAD_URL, detectPhoneLike } from '../../lib/pcDownload.js';

/** Public page (no sign-in): printqs.com/pc, the installer for the shop's counter computer. */
export default function PcDownload() {
  const [phone] = useState(detectPhoneLike);

  return (
    <main className="page pc-page">
      <Topbar right={<Link to="/dashboard/login">Shop sign in</Link>} />
      <header className="pc-head">
        <span className="eyebrow-label">For shop owners</span>
        <h1>PrintQs for your shop computer</h1>
        <p>Install this on the Windows computer next to your printer. It sends PrintQs orders to your printer.</p>
      </header>
      {phone && <PcLinkShare />}
      <section className="connect-panel pc-download">
        <a className="button-link large" href={WINDOWS_DOWNLOAD_URL}>Download PrintQs Shop for Windows</a>
        <PcSteps onPcPage />
      </section>
      <p className="dim pc-foot">
        New to PrintQs? <Link to="/dashboard/register">Register your shop</Link> first. Stuck? <Link to="/support">Get help</Link>.
      </p>
    </main>
  );
}
