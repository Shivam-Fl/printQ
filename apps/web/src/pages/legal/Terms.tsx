import { Link } from 'react-router-dom';
import LegalLayout from '../../components/LegalLayout.js';
import { GOVERNING_LAW_CITY, LEGAL_ENTITY_DESCRIPTION, LEGAL_PRODUCT_NAME } from '../../lib/legal.js';

export default function Terms() {
  return (
    <LegalLayout
      path="/terms"
      title="Terms of Use"
      summary="The ground rules for students and print shops using PrintQs."
    >
      <section>
        <h2>The service</h2>
        <p>
          {LEGAL_PRODUCT_NAME}
          {LEGAL_ENTITY_DESCRIPTION ? ` (operated by ${LEGAL_ENTITY_DESCRIPTION})` : ''} lets you prepare a print order online and collect it from a
          participating campus print shop. The printing is done by the shop, which is an independent business. By using the app you
          accept these terms.
        </p>
      </section>

      <section>
        <h2>Your account</h2>
        <ul>
          <li>Students sign in with a phone number you control. Keep your phone and codes to yourself.</li>
          <li>Give accurate details, and tell us if you think someone else is using your account.</li>
        </ul>
      </section>

      <section>
        <h2>How an order works</h2>
        <ul>
          <li>You upload a file, choose options and see a price. {LEGAL_PRODUCT_NAME} calculates the price from the shop's rates and your options.</li>
          <li>Your place in the live line starts only after you check in at the shop.</li>
          <li>You pay the shop at the counter, by cash or the shop's own UPI. {LEGAL_PRODUCT_NAME} does not take student payments online.</li>
          <li>If you miss your turn, the order can be moved back or cancelled.</li>
        </ul>
      </section>

      <section>
        <h2>What you may upload</h2>
        <p>
          Upload only documents you have the right to print. Do not upload anything unlawful, infringing or harmful. We may refuse
          files and suspend accounts that break this rule. Files are deleted automatically soon after printing; see the{' '}
          <Link to="/privacy">Privacy Policy</Link>.
        </p>
      </section>

      <section>
        <h2>Print shops</h2>
        <ul>
          <li>Shops run their own counter, printers and rates, and are responsible for print quality and for handling documents properly.</li>
          <li>{LEGAL_PRODUCT_NAME} charges shops a commission under the arrangement agreed with each shop. The commission rate is the one the shop owner supplied or agreed to.</li>
          <li>Commission is totalled into a weekly statement. The shop owner pays it online from the shop dashboard within 7 days of the statement date.</li>
          <li>If a statement stays unpaid after its due date, {LEGAL_PRODUCT_NAME} may temporarily pause the shop for new orders. Orders already placed continue, and the shop reopens as soon as the unpaid amount is paid.</li>
          <li>Shops must not keep, copy or share a customer's document.</li>
        </ul>
      </section>

      <section>
        <h2>Cancellations and refunds</h2>
        <p>See the <Link to="/refunds">Cancellation &amp; Refund Policy</Link>.</p>
      </section>

      <section>
        <h2>Availability and liability</h2>
        <ul>
          <li>We work to keep the service running but cannot promise it is always available or error-free, and shops may go offline.</li>
          <li>To the extent the law allows, {LEGAL_PRODUCT_NAME} is not liable for indirect losses or for how a shop prints your order.</li>
          <li>Nothing here limits rights you have under Indian consumer law.</li>
        </ul>
      </section>

      <section>
        <h2>Ending use</h2>
        <p>You can stop using the app at any time and ask us to delete your account. We can suspend accounts that misuse the service.</p>
      </section>

      <section>
        <h2>Governing law</h2>
        <p>
          These terms are governed by the laws of India
          {GOVERNING_LAW_CITY ? `, and the courts at ${GOVERNING_LAW_CITY} have jurisdiction` : ''}.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>Questions about these terms: see <Link to="/support">Support</Link>.</p>
      </section>
    </LegalLayout>
  );
}
