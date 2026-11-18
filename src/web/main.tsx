import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router-dom';
import { Toaster } from 'sonner';
import './styles.css';
import { queryClient } from './lib/api';
import { RequireAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { ConfirmProvider, Loading } from './components/ui';
import { LoginPage } from './pages/Login';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const MediaLibrary = lazy(() => import('./pages/MediaLibrary'));
const Playlists = lazy(() => import('./pages/Playlists'));
const PlaylistEditor = lazy(() => import('./pages/PlaylistEditor'));
const Devices = lazy(() => import('./pages/Devices'));
const DeviceDetail = lazy(() => import('./pages/DeviceDetail'));
const Schedules = lazy(() => import('./pages/Schedules'));
const History = lazy(() => import('./pages/History'));
const SettingsPage = lazy(() => import('./pages/Settings'));

const page = (el: React.ReactNode) => <Suspense fallback={<Loading />}>{el}</Suspense>;

const router = createBrowserRouter([
  { path: '/admin/login', element: <LoginPage /> },
  {
    path: '/admin',
    element: (
      <RequireAuth>
        <Layout />
      </RequireAuth>
    ),
    children: [
      { index: true, element: page(<Dashboard />) },
      { path: 'media', element: page(<MediaLibrary />) },
      { path: 'playlists', element: page(<Playlists />) },
      { path: 'playlists/:id', element: page(<PlaylistEditor />) },
      { path: 'devices', element: page(<Devices />) },
      { path: 'devices/:id', element: page(<DeviceDetail />) },
      { path: 'schedules', element: page(<Schedules />) },
      { path: 'history', element: page(<History />) },
      { path: 'settings', element: page(<SettingsPage />) },
      { path: '*', element: <Navigate to="/admin" replace /> },
    ],
  },
  { path: '*', element: <Navigate to="/admin" replace /> },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <RouterProvider router={router} />
      </ConfirmProvider>
      <Toaster position="top-right" richColors closeButton toastOptions={{ style: { fontFamily: 'inherit' } }} />
    </QueryClientProvider>
  </StrictMode>,
);
