import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, useLocation } from 'react-router-dom';
import { api, ApiError } from './api';
import { connectRealtime, disconnectRealtime } from './realtime';
import { Loading } from '../components/ui';

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  username: string | null;
  role: 'ADMIN' | 'EDITOR';
  canPublish: boolean;
}

const AuthCtx = createContext<{ user: CurrentUser; logout: () => Promise<void> } | null>(null);

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error('useAuth fora do AuthProvider');
  return ctx;
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return (await api<{ user: CurrentUser }>('/api/auth/me')).user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { data: user, isLoading, error } = useMe();
  const qc = useQueryClient();
  const location = useLocation();

  useEffect(() => {
    const onUnauthorized = () => qc.setQueryData(['me'], null);
    window.addEventListener('gd:unauthorized', onUnauthorized);
    return () => window.removeEventListener('gd:unauthorized', onUnauthorized);
  }, [qc]);

  useEffect(() => {
    if (user) connectRealtime();
  }, [user]);

  if (isLoading) return <Loading />;
  if (error) return <div className="p-10 text-center text-sm text-red-700">Não foi possível conectar ao servidor. Recarregue a página.</div>;
  if (!user) return <Navigate to="/admin/login" replace state={{ from: location.pathname }} />;

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {});
    disconnectRealtime();
    qc.clear();
    qc.setQueryData(['me'], null);
  };
  return <AuthCtx.Provider value={{ user, logout }}>{children}</AuthCtx.Provider>;
}
