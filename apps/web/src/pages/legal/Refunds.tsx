import { Link } from 'react-router-dom';
import LegalLayout from '../../components/LegalLayout.js';
import { LEGAL_PRODUCT_NAME } from '../../lib/legal.js';

export default function Refunds() {
  return (
    <LegalLayout
      path="/refunds"
      title="Cancellation & Refund Policy"
      summary="You pay the shop at the counter, so refunds are settled with the shop, with our support as backup."
    >
      <section>
        <h2>Short version</h2>
        <ul>
          <li>You pay the shop directly, after you arrive, by cash or the shop's own UPI.</li>
          <li>{LEGAL_PRODUCT_NAME} does not take your money online, so there is no online payment for us to refund.</li>
          <li>If something goes wrong with a print, talk to the shop at the counter first. If that does not work, contact us.</li>
        </ul>
      </section>

      <section>
        <h2>Cancelling an order</h2>
        <ul>
          <li>Use "Cancel job" on the order's status page. If you have not paid, nothing is owed.</li>
          <li>The document of a cancelled or expired order is deleted within about 10 minutes.</li>
          <li>If you do not check in or miss your turn, the shop may move your order back or cancel it.</li>
        </ul>
      </section>

      <section>
        <h2>Printing problems</h2>
        <p>If your print is wrong, unreadable or incomplete because of a printer fault or a shop error:</p>
        <ul>
          <li>Tell the shop before you leave. The shop can reprint it or return what you paid for the affected pages.</li>
          <li>Mistakes in your own file, such as wrong pages or the wrong colour option, are generally not the shop's fault, though many shops will help.</li>
        </ul>
      </section>

      <section>
        <h2>If you paid and are not happy</h2>
        <p>
          Refunds are made by the shop, the same way you paid: cash back or a UPI return. If the shop cannot or will not fix a genuine
          problem, <Link to="/support">contact support</Link> with the shop name and your order. We will look into it and escalate
          with the shop. Because the money was paid to the shop, we cannot guarantee an outcome.
        </p>
      </section>

      <section>
        <h2>If online payment is added later</h2>
        <p>If we start taking payments in the app, we will update this page first and explain how refunds work.</p>
      </section>
    </LegalLayout>
  );
}
