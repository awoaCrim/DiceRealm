import { AdminPage } from './pages/AdminPage';
import { HomePage } from './pages/HomePage';
import { PlayerPage } from './pages/PlayerPage';

export function App() {
  const path = window.location.pathname;
  const [, route, id] = path.split('/');

  if (route === 'admin' && id) return <AdminPage roomId={id} />;
  if (route === 'player' && id) return <PlayerPage token={id} />;
  return <HomePage />;
}
