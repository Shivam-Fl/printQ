import { describe, expect, it } from 'vitest';
import {
  isSimulatorPrinterName, nextSetupAction, pcStepTodo, platformFeeLine, PRICES_PATH, setupSteps, SIMULATOR_ONLY_TEXT,
  simulatorOnly, statusBanner, visibilityState, type SetupSnapshot,
} from './setupSteps.js';

function snapshot(over: Partial<SetupSnapshot> = {}, counts: Partial<SetupSnapshot['counts']> = {}): SetupSnapshot {
  return {
    locationReady: true,
    pricingReady: true,
    printerReady: false,
    agentReady: false,
    ready: false,
    platformMarkupBps: 2500,
    visibility: { state: 'not_ready', reason: null },
    ...over,
    counts: { linkedPrinters: 0, onlinePrinters: 0, agents: 0, onlineAgents: 0, detectedPrinters: 0, ...counts },
  };
}

const pcStep = (s: SetupSnapshot) => setupSteps(s).find((step) => step.key === 'pc')!;

describe('step 3: counter PC and printer', () => {
  it('asks to install the app when no PC was ever connected', () => {
    const step = pcStep(snapshot());
    expect(step.done).toBe(false);
    expect(step.body).toMatch(/On your counter PC .*open printqs\.com\/pc\. Install PrintQs Shop/);
    expect(step.to).toBe('/dashboard/agents');
    expect(step.body).not.toMatch(/by itself/);
  });
  it('says the PC is connected and sends the owner to add the printer it found', () => {
    const step = pcStep(snapshot({}, { agents: 1, onlineAgents: 1, detectedPrinters: 1 }));
    expect(step.done).toBe(false);
    expect(step.body).toMatch(/^PC connected · 1 printer found/);
    expect(step.to).toBe('/dashboard/printers');
    expect(step.action).toBe('Add printer');
    expect(pcStep(snapshot({}, { agents: 1, onlineAgents: 1, detectedPrinters: 3 })).body).toMatch(/3 printers found/);
  });
  it('explains when the PC is connected but reports no printer', () => {
    expect(pcStep(snapshot({}, { agents: 1, onlineAgents: 1, detectedPrinters: 0 })).body).toMatch(/no printer found yet/);
  });
  it('still points at the Printers page when the API does not report detected printers', () => {
    const step = pcStep(snapshot({}, { agents: 1, onlineAgents: 1, detectedPrinters: undefined }));
    expect(step.body).toMatch(/^PC connected\. Add it/);
    expect(step.to).toBe('/dashboard/printers');
  });
  it('tells a returning shop its PC is offline instead of asking to install again', () => {
    const step = pcStep(snapshot({}, { agents: 1, onlineAgents: 0, linkedPrinters: 1 }));
    expect(step.body).toMatch(/offline/);
    expect(step.body).not.toMatch(/Install/);
  });
  it('flags a linked printer that is offline', () => {
    expect(pcStepTodo(snapshot({}, { agents: 1, onlineAgents: 1, linkedPrinters: 1 }))?.text).toMatch(/printer is offline/);
  });
  it('is done once a linked printer is online', () => {
    const step = pcStep(snapshot({ agentReady: true, printerReady: true }, { agents: 1, onlineAgents: 1, linkedPrinters: 1, onlinePrinters: 1 }));
    expect(step.done).toBe(true);
    expect(step.body).toBe('PC connected · 1 printer ready.');
  });
});

describe('steps 2 and 4', () => {
  it('prices link straight to the price editor and disclose the fee', () => {
    const prices = setupSteps(snapshot()).find((step) => step.key === 'prices')!;
    expect(prices.to).toBe(PRICES_PATH);
    expect(prices.to).toBe('/dashboard/prices');
    expect(prices.note).toBe('Students pay your price + a PrintQs fee of 25%.');
  });
  it('formats the fee from basis points, and hides it when there is none', () => {
    expect(platformFeeLine(1250)).toMatch(/12\.5%/);
    expect(platformFeeLine(0)).toBeNull();
    expect(platformFeeLine(undefined)).toBeNull();
  });
  it('step 4 promises live only after PC and printer', () => {
    const live = setupSteps(snapshot()).find((step) => step.key === 'live')!;
    expect(live.done).toBe(false);
    expect(live.body).toBe('Students nearby can find you as soon as your PC is connected and your printer is added.');
  });
  it('step 4 counts a live shop with its PC off as live', () => {
    const live = setupSteps(snapshot({ visibility: { state: 'live_pc_offline', reason: null } })).find((step) => step.key === 'live')!;
    expect(live.done).toBe(true);
  });
});

describe('visibility fallback (older API without visibility)', () => {
  it('uses ready and publishedAt', () => {
    expect(visibilityState({ ready: true })).toBe('live');
    expect(visibilityState({ ready: false, verification: { publishedAt: '2026-11-01' } })).toBe('live_pc_offline');
    expect(visibilityState({ ready: false, verification: { publishedAt: null } })).toBe('not_ready');
  });
});

describe('status banner (queue + setup)', () => {
  it('shows nothing for a live shop', () => {
    expect(statusBanner(snapshot({ ready: true, visibility: { state: 'live', reason: null } }))).toBeNull();
  });
  it('tells a live shop its PC is off instead of "Finish setup"', () => {
    const banner = statusBanner(snapshot({ visibility: { state: 'live_pc_offline', reason: null } }, { agents: 1, linkedPrinters: 1 }))!;
    expect(banner.title).toBe('Live · counter PC offline — students can’t order until it’s back on');
    expect(banner.title).not.toMatch(/Finish setup/);
    expect(banner.to).toBe('/dashboard/agents');
  });
  it('explains an admin pause with the reason and a support link', () => {
    const banner = statusBanner(snapshot({ visibility: { state: 'hidden_by_admin', reason: 'Wrong address' } }))!;
    expect(banner.title).toBe('Paused by PrintQs');
    expect(banner.text).toMatch(/Reason: Wrong address/);
    expect(banner.to).toBe('/support');
    expect(statusBanner(snapshot({ visibility: { state: 'hidden_by_admin', reason: null } }))!.text).not.toMatch(/Reason/);
  });
  it('explains an inactive campus', () => {
    const banner = statusBanner(snapshot({ visibility: { state: 'campus_inactive', reason: null } }))!;
    expect(banner.text).toMatch(/campus/);
    expect(banner.to).toBe('/support');
  });
  it('says "add a printer", not "PC offline", when the PC is online but no printer is ready', () => {
    const banner = statusBanner(snapshot({ visibility: { state: 'live_pc_offline', reason: null } }, { agents: 1, onlineAgents: 1, linkedPrinters: 0, detectedPrinters: 1 }))!;
    expect(banner.title).toMatch(/add a printer/);
    expect(banner.title).not.toMatch(/PC offline/);
  });
  it('points "finish setup" at the step that is actually missing', () => {
    expect(statusBanner(snapshot({ locationReady: false }))!.text).toBe('Next: Save your shop location.');
    expect(statusBanner(snapshot({ pricingReady: false }))!.to).toBe(PRICES_PATH);
    expect(statusBanner(snapshot())!.to).toBe('/dashboard/agents');
    const addPrinter = statusBanner(snapshot({}, { agents: 1, onlineAgents: 1, detectedPrinters: 1 }))!;
    expect(addPrinter.to).toBe('/dashboard/printers');
    expect(addPrinter.action).toBe('Add printer');
  });
  it('does not say "Finish setup" when only the review is left', () => {
    const ready = snapshot({ agentReady: true, printerReady: true, visibility: { state: 'pending_review', reason: null } }, { onlineAgents: 1, linkedPrinters: 1, onlinePrinters: 1 });
    expect(statusBanner(ready)!.title).toBe('Waiting for PrintQs review');
    expect(nextSetupAction(ready).text).toMatch(/checking your shop/);
  });
});

describe('simulator-only shops (PSO-1)', () => {
  // The API leaves simulators out of linkedPrinters/onlinePrinters and counts them in simulatorPrinters.
  const simOnline = { agents: 1, onlineAgents: 1, linkedPrinters: 0, onlinePrinters: 0, simulatorPrinters: 1 };

  it('treats a missing simulatorPrinters count as no simulator', () => {
    expect(simulatorOnly({ linkedPrinters: 0 })).toBe(false);
    expect(simulatorOnly({ linkedPrinters: 0, simulatorPrinters: 0 })).toBe(false);
  });
  it('is simulator-only only when no real printer is added', () => {
    expect(simulatorOnly({ linkedPrinters: 0, simulatorPrinters: 1 })).toBe(true);
    expect(simulatorOnly({ linkedPrinters: 1, simulatorPrinters: 1 })).toBe(false);
  });
  it('recognises the simulator name like the API does', () => {
    expect(isSimulatorPrinterName('PrintQ Simulator')).toBe(true);
    expect(isSimulatorPrinterName('  printq simulator ')).toBe(true);
    expect(isSimulatorPrinterName('HP LaserJet')).toBe(false);
    expect(isSimulatorPrinterName(null)).toBe(false);
  });
  it('step 3 stays to-do and asks for the real printer', () => {
    const step = pcStep(snapshot({}, simOnline));
    expect(step.done).toBe(false);
    expect(step.body).toBe(SIMULATOR_ONLY_TEXT);
    expect(step.body).toBe('Simulator connected — this is for practice. Add your real printer to go live.');
    expect(step.to).toBe('/dashboard/printers');
  });
  it('step 3 is done once a real printer is added next to the simulator', () => {
    const step = pcStep(snapshot({ agentReady: true, printerReady: true }, { ...simOnline, linkedPrinters: 1, onlinePrinters: 1 }));
    expect(step.done).toBe(true);
  });
  it('says the PC is offline (not the simulator line) when the PC is off', () => {
    expect(pcStepTodo(snapshot({}, { ...simOnline, onlineAgents: 0 }))?.text).toMatch(/offline/);
  });
  it('never says "Almost live" for a simulator-only shop', () => {
    const banner = statusBanner(snapshot({}, simOnline))!;
    expect(banner.title).not.toMatch(/Almost live/);
    expect(banner.text).toBe(`Next: ${SIMULATOR_ONLY_TEXT}`);
  });
  it('warns a listed simulator-only shop that real orders cannot print', () => {
    // a shop published before the API fix: still listed, but its only printer is the simulator
    const banner = statusBanner(snapshot({ visibility: { state: 'live', reason: null } }, simOnline))!;
    expect(banner.title).toMatch(/only the simulator/);
    expect(banner.to).toBe('/dashboard/printers');
  });
});

describe('wording (PSO-3)', () => {
  it('step 3 uses the register checklist wording and no simulator jargon', () => {
    const steps = setupSteps(snapshot());
    expect(steps.find((step) => step.key === 'pc')!.title).toBe('Connect the counter PC and add your printer');
    expect(JSON.stringify(steps)).not.toMatch(/Safe simulator/i);
  });
});
