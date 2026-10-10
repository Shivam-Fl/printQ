import { Navigate, Route, Routes } from 'react-router-dom';
import SessionGuard from './components/SessionGuard.js';
import Toasts from './components/Toasts.js';
import EnvironmentBanner from './components/EnvironmentBanner.js';
import Welcome from './pages/student/Welcome.js';
import Login from './pages/student/Login.js';
import Home from './pages/student/Home.js';
import Profile from './pages/student/Profile.js';
import ShopLanding from './pages/student/ShopLanding.js';
import ShopDirectory from './pages/student/ShopDirectory.js';
import NewJob from './pages/student/NewJob.js';
import JobStatus from './pages/student/JobStatus.js';
import MyJobs from './pages/student/MyJobs.js';
import ShopLogin from './pages/shop/ShopLogin.js';
import ShopRegister from './pages/shop/ShopRegister.js';
import Dashboard from './pages/shop/Dashboard.js';
import Printers from './pages/shop/Printers.js';
import Agents from './pages/shop/Agents.js';
import Settings from './pages/shop/Settings.js';
import Insights from './pages/shop/Insights.js';
import History from './pages/shop/History.js';
import ShopSetup from './pages/shop/ShopSetup.js';
import Earnings from './pages/shop/Earnings.js';
import AdminLogin from './pages/admin/AdminLogin.js';
import AdminConsole from './pages/admin/AdminConsole.js';
import Privacy from './pages/legal/Privacy.js';
import Terms from './pages/legal/Terms.js';
import Refunds from './pages/legal/Refunds.js';
import Support from './pages/legal/Support.js';
import NotFound from './pages/legal/NotFound.js';

export default function App() {
  return (
    <>
      <EnvironmentBanner />
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
      <SessionGuard />
      <Toasts />
    </>
  );
}
