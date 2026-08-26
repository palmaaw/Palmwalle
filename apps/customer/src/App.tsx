/**
 * App shell + routes. Bottom tab navigation appears once signed in.
 */

import { Navigate, NavLink, Outlet, Route, Routes } from 'react-router-dom';

import { useSession } from './state.js';
import { Welcome } from './screens/Welcome.js';
import { EnrollIntro, EnrollSuccess } from './screens/Enroll.js';
import { Home } from './screens/Home.js';
import { History, Receipt } from './screens/History.js';
import { Settings } from './screens/Settings.js';

export function App(): JSX.Element {
  const { customer } = useSession();

  const guarded = (el: JSX.Element): JSX.Element => (customer ? el : <Navigate to="/" replace />);

  return (
    <div className="phone">
      <div className="prototype-strip">SIMULATED PROTOTYPE — demo biometrics · no real money</div>

      <Routes>
        <Route path="/" element={customer ? <Navigate to="/home" replace /> : <Welcome />} />
        <Route path="/enroll/intro" element={guarded(<EnrollIntro />)} />
        <Route path="/enroll/success" element={guarded(<EnrollSuccess />)} />
        <Route element={<TabLayout />}>
          <Route path="/home" element={guarded(<Home />)} />
          <Route path="/history" element={guarded(<History />)} />
          <Route path="/receipt/:ref" element={guarded(<Receipt />)} />
          <Route path="/settings" element={guarded(<Settings />)} />
        </Route>
        <Route path="*" element={<Navigate to={customer ? '/home' : '/'} replace />} />
      </Routes>
    </div>
  );
}

function TabLayout(): JSX.Element {
  return (
    <>
      <main className="tab-main">
        <Outlet />
      </main>
      <nav className="tabbar">
        <NavLink to="/home">Wallet</NavLink>
        <NavLink to="/history">Activity</NavLink>
        <NavLink to="/settings">Settings</NavLink>
      </nav>
    </>
  );
}
