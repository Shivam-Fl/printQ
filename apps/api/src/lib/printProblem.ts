/**
 * Raw `Job.printError` strings come from agents and the dispatcher (driver
 * messages, file paths, HTTP codes). They are kept for the audit trail only and
 * must never reach an API response or a staff screen: map them to a stable code
 * and a friendly sentence instead.
 */
export const PRINT_ERROR_AGENT_OFFLINE = 'agent_offline';
export const PRINT_ERROR_AGENT_RESTARTED = 'agent_restarted';
export const PRINT_ERROR_CLAIM_TIMEOUT = 'claim_timeout';
export const PRINT_ERROR_SPOOL_TIMEOUT = 'spool_timeout';
/** Failures that always wait for a staff decision (never auto re-dispatched to an agent). */
export const STAFF_DECISION_PRINT_ERRORS = [
  PRINT_ERROR_AGENT_OFFLINE,
  PRINT_ERROR_AGENT_RESTARTED,
  PRINT_ERROR_CLAIM_TIMEOUT,
  PRINT_ERROR_SPOOL_TIMEOUT,
] as const;
export const PRINT_ERROR_NO_AGENT = 'No connected print agent is online for this printer.';

export type PrintProblemCode = 'agent_offline' | 'agent_restarted' | 'claim_timeout' | 'spool_timeout' | 'no_agent' | 'printer_not_linked' | 'printer_error';

export interface PrintProblem {
  code: PrintProblemCode;
  message: string;
}

/** Short, staff-facing: what happened, then what to check. The buttons say "Printed OK" and "Print again". */
const MESSAGES: Record<PrintProblemCode, string> = {
  agent_offline: 'The counter PC stopped responding while printing. If nothing came out, print it again.',
  agent_restarted: 'PrintQs Shop restarted on the counter PC while printing. If nothing came out, print it again.',
  claim_timeout: 'This print never reached the printer. Print it again.',
  spool_timeout: 'Nobody confirmed this print in time. Check the printer: if the pages came out, press Printed OK. If not, print it again.',
  no_agent: 'No counter PC is online for this printer. Open PrintQs Shop on the counter PC, then print again.',
  printer_not_linked: 'This printer is not linked to a Windows printer yet. Link it in Printers, then print again.',
  printer_error: 'The printer reported a problem. Check it, then print again.',
};

export function describePrintProblem(raw: string | null | undefined): PrintProblem | null {
  if (!raw) return null;
  let code: PrintProblemCode = 'printer_error';
  if (raw === PRINT_ERROR_AGENT_OFFLINE) code = 'agent_offline';
  else if (raw === PRINT_ERROR_AGENT_RESTARTED) code = 'agent_restarted';
  else if (raw === PRINT_ERROR_CLAIM_TIMEOUT) code = 'claim_timeout';
  else if (raw === PRINT_ERROR_SPOOL_TIMEOUT) code = 'spool_timeout';
  else if (raw === PRINT_ERROR_NO_AGENT) code = 'no_agent';
  else if (/not linked to an OS printer/i.test(raw)) code = 'printer_not_linked';
  return { code, message: MESSAGES[code] };
}

/** Student-facing wording: no instructions aimed at shop staff. */
export const STUDENT_PRINT_PROBLEM_MESSAGE = 'Your print hit a problem at the shop — the shop is retrying.';
