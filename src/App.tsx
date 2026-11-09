import { ConfigError } from './components/ConfigError';
import { ErrorBoundary } from './components/ErrorBoundary';
import { FullScreenLoader } from './components/Spinner';
import { configProblem } from './lib/env';
import { AuthProvider, useAuth } from './features/auth/AuthProvider';
import { LoginPage } from './features/auth/LoginPage';
import { RoomPage } from './features/room/RoomPage';

function Gate() {
  const { session, loading } = useAuth();
  if (loading) return <FullScreenLoader label="Yükleniyor…" />;
  if (!session) return <LoginPage />;
  return <RoomPage key={session.user.id} user={session.user} />;
}

export default function App() {
  if (configProblem) return <ConfigError problem={configProblem} />;
  return (
    <ErrorBoundary>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </ErrorBoundary>
  );
}
