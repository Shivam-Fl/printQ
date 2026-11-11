// Refresh the owners' shop sessions in $UX_SCRATCH/state.json (local dev API only).
import { api, must, loadState, saveState } from './lib.mjs';
const state = loadState();
for (const key of ['shopA', 'shopB', 'shopC']) {
  const s = state[key];
  if (!s?.email) continue;
  const r = await must(`login ${key}`, api('/api/auth/shop/login', { method: 'POST', body: { email: s.email, password: s.password } }));
  s.token = r.token;
  console.log(key, 'session refreshed');
}
saveState(state);
