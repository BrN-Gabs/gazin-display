import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { CalendarClock, ChevronDown, Images, KeyRound, LayoutDashboard, ListVideo, LogOut, Menu, MonitorPlay, ScrollText, Settings, Tv, X } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useRealtimeConnected } from '../lib/realtime';
import { cn } from './ui';
import { UploadDock } from './UploadDock';

const NAV = [
  { to: '/admin', label: 'Visão Geral', icon: LayoutDashboard, end: true },
  { to: '/admin/media', label: 'Biblioteca de Mídias', icon: Images },
  { to: '/admin/playlists', label: 'Playlists', icon: ListVideo },
  { to: '/admin/devices', label: 'Telões', icon: MonitorPlay },
  { to: '/admin/schedules', label: 'Programação', icon: CalendarClock },
  { to: '/admin/history', label: 'Histórico', icon: ScrollText },
  { to: '/admin/settings', label: 'Configurações', icon: Settings },
];

function Brand() {
  return (
    <div className="flex items-center gap-3 px-5 py-5">
      <div className="grid h-9 w-9 place-items-center rounded-lg bg-brand-600 text-white shadow-inner">
        <Tv className="size-5" />
      </div>
      <div className="leading-tight">
        <div className="text-[15px] font-bold tracking-[0.14em] text-white">GAZIN</div>
        <div className="text-[11px] font-medium tracking-[0.28em] text-brand-300">DISPLAY</div>
      </div>
    </div>
  );
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col bg-brand-950">
      <Brand />
      <nav className="mt-2 flex-1 space-y-0.5 px-3">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13.5px] font-medium transition-colors',
                isActive ? 'bg-white/10 text-white' : 'text-brand-200/80 hover:bg-white/5 hover:text-white',
              )
            }
          >
            {({ isActive }) => (
              <>
                <Icon className={cn('size-[18px]', isActive ? 'text-brand-300' : 'text-brand-300/60 group-hover:text-brand-300')} />
                {label}
              </>
            )}
          </NavLink>
        ))}
      </nav>
      <div className="px-5 py-4 text-[11px] text-brand-300/50">Central de Gerenciamento de Mídias</div>
    </div>
  );
}

function ConnectionPill() {
  const connected = useRealtimeConnected();
  return (
    <span
      title={connected ? 'Atualizações em tempo real ativas' : 'Reconectando ao servidor…'}
      className={cn('hidden items-center gap-2 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset sm:inline-flex', connected ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-amber-50 text-amber-800 ring-amber-200')}
    >
      <span className={cn('h-2 w-2 rounded-full', connected ? 'bg-emerald-500' : 'animate-pulse bg-amber-500')} />
      {connected ? 'Conectado' : 'Reconectando'}
    </span>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const initials = user.name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0])
    .join('')
    .toUpperCase();
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2.5 rounded-lg py-1 pr-2 pl-1 hover:bg-ink-100">
        <span className="grid h-8 w-8 place-items-center rounded-full bg-brand-100 text-xs font-semibold text-brand-700">{initials}</span>
        <span className="hidden text-left leading-tight md:block">
          <span className="block text-[13px] font-medium text-ink-900">{user.name}</span>
          <span className="block text-[11px] text-ink-500">{user.role === 'ADMIN' ? 'Administrador' : 'Editor'}</span>
        </span>
        <ChevronDown className="size-4 text-ink-400" />
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-2 w-60 animate-pop overflow-hidden rounded-xl border border-ink-200 bg-white shadow-lg">
          <div className="border-b border-ink-100 px-4 py-3">
            <p className="truncate text-sm font-medium text-ink-900">{user.name}</p>
            <p className="truncate text-xs text-ink-500">{user.email}</p>
          </div>
          <button
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-ink-700 hover:bg-ink-50"
            onClick={() => {
              setOpen(false);
              navigate('/admin/settings?tab=security');
            }}
          >
            <KeyRound className="size-4 text-ink-400" /> Perfil e segurança
          </button>
          <button
            className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-red-700 hover:bg-red-50"
            onClick={async () => {
              await logout();
              navigate('/admin/login');
            }}
          >
            <LogOut className="size-4" /> Sair
          </button>
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setMobileOpen(false), [location.pathname]);
  return (
    <div className="flex min-h-full">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 lg:block">
        <Sidebar />
      </aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-ink-900/50" onClick={() => setMobileOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 animate-pop shadow-2xl">
            <Sidebar onNavigate={() => setMobileOpen(false)} />
            <button className="absolute top-5 right-3 rounded-md p-1 text-brand-200 hover:bg-white/10" onClick={() => setMobileOpen(false)} aria-label="Fechar menu">
              <X className="size-5" />
            </button>
          </div>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between gap-4 border-b border-ink-200/80 bg-white/90 px-4 backdrop-blur sm:px-6">
          <div className="flex items-center gap-3">
            <button className="rounded-lg p-2 text-ink-600 hover:bg-ink-100 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Abrir menu">
              <Menu className="size-5" />
            </button>
            <span className="text-sm font-semibold tracking-wide text-ink-900">GAZIN DISPLAY</span>
            <span className="hidden text-sm text-ink-400 sm:inline">· Matriz</span>
          </div>
          <div className="flex items-center gap-3">
            <ConnectionPill />
            <UserMenu />
          </div>
        </header>
        <main className="mx-auto w-full max-w-[1400px] flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <Outlet />
        </main>
      </div>
      <UploadDock />
    </div>
  );
}
