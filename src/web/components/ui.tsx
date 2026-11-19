import { Children, cloneElement, createContext, forwardRef, isValidElement, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { LoaderCircle, TriangleExclamationPoint, X } from 'lucide-react';

export const cn = (...v: ClassValue[]) => twMerge(clsx(v));

// ---------------- Button ----------------
type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type Size = 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';
const variants: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 shadow-sm disabled:bg-brand-600/50',
  secondary: 'bg-white text-ink-800 border border-ink-200 hover:bg-ink-50 hover:border-ink-300 shadow-sm',
  outline: 'border border-brand-200 text-brand-700 hover:bg-brand-50',
  ghost: 'text-ink-600 hover:bg-ink-100 hover:text-ink-900',
  danger: 'bg-red-600 text-white hover:bg-red-700 shadow-sm',
};
const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-md',
  md: 'h-9 px-3.5 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-5 text-[15px] gap-2 rounded-lg',
  icon: 'h-9 w-9 rounded-lg',
  'icon-sm': 'h-7 w-7 rounded-md',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest }, ref) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-colors duration-150 select-none disabled:cursor-not-allowed disabled:opacity-55 [&_svg]:size-4 [&_svg]:shrink-0',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? <LoaderCircle className="animate-spin" /> : icon}
      {children}
    </button>
  );
});

// ---------------- Inputs ----------------
const fieldBase =
  'w-full rounded-lg border border-ink-200 bg-white px-3 text-sm text-ink-900 shadow-sm transition placeholder:text-ink-400 focus:border-brand-500 focus:ring-3 focus:ring-brand-500/15 focus:outline-none disabled:bg-ink-50 disabled:text-ink-500';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(fieldBase, 'h-9', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(fieldBase, 'min-h-20 py-2', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cn(fieldBase, 'h-9 pr-8', className)} {...rest}>
      {children}
    </select>
  );
});

export function Field({ label, hint, error, children, className, htmlFor }: { label?: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string; htmlFor?: string }) {
  const autoId = useId();
  // associa o rótulo ao controle (acessibilidade) quando o filho é um único campo sem id
  const only = Children.count(children) === 1 && isValidElement<{ id?: string }>(children) && typeof children.type !== 'string' ? children : null;
  const id = htmlFor ?? (only ? (only.props.id ?? autoId) : undefined);
  if (only && !only.props.id && id) children = cloneElement(only, { id });
  return (
    <div className={cn('space-y-1.5', className)}>
      {label && (
        <label htmlFor={id} className="block text-[13px] font-medium text-ink-700">
          {label}
        </label>
      )}
      {children}
      {error ? <p className="text-xs text-red-600">{error}</p> : hint ? <p className="text-xs leading-relaxed text-ink-500">{hint}</p> : null}
    </div>
  );
}

export function Switch({ checked, onChange, disabled, label, description }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: ReactNode; description?: ReactNode }) {
  return (
    <label className={cn('flex items-start gap-3', disabled ? 'opacity-60' : 'cursor-pointer')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn('relative mt-0.5 inline-flex h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-brand-600' : 'bg-ink-300')}
      >
        <span className={cn('absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform', checked && 'translate-x-4')} />
      </button>
      {(label || description) && (
        <span className="min-w-0">
          {label && <span className="block text-sm font-medium text-ink-800">{label}</span>}
          {description && <span className="block text-xs text-ink-500">{description}</span>}
        </span>
      )}
    </label>
  );
}

export function Segmented<T extends string>({ value, onChange, options, disabled, size = 'md' }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode; icon?: ReactNode }>; disabled?: boolean; size?: 'sm' | 'md' }) {
  return (
    <div className={cn('inline-flex rounded-lg border border-ink-200 bg-ink-100/70 p-0.5', disabled && 'opacity-60')}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-md font-medium transition [&_svg]:size-3.5',
            size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8 px-3 text-[13px]',
            value === o.value ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-800',
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------- Layout blocks ----------------
export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('rounded-xl border border-ink-200/80 bg-white shadow-(--shadow-card)', className)} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ title, description, actions, icon, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; icon?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start justify-between gap-3 border-b border-ink-100 px-5 py-4', className)}>
      <div className="flex min-w-0 items-start gap-3">
        {icon && <div className="mt-0.5 text-brand-600 [&_svg]:size-[18px]">{icon}</div>}
        <div className="min-w-0">
          <h3 className="text-[15px] font-semibold text-ink-900">{title}</h3>
          {description && <p className="mt-0.5 text-[13px] text-ink-500">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions, back }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {back}
        <h1 className="text-[22px] font-semibold tracking-tight text-ink-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-ink-500">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

type Tone = 'neutral' | 'brand' | 'green' | 'amber' | 'red' | 'violet';
const tones: Record<Tone, string> = {
  neutral: 'bg-ink-100 text-ink-700 ring-ink-200',
  brand: 'bg-brand-50 text-brand-700 ring-brand-200',
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  amber: 'bg-amber-50 text-amber-800 ring-amber-200',
  red: 'bg-red-50 text-red-700 ring-red-200',
  violet: 'bg-violet-50 text-violet-700 ring-violet-200',
};
export function Badge({ tone = 'neutral', children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] font-medium whitespace-nowrap ring-1 ring-inset [&_svg]:size-3', tones[tone], className)}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle className={cn('size-5 animate-spin text-brand-600', className)} />;
}

export function Loading({ label = 'Carregando…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-sm text-ink-500">
      <Spinner /> {label}
    </div>
  );
}

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-14 text-center', className)}>
      {icon && <div className="mb-4 grid h-12 w-12 place-items-center rounded-xl bg-brand-50 text-brand-600 [&_svg]:size-6">{icon}</div>}
      <h3 className="text-[15px] font-semibold text-ink-900">{title}</h3>
      {description && <p className="mt-1 max-w-md text-sm text-ink-500">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Alert({ tone = 'amber', title, children, icon, className }: { tone?: 'amber' | 'red' | 'brand' | 'green'; title?: ReactNode; children?: ReactNode; icon?: ReactNode; className?: string }) {
  const map = { amber: 'border-amber-200 bg-amber-50 text-amber-900', red: 'border-red-200 bg-red-50 text-red-800', brand: 'border-brand-200 bg-brand-50 text-brand-900', green: 'border-emerald-200 bg-emerald-50 text-emerald-900' };
  return (
    <div className={cn('flex gap-3 rounded-lg border px-4 py-3 text-sm', map[tone], className)} role="alert">
      <div className="mt-0.5 shrink-0 [&_svg]:size-4">{icon ?? <TriangleExclamationPoint />}</div>
      <div className="min-w-0">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn(title && 'mt-0.5', 'opacity-90')}>{children}</div>}
      </div>
    </div>
  );
}

export function Progress({ value, className, tone = 'brand' }: { value: number; className?: string; tone?: 'brand' | 'green' | 'amber' }) {
  const color = { brand: 'bg-brand-600', green: 'bg-emerald-500', amber: 'bg-amber-500' }[tone];
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-ink-100', className)}>
      <div className={cn('h-full rounded-full transition-[width] duration-300 ease-linear', color)} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-ink-200 bg-ink-50 px-1.5 py-0.5 font-mono text-[11px] text-ink-600">{children}</kbd>;
}

// ---------------- Modal ----------------
export function Modal({ open, onClose, title, description, children, footer, size = 'md', closeOnBackdrop = true }: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl'; closeOnBackdrop?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  // onClose costuma ser uma função nova a cada render da página: guardá-la em ref evita que o efeito
  // abaixo rode de novo a cada tecla digitada (o que devolvia o foco ao primeiro campo do formulário).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeRef.current();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    const t = setTimeout(() => panel.current?.querySelector<HTMLElement>('input,select,textarea,button[data-autofocus]')?.focus(), 30);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      prev?.focus?.();
    };
  }, [open]);
  if (!open) return null;
  const width = { sm: 'max-w-md', md: 'max-w-lg', lg: 'max-w-3xl', xl: 'max-w-5xl' }[size];
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6" role="dialog" aria-modal="true">
      <div className="absolute inset-0 animate-fade-in bg-ink-900/45 backdrop-blur-[2px]" onClick={closeOnBackdrop ? onClose : undefined} />
      <div ref={panel} className={cn('relative flex max-h-[92vh] w-full animate-pop flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:rounded-2xl', width)}>
        <div className="flex items-start justify-between gap-4 border-b border-ink-100 px-6 py-4">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-ink-900">{title}</h2>
            {description && <p className="mt-0.5 text-[13px] text-ink-500">{description}</p>}
          </div>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Fechar">
            <X />
          </Button>
        </div>
        <div className="scrollbar-thin overflow-y-auto px-6 py-5">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-ink-100 bg-ink-50/60 px-6 py-3.5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ---------------- Confirmação ----------------
interface ConfirmOptions {
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  tone?: 'danger' | 'primary';
}
const ConfirmCtx = createContext<(o: ConfirmOptions) => Promise<boolean>>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      <Modal
        open={!!state}
        onClose={() => close(false)}
        title={state?.title}
        size="sm"
        footer={
          <>
            <Button onClick={() => close(false)}>Cancelar</Button>
            <Button variant={state?.tone === 'primary' ? 'primary' : 'danger'} data-autofocus onClick={() => close(true)}>
              {state?.confirmLabel ?? 'Confirmar'}
            </Button>
          </>
        }
      >
        <div className="text-sm leading-relaxed text-ink-600">{state?.description}</div>
      </Modal>
    </ConfirmCtx.Provider>
  );
}

export function StatCard({ icon, label, value, detail, tone = 'brand' }: { icon: ReactNode; label: ReactNode; value: ReactNode; detail?: ReactNode; tone?: 'brand' | 'green' | 'amber' | 'violet' }) {
  const toneCls = { brand: 'bg-brand-50 text-brand-600', green: 'bg-emerald-50 text-emerald-600', amber: 'bg-amber-50 text-amber-600', violet: 'bg-violet-50 text-violet-600' }[tone];
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-ink-500">{label}</p>
          <p className="tabular mt-2 truncate text-2xl font-semibold tracking-tight text-ink-900">{value}</p>
          {detail && <p className="mt-1 truncate text-xs text-ink-500">{detail}</p>}
        </div>
        <div className={cn('grid h-10 w-10 shrink-0 place-items-center rounded-lg [&_svg]:size-5', toneCls)}>{icon}</div>
      </div>
    </Card>
  );
}
