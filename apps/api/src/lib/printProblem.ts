/**
 * Raw `Job.printError` strings come from agents and the dispatcher (driver
 * messages, file paths, HTTP codes). They are kept for the audit trail only and
 * must never reach an API response or a staff screen: map them to a stable code
 * and a friendly sentence instead.
 */
export const PRINT_ERROR_AGENT_OFFLINE = 'agent_offline';
export const PRINT_ERROR_NO_AGENT = 'No connected print agent is online for this printer.';

export type PrintProblemCode = 'agent_offline' | 'no_agent' | 'printer_not_linked' | 'printer_error';

export interface PrintProblem {
  code: PrintProblemCode;
  message: string;
}

const MESSAGES: Record<PrintProblemCode, string> = {
  agent_offline:
    'The print computer stopped responding while printing this job. Check the paper tray, then retry on this or another computer, or cancel and return the payment.',
  no_agent: 'No connected print computer is online for this printer. Start the PrintQ app on the shop computer, then retry.',
  printer_not_linked: 'This printer is not linked to a computer printer yet. Link it in Setup, then retry.',
  printer_error: 'The printer reported a problem. Check the printer, then retry the print.',
};

export function describePrintProblem(raw: string | null | undefined): PrintProblem | null {
  if (!raw) return null;
  let code: PrintProblemCode = 'printer_error';
  if (raw === PRINT_ERROR_AGENT_OFFLINE) code = 'agent_offline';
  else if (raw === PRINT_ERROR_NO_AGENT) code = 'no_agent';
  else if (/not linked to an OS printer/i.test(raw)) code = 'printer_not_linked';
  return { code, message: MESSAGES[code] };
}

/** Student-facing wording: no instructions aimed at shop staff. */
export const STUDENT_PRINT_PROBLEM_MESSAGE = 'Your print hit a problem at the shop — the shop is retrying.';
