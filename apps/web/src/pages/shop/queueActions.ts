/** Which recovery buttons the counter dashboard shows for one in-flight job. */
export interface ActionJob {
  status: string;
  printError: string | null;
  printAgentOffline?: boolean;
  paymentProvider: string | null;
  counterPaymentConfirmedAt: string | null;
}

const counterPaid = (j: ActionJob) => j.paymentProvider === 'pay_at_shop' && Boolean(j.counterPaymentConfirmedAt);

export function jobActions(j: ActionJob) {
  const failedPrint = j.status === 'otp_verified' && Boolean(j.printError);
  const orphanedPrint = j.status === 'printing' && Boolean(j.printAgentOffline);
  return {
    /** "Retry print" on a failed print / "retry on another computer" when the computer died mid-print. */
    retry: failedPrint || orphanedPrint,
    /** Counter refund: the shop physically returns the money and closes the order. */
    paymentReturned: (failedPrint || orphanedPrint) && counterPaid(j),
    confirmPrinted: j.status === 'printing',
    needsAttention: Boolean(j.printError) || orphanedPrint,
  };
}
