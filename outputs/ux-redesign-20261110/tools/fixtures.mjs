// Builds a realistic local world for screenshots and task measurement.
// Usage: UX_SCRATCH=... node fixtures.mjs shops|live|orders
// Local dev API only. Tokens go to $UX_SCRATCH/state.json, never into the repo.
import {
  api, must, waitFor, loginStudent, createOrder, checkIn, studentJob, loadState, saveState, SHOP_POINT,
} from './lib.mjs';

const stage = process.argv[2];
const state = loadState();
const OWNER_PASSWORD = 'Counter-Desk-2026';

async function registerShop(key, { name, address, email }) {
  if (state[key]?.token) return state[key];
  const r = await must(`register ${name}`, api('/api/auth/shop/register', {
    method: 'POST',
    body: { shopName: name, address, ownerName: 'Rakesh Sharma', email, password: OWNER_PASSWORD },
  }));
  state[key] = { token: r.token, slug: r.shop.slug, id: r.shop.id, email, password: OWNER_PASSWORD, name };
  saveState(state);
  return state[key];
}

async function locate(shop) {
  await must('locate', api('/api/shop/me', {
    method: 'PATCH', token: shop.token,
    body: { ...SHOP_POINT, checkInRadiusM: 200, counterUpiVpa: 'sharmaxerox@okaxis', counterUpiPayeeName: 'Sharma Xerox' },
  }));
  await must('verify upi', api('/api/shop/counter-upi/verify', { method: 'POST', token: shop.token, body: { merchantAppChecked: true } }));
}

if (stage === 'shops') {
  const a = await registerShop('shopA', { name: 'Sharma Xerox & Stationery', address: 'Shop 4, Main Gate Market, opposite Hindu College', email: 'owner.sharma@ux.printq.local' });
  await locate(a);
  const p1 = await must('printer 1', api('/api/shop/printers', {
    method: 'POST', token: a.token,
    body: { label: 'Counter laser', paperSizesLoaded: ['A4'], colorSupport: false, finishingOptions: ['stapling'], avgPagesPerMinute: 20, status: 'online', osPrinterName: 'HP LaserJet Pro M126nw' },
  }));
  const p2 = await must('printer 2', api('/api/shop/printers', {
    method: 'POST', token: a.token,
    body: { label: 'Colour inkjet', paperSizesLoaded: ['A4', 'A3'], colorSupport: true, finishingOptions: ['stapling', 'spiral_binding'], avgPagesPerMinute: 8, status: 'online', osPrinterName: 'Epson L3250 Series' },
  }));
  const ag = await must('agent A', api('/api/shop/agents', { method: 'POST', token: a.token, body: { machineLabel: 'Counter PC', connectedPrinterIds: [p1.printer.id, p2.printer.id] } }));
  state.shopA.agentToken = ag.token;
  state.shopA.printers = [p1.printer.id, p2.printer.id];
  await must('capacity', api('/api/shop/me', { method: 'PATCH', token: a.token, body: { counterCapacity: 2, revealGraceSeconds: 120 } }));

  // B: just signed up (setup step 1), 42-character name for nav stress.
  await registerShop('shopB', { name: 'Shree Ganesh Photocopy & Lamination Centre', address: 'Near Bus Stand, Station Road', email: 'owner.ganesh@ux.printq.local' });
  // C: location done, practice simulator connected, no real printer yet.
  const c = await registerShop('shopC', { name: 'Campus Copy Corner', address: 'Library Block, Ground Floor', email: 'owner.corner@ux.printq.local' });
  await must('locate C', api('/api/shop/me', { method: 'PATCH', token: c.token, body: { ...SHOP_POINT, latitude: SHOP_POINT.latitude + 0.01 } }));
  const agc = await must('agent C', api('/api/shop/agents', { method: 'POST', token: c.token, body: { machineLabel: 'Back office PC', connectedPrinterIds: [] } }));
  state.shopC.agentToken = agc.token;
  saveState(state);
  console.log('shops ready; start the fake counter PCs with shopA/shopC agentToken');
}

if (stage === 'live') {
  const a = state.shopA;
  await waitFor('shop A PC online', async () => {
    const r = await api('/api/shop/agents', { token: a.token });
    return r.data.agents?.some((x) => x.status === 'online' && x.detectedPrinters?.length > 0);
  });
  const sub = await api('/api/shop/verification/submit', { method: 'POST', token: a.token });
  console.log('submit A', sub.status, sub.data.verification?.status);
  const pub = await api(`/api/public/shops/${a.slug}`);
  console.log('public A open:', pub.data.shop?.open);
}

const STUDENTS = [
  ['aarav', '9876500001', 'Aarav Mehta'],
  ['priya', '9876500002', 'Priya Nair'],
  ['rohan', '9876500003', 'Rohan Gupta'],
  ['sneha', '9876500004', 'Sneha Iyer'],
  ['kabir', '9876500005', 'Kabir Singh'],
  ['ananya', '9876500006', 'Ananya Das'],
  ['meera', '9876500007', 'Meera Joshi'],
];

async function codeFor(token, jobId) {
  return waitFor('revealed code', async () => (await studentJob(token, jobId))?.otpCode ?? null, 20_000);
}

async function release(shopToken, otp, method = 'cash', overrideQueue = true) {
  return must('release', api('/api/shop/release', { method: 'POST', token: shopToken, body: { otp, overrideQueue, paymentConfirmation: { method } } }), (r) => r.status === 200 && r.data.ok);
}

if (stage === 'orders') {
  state.students ??= {};
  for (const [key, phone, name] of STUDENTS) {
    if (!state.students[key]) {
      state.students[key] = { phone, name, token: await loginStudent(phone, name), jobs: {} };
      saveState(state);
      console.log('student', name);
    }
  }
  const s = state.students;
  const A = state.shopA;
  const order = async (who, label, opts) => {
    const { jobId, fileId } = await createOrder(s[who].token, A.slug, opts);
    s[who].jobs[label] = jobId;
    s[who].lastFileId = fileId;
    saveState(state);
    return jobId;
  };

  // Released earlier today -> history, earnings, pickup and printing states.
  // Released orders need their code: check in, read it, then release.
  const inFlight = [
    ['aarav', 'done1', { pages: 6, name: 'OS-assignment-2.pdf' }, 'complete'],
    ['priya', 'done2', { pages: 14, name: 'Chemistry-practical.pdf', specs: { duplex: true } }, 'complete'],
    ['rohan', 'done3', { pages: 3, name: 'Cover-letter.pdf', specs: { copies: 2 } }, 'complete'],
    ['priya', 'ready', { pages: 10, name: 'Maths-tutorial-sheet.pdf' }, 'ready'],
    ['ananya', 'finishing', { pages: 32, name: 'Minor-project-report.pdf', specs: { binding: 'spiral_binding', paperSize: 'A4' } }, 'finishing'],
    ['rohan', 'printing', { pages: 2, name: 'Internship-letter.pdf' }, 'printing'],
    ['sneha', 'jam', { pages: 5, name: 'Lab-manual.pdf', specs: { copies: 7 } }, 'jam'],
  ];
  for (const [who, label, opts, end] of inFlight) {
    if (s[who].jobs[label]) continue;
    const jobId = await order(who, label, opts);
    await checkIn(s[who].token, jobId);
    const otp = await codeFor(s[who].token, jobId);
    await release(A.token, otp, label === 'done2' ? 'shop_upi' : 'cash');
    if (end === 'jam') {
      await waitFor('jam', async () => (await studentJob(s[who].token, jobId))?.status === 'otp_verified', 30_000).catch(() => null);
      continue;
    }
    await waitFor('spooled', async () => {
      const q = await api('/api/shop/queue', { token: A.token });
      return q.data.jobs?.find((j) => j.id === jobId)?.spoolAcceptedAt;
    }, 30_000);
    if (end === 'printing') continue;
    await must('confirm printed', api(`/api/shop/jobs/${jobId}/confirm-print-completion`, { method: 'POST', token: A.token }));
    if (end === 'finishing' || end === 'ready') continue;
    await must('handover', api(`/api/shop/jobs/${jobId}/handover`, { method: 'POST', token: A.token }));
  }

  // Cancelled + prepared (not checked in) + absent.
  if (!s.kabir.jobs.cancelled) {
    const id = await order('kabir', 'cancelled', { pages: 4, name: 'Old-draft.pdf' });
    await must('cancel', api(`/api/jobs/${id}/cancel`, { method: 'POST', token: s.kabir.token }));
  }
  if (!s.aarav.jobs.scheduled) {
    const when = new Date(Date.now() + 20 * 3600_000);
    when.setMinutes(30, 0, 0);
    await order('aarav', 'scheduled', { pages: 9, name: 'Compiler-design-notes.pdf', mode: 'scheduled', scheduledTime: when.toISOString() });
  }
  if (!s.priya.jobs.prepared) await order('priya', 'prepared', { pages: 22, name: 'Thesis-chapter-1.pdf', specs: { duplex: true } });
  if (!s.kabir.jobs.absent) {
    const id = await order('kabir', 'absent', { pages: 4, name: 'Unit-test-answers.pdf' });
    await checkIn(s.kabir.token, id);
    await must('mark absent', api(`/api/shop/jobs/${id}/no-show`, { method: 'POST', token: A.token }));
  }
  // Meera stays brand new: no orders.
  console.log('orders ready');
}

if (stage === 'line') {
  // The live walk-in line (re-runnable right before screenshots: reveals expire).
  const s = state.students;
  const A = state.shopA;
  const line = [
    ['aarav', 'line', { pages: 12, name: 'DBMS-assignment-3.pdf', specs: { duplex: true } }],
    ['priya', 'line', { pages: 24, name: 'Physics-lab-record.pdf', specs: { color: true } }],
    ['rohan', 'line', { pages: 2, name: 'Resume-final.pdf', specs: { copies: 3 } }],
    ['sneha', 'line', { pages: 46, name: 'Project-report.pdf', specs: { binding: 'spiral_binding' } }],
    ['kabir', 'line', { pages: 8, name: 'Notes-unit-2.pdf' }],
    ['ananya', 'line', { pages: 18, name: 'Seminar-slides.pdf', specs: { color: true } }],
  ];
  for (const [who, label, opts] of line) {
    let id = s[who].jobs[label];
    const current = id ? await studentJob(s[who].token, id) : null;
    if (!current || !['awaiting_arrival', 'queued', 'notified'].includes(current.status)) {
      const { jobId } = await createOrder(s[who].token, A.slug, opts);
      s[who].jobs[label] = id = jobId;
      saveState(state);
    }
    await checkIn(s[who].token, id);
  }
  // Disarm the first student's absent timer (as a counter lookup would); keep the second one counting down.
  const first = await studentJob(s.aarav.token, s.aarav.jobs.line);
  if (first?.otpCode) await api('/api/shop/release', { method: 'POST', token: A.token, body: { otp: first.otpCode } });
  const q = await api('/api/shop/queue', { token: A.token });
  console.log((q.data.jobs ?? []).filter((j) => ['queued', 'notified'].includes(j.status)).map((j) => `${j.position}:${j.band}:${j.student.name}`).join('  '));
}
