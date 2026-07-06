import { Route, Routes } from 'react-router-dom';
import Toasts from './components/Toasts.js';
import Welcome from './pages/student/Welcome.js';
import Login from './pages/student/Login.js';
import Home from './pages/student/Home.js';
import Profile from './pages/student/Profile.js';
import ShopLanding from './pages/student/ShopLanding.js';
import NewJob from './pages/student/NewJob.js';
import JobStatus from './pages/student/JobStatus.js';
import MyJobs from './pages/student/MyJobs.js';
import ShopLogin from './pages/shop/ShopLogin.js';
import ShopRegister from './pages/shop/ShopRegister.js';
import Dashboard from './pages/shop/Dashboard.js';
import Printers from './pages/shop/Printers.js';
import Agents from './pages/shop/Agents.js';

export default function App() {
  return (
    <>
      <Routes>
        {/* student */}
        <Route path="/" element={<Welcome />} />
        <Route path="/login" element={<Login />} />
        <Route path="/home" element={<Home />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="/jobs" element={<MyJobs />} />
        <Route path="/jobs/:id" element={<JobStatus />} />
        <Route path="/s/:slug" element={<ShopLanding />} />
        <Route path="/s/:slug/file/:fileId" element={<NewJob />} />
        {/* shop */}
        <Route path="/dashboard/login" element={<ShopLogin />} />
        <Route path="/dashboard/register" element={<ShopRegister />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/dashboard/printers" element={<Printers />} />
        <Route path="/dashboard/agents" element={<Agents />} />
      </Routes>
      <Toasts />
    </>
  );
}
