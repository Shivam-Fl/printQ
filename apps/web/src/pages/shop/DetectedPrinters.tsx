import { useState } from 'react';
import { api } from '../../api.js';
import { IconPrinter } from '../../components/Icons.js';
import { isSimulatorPrinterName } from '../../lib/setupSteps.js';
import { guessPaperSizes, type DetectedPrinterLite } from './printersView.js';

/**
 * Printers the counter PC found but PrintQs does not use yet, each with one
 * "Add" that asks the only question we cannot detect: does it print colour?
 * Used inline on the setup checklist and on the Printers page.
 */
export default function DetectedPrinters({ detected, isOwner, onAdded }: {
  detected: DetectedPrinterLite[];
  isOwner: boolean;
  onAdded: (name: string) => void | Promise<void>;
}) {
  const [asking, setAsking] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');

  async function add(d: DetectedPrinterLite, colorSupport: boolean) {
    setAdding(true);
    setError('');
    try {
      const paperSizesLoaded = guessPaperSizes(d.paperSizes);
      await api('/api/shop/printers', {
        method: 'POST',
        role: 'shop',
        body: {
          label: d.name,
          osPrinterName: d.name,
          paperSizesLoaded,
          mediaConfig: Object.fromEntries(paperSizesLoaded.map((size) => [size, { paperSize: size, bin: null }])),
          colorSupport,
          finishingOptions: [],
          avgPagesPerMinute: 15,
        },
      });
      setAsking(null);
      await onAdded(d.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the printer. Try again.');
    } finally {
      setAdding(false);
    }
  }

  return (
    <>
      <ul className="detected-list">
        {detected.map((d) => {
          const practice = isSimulatorPrinterName(d.name);
          return (
            <li key={d.name} className={`detected-item${practice ? ' practice' : ''}`}>
              <span className="detected-icon" aria-hidden><IconPrinter /></span>
              <div className="detected-text">
                <strong>{d.name}</strong>
                <span>{practice ? 'Practice simulator. It never prints student orders.' : d.paperSizes.length > 0 ? `Paper: ${guessPaperSizes(d.paperSizes).join(', ')}` : 'Found on your counter PC'}</span>
              </div>
              {asking === d.name ? (
                <fieldset className="colour-question">
                  <legend>Does it print in colour?</legend>
                  <div className="row">
                    <button type="button" className="small" disabled={adding} onClick={() => void add(d, true)}>Yes, colour</button>
                    <button type="button" className="small secondary" disabled={adding} onClick={() => void add(d, false)}>No, black &amp; white</button>
                    <button type="button" className="quiet" disabled={adding} onClick={() => setAsking(null)}>Cancel</button>
                  </div>
                </fieldset>
              ) : isOwner ? (
                <button type="button" className={practice ? 'secondary small' : 'small'} onClick={() => setAsking(d.name)}>
                  {practice ? 'Add for practice' : `Add ${d.name.length > 24 ? 'printer' : d.name}`}
                </button>
              ) : (
                <span className="dim">The owner can add this printer</span>
              )}
            </li>
          );
        })}
      </ul>
      {error && <p className="error-box" role="alert">{error}</p>}
    </>
  );
}
