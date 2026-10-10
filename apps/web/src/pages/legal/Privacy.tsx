import { Link } from 'react-router-dom';
import LegalLayout from '../../components/LegalLayout.js';
import { GRIEVANCE_OFFICE_LOCATION, GRIEVANCE_OFFICER_NAME, LEGAL_ENTITY_NAME, LEGAL_PRODUCT_NAME, grievanceEmail } from '../../lib/legal.js';

export default function Privacy() {
  const gEmail = grievanceEmail();
  return (
    <LegalLayout
      path="/privacy"
      title="Privacy Policy"
      summary="What we collect, why, who helps us run the service, and how fast your documents disappear."
    >
      <section>
        <h2>Who we are</h2>
        <p>
          {LEGAL_PRODUCT_NAME}
          {LEGAL_ENTITY_NAME ? `, operated by ${LEGAL_ENTITY_NAME},` : ''} connects students with campus print shops.
          This page explains how we handle personal information when you use the app.
        </p>
      </section>

      <section>
        <h2>What we collect</h2>
        <ul>
          <li><strong>Phone number and name.</strong> Students sign in with a phone number (a one-time code sent through Firebase Phone Auth). You can add a name on your profile.</li>
          <li><strong>Your documents.</strong> Files you upload so a shop can print them, plus the print options you choose.</li>
          <li><strong>Order details.</strong> Shop, page count, options, price, status and timestamps, including when you arrived and when the shop confirmed payment and printing.</li>
          <li><strong>Location, only when you tap.</strong> "Near me" and arrival check-in ask your browser for your location once, at that moment. See below.</li>
          <li><strong>Notification address.</strong> If you turn on notifications, your browser gives us a push subscription so we can alert you about your turn.</li>
          <li><strong>Shop accounts.</strong> For shop owners and staff: email, shop name, address and counter location, printer set-up, and account activity.</li>
          <li><strong>Technical logs.</strong> Basic server logs used for security and fixing faults. Logs are configured to redact codes, passwords and tokens.</li>
        </ul>
        <p>A sign-in token is kept in your browser's storage so you stay signed in. We do not run advertising trackers.</p>
      </section>

      <section>
        <h2>Your documents</h2>
        <ul>
          <li>Files go to private storage. They are not public and are used only to print your order.</li>
          <li>The document, its converted copy and its preview are deleted about <strong>10 minutes after the shop confirms it was printed</strong>, or about 10 minutes after an order is cancelled or expires.</li>
          <li>A file that is never printed is deleted within <strong>24 hours</strong> at the latest.</li>
          <li>After deletion we keep only non-content order records (see "How long we keep data"). The stored file name is cleared.</li>
        </ul>
        <p>Deletion is automatic and reconciled every minute. If a technical fault delays it, we record the delay rather than silently keeping the file.</p>
      </section>

      <section>
        <h2>Location</h2>
        <p>
          Arrival check-in and "Near me" use a one-time location reading, taken when you ask. We do not track you, do not use your
          location in the background, and do not save your coordinates. We keep the time you arrived, not where you were.
        </p>
      </section>

      <section>
        <h2>Payment</h2>
        <p>
          You pay the shop directly, at the counter, by cash or the shop's own UPI. {LEGAL_PRODUCT_NAME} does not collect your card,
          UPI or bank details and does not take student payments online. We charge shops a commission; see the <Link to="/terms">Terms</Link>.
        </p>
      </section>

      <section>
        <h2>Who helps us run the service</h2>
        <p>We share only what each provider needs to do its job. We do not sell personal information.</p>
        <ul>
          <li><strong>Google (Firebase):</strong> phone sign-in and one-time codes. Google Cloud may also hold private document storage.</li>
          <li><strong>Supabase:</strong> our database, hosted in India (Mumbai).</li>
          <li><strong>Render:</strong> application hosting.</li>
          <li><strong>Vercel:</strong> web app hosting.</li>
          <li><strong>Resend:</strong> transactional email, such as shop password resets.</li>
          <li><strong>The print shop you choose:</strong> sees your order and your document so it can print it.</li>
        </ul>
        <p>Some providers may process data outside India under their own safeguards.</p>
      </section>

      <section>
        <h2>How long we keep data</h2>
        <ul>
          <li>Documents: minutes after printing, 24 hours at most, as above.</li>
          <li>Order records (no document content): kept as long as needed for accounting, shop statements, dispute handling and legal obligations.</li>
          <li>Account details: until you ask us to delete the account, unless we must keep something by law.</li>
        </ul>
      </section>

      <section>
        <h2>Your rights</h2>
        <p>
          You can ask us to show you the personal information we hold, correct it, or delete your account and related data. You can
          switch off notifications in your browser settings and location in your device settings at any time. Some order records may
          have to be kept for legal or accounting reasons.
        </p>
        <p>Send requests through the <Link to="/support">Support page</Link>.</p>
      </section>

      <section>
        <h2>Children</h2>
        <p>The service is meant for people who can enter into a contract under Indian law. If you are under 18, use it with a parent or guardian's consent.</p>
      </section>

      <section>
        <h2>Grievance Officer</h2>
        {GRIEVANCE_OFFICER_NAME || gEmail ? (
          <p>
            {GRIEVANCE_OFFICER_NAME && <>Name: {GRIEVANCE_OFFICER_NAME}<br /></>}
            {GRIEVANCE_OFFICE_LOCATION && <>Office: {GRIEVANCE_OFFICE_LOCATION}<br /></>}
            {gEmail && <>Email: <a href={`mailto:${gEmail}`}>{gEmail}</a></>}
          </p>
        ) : (
          <p>Our Grievance Officer's name and contact details are being added to this page.</p>
        )}
      </section>

      <section>
        <h2>Changes</h2>
        <p>If we change this policy we will update the date above.</p>
      </section>
    </LegalLayout>
  );
}
