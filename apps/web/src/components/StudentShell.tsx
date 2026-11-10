import type { ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { IconHome, IconJobs, IconPlus, IconUser } from './Icons.js';
import { lastShopSlug } from '../api.js';

/**
 * The bottom Print button follows the same rule as Home's New print: Home only offers
 * shops that are live right now, so a saved shop that was unpublished is never opened.
 */
export function resolveBottomNewPrintPath(_rememberedSlug: string | null): string {
  return '/home?pick=1';
}

/**
 * Wraps every logged-in student screen: content + a fixed bottom tab bar with
 * a raised "New print" action. This is the app's spine — no screen is a dead end.
 */
export default function StudentShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();

  function newPrint() {
    navigate(resolveBottomNewPrintPath(lastShopSlug()));
  }

  const cls = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : '');

  return (
    <div className="shell">
      <main className="student-main">{children}</main>
      <nav className="tabbar">
        <NavLink to="/home" className={cls}>
          <IconHome />
          Home
        </NavLink>
        <NavLink to="/jobs" className={cls}>
          <IconJobs />
          Jobs
        </NavLink>
        <button className="fab" onClick={newPrint} aria-label="New print">
          <span>
            <IconPlus />
          </span>
          <small>Print</small>
        </button>
        <NavLink to="/profile" className={cls}>
          <IconUser />
          Profile
        </NavLink>
      </nav>
    </div>
  );
}
