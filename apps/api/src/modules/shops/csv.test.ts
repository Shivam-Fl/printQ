import { describe, expect, it } from 'vitest';
import { csvCell } from './csv.js';

describe('history CSV cells', () => {
  it.each([
    ['=HYPERLINK("http://x","y")', `"'=HYPERLINK(""http://x"",""y"")"`],
    ['+91 cmd', "'+91 cmd"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tTabbed', "'\tTabbed"],
  ])('neutralises a formula-looking value %j', (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });

  it('leaves normal text and numbers alone, and still quotes commas and quotes', () => {
    expect(csvCell('Notes.pdf')).toBe('Notes.pdf');
    expect(csvCell('Ravi, Sharma')).toBe('"Ravi, Sharma"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('12.00')).toBe('12.00');
    expect(csvCell(-5)).toBe('-5');
  });
});
