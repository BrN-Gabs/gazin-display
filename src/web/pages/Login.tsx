import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, LockKeyhole, MonitorPlay, RefreshCw, ShieldCheck, Tv } from 'lucide-react';
import { api, errorMessage } from '../lib/api';
import { useMe } from '../lib/auth';
import { Alert, Button, Field, Input } from '../components/ui';

export function LoginPage() {
  const { data: user } = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (user) return <Navigate to="/admin" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!login.trim() || !password) {
      setError('Informe seu e-mail ou usuário e a senha.');
      return;
    }
    setLoading(true);
    try {
      const r = await api<{ user: unknown }>('/api/auth/login', { body: { login: login.trim(), password } });
      qc.setQueryData(['me'], r.user);
      const from = (location.state as { from?: string } | null)?.from;
      navigate(from && from.startsWith('/admin') && from !== '/admin/login' ? from : '/admin', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setPassword('');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="grid min-h-full lg:grid-cols-[1.05fr_1fr]">
      <section className="relative hidden overflow-hidden bg-brand-950 lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="pointer-events-none absolute inset-0 opacity-[0.07]" style={{ backgroundImage: 'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)', backgroundSize: '48px 48px' }} />
        <div className="relative flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-lg bg-brand-600 text-white">
            <Tv className="size-5" />
          </div>
          <span className="text-sm font-semibold tracking-[0.2em] text-brand-200">MATRIZ GAZIN</span>
        </div>
        <div className="relative max-w-md">
          <h2 className="text-3xl leading-tight font-semibold text-white">Toda a programação dos telões em um só lugar.</h2>
          <ul className="mt-8 space-y-4 text-[15px] text-brand-100/85">
            <li className="flex gap-3">
              <MonitorPlay className="mt-0.5 size-5 shrink-0 text-brand-300" /> Envie vídeos e imagens e organize a sequência pelo navegador.
            </li>
            <li className="flex gap-3">
              <RefreshCw className="mt-0.5 size-5 shrink-0 text-brand-300" /> Publique e o telão se atualiza sozinho, sem acesso remoto.
            </li>
            <li className="flex gap-3">
              <ShieldCheck className="mt-0.5 size-5 shrink-0 text-brand-300" /> Acesso protegido, histórico de alterações e controle em tempo real.
            </li>
          </ul>
        </div>
        <p className="relative text-xs text-brand-300/60">Uso interno · Gazin</p>
      </section>

      <section className="flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8">
            <div className="mb-6 grid h-11 w-11 place-items-center rounded-xl bg-brand-600 text-white lg:hidden">
              <Tv className="size-5" />
            </div>
            <h1 className="text-2xl font-bold tracking-[0.06em] text-ink-900">GAZIN DISPLAY</h1>
            <p className="mt-1 text-sm text-ink-500">Central de Gerenciamento de Mídias</p>
          </div>
          <form onSubmit={submit} className="space-y-4" noValidate>
            {error && <Alert tone="red">{error}</Alert>}
            <Field label="E-mail ou usuário" htmlFor="login">
              <Input id="login" name="username" autoComplete="username" autoFocus value={login} onChange={(e) => setLogin(e.target.value)} className="h-10" />
            </Field>
            <Field label="Senha" htmlFor="password">
              <div className="relative">
                <Input id="password" name="password" type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-10 pr-10" />
                <button type="button" onClick={() => setShow((s) => !s)} className="absolute inset-y-0 right-0 grid w-10 place-items-center text-ink-400 hover:text-ink-700" aria-label={show ? 'Ocultar senha' : 'Mostrar senha'}>
                  {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </div>
            </Field>
            <Button type="submit" variant="primary" size="lg" className="w-full" loading={loading} icon={<LockKeyhole />}>
              Entrar
            </Button>
          </form>
          <p className="mt-8 text-center text-xs text-ink-400">Esqueceu a senha? Solicite a redefinição a um administrador.</p>
        </div>
      </section>
    </div>
  );
}
