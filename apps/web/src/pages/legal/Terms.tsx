import { Link } from 'react-router-dom';
import LegalLayout from '../../components/LegalLayout.js';
import { GOVERNING_LAW_CITY, LEGAL_ENTITY_DESCRIPTION, LEGAL_PRODUCT_NAME } from '../../lib/legal.js';

/** The PrintQs fee added on top of the shop's price (the API's PLATFORM_MARKUP_BPS, 2500 = 25%). */
export const PLATFORM_FEE_PERCENT = 25;

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
          print shop that uses {LEGAL_PRODUCT_NAME}. Any print shop can register, on a campus or not. The printing is done by the shop,
          which is an independent business. By using the app, or by registering a shop, you accept these terms.
        </p>
      </section>

      <section>
        <h2>Your account</h2>
        <ul>
          <li>Students sign in with a phone number you control. Keep your phone and codes to yourself.</li>
          <li>Shop owners register with an email and password. Keep the password private.</li>
          <li>Give accurate details, and tell us if you think someone else is using your account.</li>
        </ul>
      </section>

      <section>
        <h2>How an order works</h2>
        <ul>
          <li>You upload a file, choose options and see a price. {LEGAL_PRODUCT_NAME} calculates the price from the shop's rates and your options.</li>
          <li>
            The price is the shop's rate plus a {LEGAL_PRODUCT_NAME} fee, currently {PLATFORM_FEE_PERCENT}% of the shop's rate. You see the
            full price before you place the order, and you pay nothing more than that.
          </li>
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
          <li>Any print shop can register itself online. Shops run their own counter, printers and rates, and are responsible for print quality and for handling documents properly.</li>
          <li>
            Students pay the shop's rate plus a {LEGAL_PRODUCT_NAME} platform fee, currently {PLATFORM_FEE_PERCENT}% of the shop's rate.
            Students see this full price before they order. By registering, the shop owner accepts this fee.
          </li>
          <li>
            The shop collects the full price from the student at the counter. For each paid and printed order, the {LEGAL_PRODUCT_NAME} fee
            is added to the shop's account. Fees are totalled into a weekly statement, which the owner pays from the shop dashboard
            within 7 days of the statement date.
          </li>
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
