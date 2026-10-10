import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import ErrorBoundary from './components/ErrorBoundary.js';
import SessionGuard from './components/SessionGuard.js';
import { titleForPath } from './lib/routeTitles.js';
import Toasts from './components/Toasts.js';
import EnvironmentBanner from './components/EnvironmentBanner.js';
import Welcome from './pages/student/Welcome.js';
const Login = lazy(() => import('./pages/student/Login.js'));
const Home = lazy(() => import('./pages/student/Home.js'));
const Profile = lazy(() => import('./pages/student/Profile.js'));
const ShopLanding = lazy(() => import('./pages/student/ShopLanding.js'));
const ShopDirectory = lazy(() => import('./pages/student/ShopDirectory.js'));
const NewJob = lazy(() => import('./pages/student/NewJob.js'));
const JobStatus = lazy(() => import('./pages/student/JobStatus.js'));
const MyJobs = lazy(() => import('./pages/student/MyJobs.js'));
const ShopLogin = lazy(() => import('./pages/shop/ShopLogin.js'));
const ShopRegister = lazy(() => import('./pages/shop/ShopRegister.js'));
const Dashboard = lazy(() => import('./pages/shop/Dashboard.js'));
const Printers = lazy(() => import('./pages/shop/Printers.js'));
const Agents = lazy(() => import('./pages/shop/Agents.js'));
const Settings = lazy(() => import('./pages/shop/Settings.js'));
const Insights = lazy(() => import('./pages/shop/Insights.js'));
const History = lazy(() => import('./pages/shop/History.js'));
const ShopSetup = lazy(() => import('./pages/shop/ShopSetup.js'));
const Earnings = lazy(() => import('./pages/shop/Earnings.js'));
const FeeReceipt = lazy(() => import('./pages/shop/FeeReceipt.js'));
const AdminLogin = lazy(() => import('./pages/admin/AdminLogin.js'));
const AdminConsole = lazy(() => import('./pages/admin/AdminConsole.js'));
const Privacy = lazy(() => import('./pages/legal/Privacy.js'));
const Terms = lazy(() => import('./pages/legal/Terms.js'));
const Refunds = lazy(() => import('./pages/legal/Refunds.js'));
const Support = lazy(() => import('./pages/legal/Support.js'));
import NotFound from './pages/legal/NotFound.js';

function RouteMeta() {
  const { pathname } = useLocation();
  useEffect(() => {
    document.title = titleForPath(pathname);
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (canonical) canonical.href = `https://printqs.com${pathname === '/' ? '/' : pathname.replace(/\/+$/, '')}`;
  }, [pathname]);
  return null;
}

function RouteFallback() {
  return (
    <div className="page" role="status" aria-live="polite">
      <div className="skeleton-list" aria-hidden>
        <div className="skeleton-card" />
        <div className="skeleton-card" />
      </div>
    </div>
  );
}

export default function App() {
  const { pathname } = useLocation();
  return (
    <>
      <RouteMeta />
      <EnvironmentBanner />
      {/* keyed per path: navigating away from a crashed page recovers without a reload */}
      <ErrorBoundary key={pathname} level="route">
      <Suspense fallback={<RouteFallback />}>
      <Routes>
        {/* student */}
        <Route path="/" element={<Welcome />} />
        <Route path="/login" element={<Login />} />
        <Route path="/home" element={<Home />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/jobs" element={<MyJobs />} />
        <Route path="/jobs/:id" element={<JobStatus />} />
        <Route path="/shops" element={<ShopDirectory />} />
        <Route path="/s/:slug" element={<ShopLanding />} />
        <Route path="/s/:slug/file/:fileId" element={<NewJob />} />
        {/* shop */}
        <Route path="/dashboard/login" element={<ShopLogin />} />
        <Route path="/dashboard/register" element={<ShopRegister />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/dashboard/insights" element={<Insights />} />
        <Route path="/dashboard/earnings" element={<Earnings />} />
        <Route path="/dashboard/earnings/receipt/:id" element={<FeeReceipt />} />
        <Route path="/dashboard/history" element={<History />} />
        <Route path="/dashboard/setup" element={<ShopSetup />} />
        <Route path="/dashboard/printers" element={<Printers />} />
        <Route path="/dashboard/agents" element={<Agents />} />
        <Route path="/dashboard/settings" element={<Settings />} />
        {/* platform administration: separately authenticated from any shop */}
        <Route path="/admin/login" element={<AdminLogin />} />
        <Route path="/admin" element={<AdminConsole />} />
        {/* public legal + support pages */}
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/terms" element={<Terms />} />
        <Route path="/refunds" element={<Refunds />} />
        <Route path="/support" element={<Support />} />
        <Route path="/contact" element={<Navigate to="/support" replace />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
      </Suspense>
      </ErrorBoundary>
      <SessionGuard />
      <Toasts />
    </>
  );
}
