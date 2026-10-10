import { Link } from 'react-router-dom';
import LegalLayout from '../../components/LegalLayout.js';
import {
  LEGAL_ENTITY_DESCRIPTION,
  LEGAL_ENTITY_NAME,
  LEGAL_REGISTERED_ADDRESS,
  SUPPORT_EMAIL,
  SUPPORT_HOURS,
  SUPPORT_PHONE,
  supportEmailHref,
} from '../../lib/legal.js';

export default function Support() {
  const emailHref = supportEmailHref();
  const hasContact = Boolean(SUPPORT_EMAIL || SUPPORT_PHONE);
  return (
    <LegalLayout
      path="/support"
      title="Support & contact"
      summary="Quick answers first, then how to reach us."
      dated={false}
    >
      <section>
        <h2>Quick answers</h2>
        <dl className="legal-faq">
          <dt>My print came out wrong.</dt>
          <dd>Tell the shop at the counter before you leave. See the <Link to="/refunds">refund policy</Link>.</dd>
          <dt>How do I pay?</dt>
          <dd>At the shop, by cash or the shop's own UPI. There is no online payment in the app.</dd>
          <dt>Is my document safe?</dt>
          <dd>It sits in private storage and is deleted about 10 minutes after printing. Read the <Link to="/privacy">privacy policy</Link>.</dd>
          <dt>I run a shop. How do I pay my PrintQs fee?</dt>
          <dd>Open Earnings in your dashboard and choose Pay now. Fees are due 7 days after each weekly statement; unpaid fees temporarily pause new orders until you pay. Your receipt is saved there.</dd>
          <dt>I did not get the sign-in code.</dt>
          <dd>Check the number, wait a minute, then request a new code. If it still fails, contact us below.</dd>
          <dt>I want my account or data deleted.</dt>
          <dd>Contact us below from the phone number on the account.</dd>
        </dl>
      </section>

      <section>
        <h2>Contact us</h2>
        {hasContact ? (
          <ul className="legal-contact">
            {SUPPORT_EMAIL && <li>Email: <a href={emailHref ?? undefined}>{SUPPORT_EMAIL}</a></li>}
            {SUPPORT_PHONE && <li>Phone: <a href={`tel:${SUPPORT_PHONE.replace(/\s+/g, '')}`}>{SUPPORT_PHONE}</a></li>}
            {SUPPORT_HOURS && <li>Hours: {SUPPORT_HOURS}</li>}
          </ul>
        ) : (
          <p>Our support email and phone details are being added to this page. Until then, the quickest help is the shop counter.</p>
        )}
        <p className="dim">Include the shop name and, if you have it, your order's status page link. Never send a sign-in code to anyone.</p>
      </section>

      {(LEGAL_ENTITY_NAME || LEGAL_REGISTERED_ADDRESS) && (
        <section>
          <h2>Business details</h2>
          <p>
            {LEGAL_ENTITY_DESCRIPTION}
            {LEGAL_REGISTERED_ADDRESS && <><br />{LEGAL_REGISTERED_ADDRESS}</>}
          </p>
        </section>
      )}

      <section>
        <h2>Policies</h2>
        <p><Link to="/privacy">Privacy</Link>, <Link to="/terms">Terms</Link> and <Link to="/refunds">Cancellation &amp; Refunds</Link>.</p>
      </section>
    </LegalLayout>
  );
}
