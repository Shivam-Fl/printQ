import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { currentPcPageUrl, displayUrl } from '../lib/pcDownload.js';

/** The counter-computer setup in 3 plain steps (shared by /pc and the Computers page). */
export function PcSteps({ onPcPage = false }: { onPcPage?: boolean }) {
  const link = displayUrl(currentPcPageUrl());
  return (
    <ol className="pc-steps">
      <li>
        <strong>Download the app</strong>
        <span>
          {onPcPage
            ? 'On the computer next to your printer, press Download above.'
            : <>On the computer next to your printer, open <span className="mono">{link}</span> and download PrintQs Shop.</>}
        </span>
      </li>
      <li>
        <strong>Install it and sign in</strong>
        <span>Open the downloaded file to install it. Sign in with your shop email and password.</span>
      </li>
      <li>
        <strong>Connect your printer</strong>
        <span>In the app, open Computers and press Connect this computer. Your printers are found by themselves. Press Configure printers to add yours.</span>
      </li>
    </ol>
  );
}

/** For phones: send printqs.com/pc to the counter computer (copy, share or QR). */
export function PcLinkShare({ withQr = false }: { withQr?: boolean }) {
  const url = currentPcPageUrl();
  const link = displayUrl(url);
  const [qr, setQr] = useState('');
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const canShare = typeof navigator.share === 'function';

  useEffect(() => {
    if (!withQr) return;
    let live = true;
    QRCode.toDataURL(url, { width: 320, margin: 2, color: { dark: '#172033', light: '#ffffff' }, errorCorrectionLevel: 'M' })
      .then((data) => { if (live) setQr(data); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [url, withQr]);

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setCopy('copied');
      setTimeout(() => setCopy('idle'), 1600);
    } catch {
      setCopy('failed');
    }
  }

  async function share() {
    try {
      await navigator.share({ title: 'PrintQs Shop for Windows', text: 'Open this on the shop computer to install PrintQs Shop:', url });
    } catch {
      /* the share sheet was closed */
    }
  }

  const mailto = `mailto:?subject=${encodeURIComponent('PrintQs Shop for the counter computer')}&body=${encodeURIComponent(`Open this on the counter computer: ${url}`)}`;

  return (
    <div className="pc-share">
      <div className="pc-share-copy">
        <strong>Open <span className="mono">{link}</span> on your counter computer</strong>
        <p>This phone can’t run the Windows app. Send the link to the computer next to your printer.</p>
        <div className="row">
          <button className="secondary small" onClick={copyLink}>{copy === 'copied' ? 'Copied' : 'Copy link'}</button>
          {canShare
            ? <button className="secondary small" onClick={share}>Share</button>
            : <a className="button-link secondary" href={mailto}>Email the link</a>}
        </div>
        {copy === 'failed' && <p className="field-help" role="status">Couldn’t copy. Type {link} on the computer instead.</p>}
      </div>
      {withQr && (
        <div className="pc-share-qr">
          {qr ? <img src={qr} alt={`QR code for ${link}`} /> : <div className="skeleton-square" />}
        </div>
      )}
    </div>
  );
}
