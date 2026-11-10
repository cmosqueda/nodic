import { useEffect, type ReactNode } from 'react';
import { IonApp } from '@ionic/react';
import { IonReactRouter } from '@ionic/react-router';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { WorkspaceProvider, useWorkspace } from './workspace-context';
import { AppShell } from '../shared/AppShell';
import { BoardPage } from '../features/tasks/BoardPage';
import { ChatPage } from '../features/chat/ChatPage';
import { MembersPage } from '../features/members/MembersPage';
import { NetworkPage } from '../features/sync-status/NetworkPage';
import { nativeSync, type DeepLinkData } from '../services/native-sync';
import { ErrorBoundary, FeedbackProvider, LoadingScreen } from '../shared/feedback';

function DeepLinkAndRouteSync() {
  const location = useLocation();
  const navigate = useNavigate();
  const { switchChannel, channel } = useWorkspace();

  // Sync active route to native service so it suppresses in-app notifications
  useEffect(() => {
    void nativeSync.setActiveRoute(location.pathname);
  }, [location.pathname]);

  // Handle incoming deep link data
  const handleDeepLink = async (data: DeepLinkData) => {
    if (!data.route) return;
    if (data.channelId && data.channelId !== channel?.id) {
      try {
        await switchChannel(data.channelId);
      } catch {
        // channel not loaded yet or invalid
      }
    }
    navigate(data.route);
  };

  // Check for cold-start deep link on startup and register runtime listener
  useEffect(() => {
    void nativeSync.getPendingDeepLink().then((pending) => {
      if (pending) {
        void handleDeepLink(pending);
      }
    });

    const handlePromise = nativeSync.onDeepLinkOpened((data) => {
      void handleDeepLink(data);
    });

    return () => {
      void handlePromise?.then((h) => h.remove());
    };
  }, [channel?.id]);

  return null;
}

/** Shows the splash until the local database is ready, and a recoverable error if it failed. */
function ReadyGate({ children }: { children: ReactNode }) {
  const { isReady, initError } = useWorkspace();
  if (!isReady) return <LoadingScreen />;
  if (initError) {
    return (
      <div className="nd-crash" role="alert">
        <h3>Nodic couldn't load your data</h3>
        <p>{initError}</p>
        <button className="dialog-btn-primary" onClick={() => window.location.reload()}>
          Reload app
        </button>
      </div>
    );
  }
  return <>{children}</>;
}

export default function App() {
  return (
    <ErrorBoundary>
    <IonApp>
      <FeedbackProvider>
      <WorkspaceProvider>
        <ReadyGate>
        <IonReactRouter>
          <DeepLinkAndRouteSync />
          <AppShell>
            <Routes>
              <Route path="/board" element={<BoardPage />} />
              <Route path="/chat" element={<ChatPage />} />
              <Route path="/members" element={<MembersPage />} />
              <Route path="/network" element={<NetworkPage />} />
              <Route path="*" element={<Navigate to="/board" replace />} />
            </Routes>
          </AppShell>
        </IonReactRouter>
        </ReadyGate>
      </WorkspaceProvider>
      </FeedbackProvider>
    </IonApp>
    </ErrorBoundary>
  );
}
