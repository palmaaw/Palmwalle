import { Navigate, Route, Routes } from 'react-router-dom';

import { usePos } from './state.js';
import { Login } from './screens/Login.js';
import { Pos } from './screens/Pos.js';
import { History } from './screens/History.js';

export function App(): JSX.Element {
  const { merchant } = usePos();

  return (
    <div className="phone pos">
      <div className="prototype-strip">SIMULATED PROTOTYPE — demo biometrics · no real money</div>
      <Routes>
        <Route path="/" element={merchant ? <Navigate to="/pos" replace /> : <Login />} />
        <Route path="/pos" element={merchant ? <Pos /> : <Navigate to="/" replace />} />
        <Route path="/history" element={merchant ? <History /> : <Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </div>
  );
}
