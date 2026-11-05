import { IonApp, IonRouterOutlet } from '@ionic/react';
import { IonReactRouter } from '@ionic/react-router';
import { Navigate, Route, Routes } from 'react-router-dom';
import { WorkspaceProvider } from './workspace-context';
import { AppShell } from '../shared/AppShell';
import { BoardPage } from '../features/tasks/BoardPage';
import { ChatPage } from '../features/chat/ChatPage';
import { MembersPage } from '../features/members/MembersPage';
import { NetworkPage } from '../features/sync-status/NetworkPage';

export default function App() {
  return (
    <IonApp>
      <WorkspaceProvider>
        <IonReactRouter>
          <AppShell>
            <IonRouterOutlet id="main-content">
              <Routes>
                <Route path="/board" element={<BoardPage />} />
                <Route path="/chat" element={<ChatPage />} />
                <Route path="/members" element={<MembersPage />} />
                <Route path="/network" element={<NetworkPage />} />
                <Route path="*" element={<Navigate to="/board" replace />} />
              </Routes>
            </IonRouterOutlet>
          </AppShell>
        </IonReactRouter>
      </WorkspaceProvider>
    </IonApp>
  );
}
