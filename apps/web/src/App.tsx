import { Navigate, Route, Routes } from 'react-router-dom';
import ShopLanding from './pages/student/ShopLanding.js';
import NewJob from './pages/student/NewJob.js';
import JobStatus from './pages/student/JobStatus.js';
import MyJobs from './pages/student/MyJobs.js';
import ShopLogin from './pages/shop/ShopLogin.js';
import Dashboard from './pages/shop/Dashboard.js';
import Printers from './pages/shop/Printers.js';
import Agents from './pages/shop/Agents.js';

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/s/demo" replace />} />
      <Route path="/s/:slug" element={<ShopLanding />} />
      <Route path="/s/:slug/file/:fileId" element={<NewJob />} />
      <Route path="/jobs" element={<MyJobs />} />
      <Route path="/jobs/:id" element={<JobStatus />} />
      <Route path="/dashboard/login" element={<ShopLogin />} />
      <Route path="/dashboard" element={<Dashboard />} />
      <Route path="/dashboard/printers" element={<Printers />} />
      <Route path="/dashboard/agents" element={<Agents />} />
    </Routes>
  );
}
