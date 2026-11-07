/**
 * One CSV cell. Text that a spreadsheet would run as a formula (student names
 * and file names are student-typed) gets a leading apostrophe, so Excel/Sheets
 * show it as plain text instead of executing it.
 */
export function csvCell(value: string | number): string {
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
