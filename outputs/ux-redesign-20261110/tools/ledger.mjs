// Interaction ledger: performs a task through Playwright and records every
// user-level operation, so "before" and "after" are measured the same way.
// KLM (keystroke-level model) operator times, seconds (Card, Moran & Newell):
//   M mental prep 1.35, P point 1.1, B button press+release 0.2, H home hands 0.4,
//   K keystroke 0.3 (digits / short words, average typist), S scroll-and-find 1.5.
export const KLM = { M: 1.35, P: 1.1, B: 0.2, H: 0.4, K: 0.3, S: 1.5 };

export class Ledger {
  constructor(page, name) {
    this.page = page;
    this.name = name;
    this.ops = [];
    this.hand = 'mouse';
    this.fields = new Set();
    this.t0 = Date.now();
    this.dialogs = 0;
    page.on('dialog', (d) => { this.ops.push({ op: 'dialog', label: d.message().slice(0, 60) }); this.dialogs += 1; void d.accept(); });
  }

  async visible(locator) {
    await locator.waitFor({ state: 'visible', timeout: 20_000 });
    const box = await locator.boundingBox();
    const vp = this.page.viewportSize();
    const offY = !box || box.y < 0 || box.y + box.height > vp.height;
    const offX = box && (box.x < 0 || box.x + box.width > vp.width);
    if (offY || offX) {
      this.ops.push({ op: 'scroll', label: offX ? 'horizontal scroll to reach target' : 'bring target on screen' });
      await locator.scrollIntoViewIfNeeded();
    }
  }

  async click(locator, label) {
    await this.visible(locator);
    this.ops.push({ op: 'click', label, fromKeyboard: this.hand === 'keys' });
    this.hand = 'mouse';
    await locator.click();
  }

  /** Taps a control on a touch screen (same cost model as a click, no hand switch). */
  async tap(locator, label) { return this.click(locator, label); }

  async type(locator, text, label) {
    await this.visible(locator);
    const focused = await locator.evaluate((el) => el === document.activeElement);
    if (!focused) await this.click(locator, `focus ${label}`);
    this.ops.push({ op: 'type', label, chars: text.length, fromMouse: this.hand === 'mouse' });
    this.hand = 'keys';
    this.fields.add(label);
    await locator.pressSequentially(text, { delay: 15 });
  }

  async fill(locator, text, label) {
    // replace an existing value: select-all + type
    await this.visible(locator);
    const focused = await locator.evaluate((el) => el === document.activeElement);
    if (!focused) await this.click(locator, `focus ${label}`);
    this.ops.push({ op: 'key', key: 'select-all', fromMouse: this.hand === 'mouse' });
    this.hand = 'keys';
    await locator.press('Control+A');
    this.ops.push({ op: 'type', label, chars: text.length, fromMouse: false });
    this.fields.add(label);
    await locator.pressSequentially(text, { delay: 15 });
  }

  async select(locator, value, label) {
    await this.visible(locator);
    this.ops.push({ op: 'click', label: `open ${label}`, fromKeyboard: this.hand === 'keys' });
    this.ops.push({ op: 'click', label: `choose ${value}`, fromKeyboard: false });
    this.hand = 'mouse';
    this.fields.add(label);
    await locator.selectOption(value);
  }

  async press(key, label = key) {
    this.ops.push({ op: 'key', key: label, fromMouse: this.hand === 'mouse' });
    this.hand = 'keys';
    await this.page.keyboard.press(key);
  }

  /** Choosing a file in the OS picker: counted, but excluded from time targets. */
  async pickFile(trigger, files, label = 'choose file') {
    const [chooser] = await Promise.all([this.page.waitForEvent('filechooser'), this.click(trigger, label)]);
    this.ops.push({ op: 'file', label: 'OS file picker' });
    await chooser.setFiles(files);
  }

  note(label) { this.ops.push({ op: 'note', label }); }

  summary(extra = {}) {
    let klm = 0;
    let clicks = 0; let keys = 0; let scrolls = 0; let taps = 0;
    for (const o of this.ops) {
      if (o.op === 'click') { clicks += 1; klm += KLM.M + KLM.P + KLM.B + (o.fromKeyboard ? KLM.H : 0); }
      if (o.op === 'type') { keys += o.chars; klm += (o.fromMouse ? KLM.H : 0) + KLM.M + o.chars * KLM.K; }
      if (o.op === 'key') { keys += 1; klm += (o.fromMouse ? KLM.H : 0) + KLM.K; }
      if (o.op === 'scroll') { scrolls += 1; klm += KLM.S; }
      if (o.op === 'dialog') { clicks += 1; klm += KLM.M + KLM.P + KLM.B; }
    }
    taps = clicks;
    return {
      task: this.name,
      clicksOrTaps: taps,
      keystrokes: keys,
      fields: this.fields.size,
      scrolls,
      dialogs: this.dialogs,
      klmSeconds: Math.round(klm * 10) / 10,
      scriptedWallSeconds: Math.round((Date.now() - this.t0) / 100) / 10,
      ops: this.ops,
      ...extra,
    };
  }
}
