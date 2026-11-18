import { useState } from 'react';
import { ChevronDown, CircleCheck, CircleX, CloudUpload, LoaderCircle, RotateCcw, X } from 'lucide-react';
import { cancelUpload, clearFinished, retryUpload, useUploads, type UploadTask } from '../lib/upload';
import { formatBytes } from '../lib/format';
import { Button, Progress, cn } from './ui';

const LABEL: Record<UploadTask['status'], string> = {
  queued: 'Na fila',
  preparing: 'Analisando arquivo',
  uploading: 'Enviando',
  finishing: 'Validando arquivo',
  processing: 'Processando (miniatura e metadados)',
  done: 'Concluído',
  error: 'Erro',
  cancelled: 'Cancelado',
};

/** Painel flutuante com o progresso de cada upload (permanece ao navegar entre páginas) */
export function UploadDock() {
  const tasks = useUploads();
  const [collapsed, setCollapsed] = useState(false);
  if (!tasks.length) return null;
  const active = tasks.filter((t) => ['queued', 'preparing', 'uploading', 'finishing', 'processing'].includes(t.status)).length;
  return (
    <div className="fixed right-4 bottom-4 z-40 w-[min(400px,calc(100vw-2rem))] animate-pop overflow-hidden rounded-xl border border-ink-200 bg-white shadow-xl">
      <div className="flex items-center justify-between gap-2 border-b border-ink-100 bg-ink-50/70 px-4 py-2.5">
        <div className="flex items-center gap-2 text-sm font-medium text-ink-800">
          <CloudUpload className="size-4 text-brand-600" />
          {active ? `Enviando ${active} arquivo(s)` : 'Envios concluídos'}
        </div>
        <div className="flex items-center gap-1">
          {!active && (
            <Button size="sm" variant="ghost" onClick={clearFinished}>
              Limpar
            </Button>
          )}
          <Button size="icon-sm" variant="ghost" onClick={() => setCollapsed((c) => !c)} aria-label="Recolher">
            <ChevronDown className={cn('transition-transform', collapsed && 'rotate-180')} />
          </Button>
        </div>
      </div>
      {!collapsed && (
        <ul className="scrollbar-thin max-h-72 divide-y divide-ink-100 overflow-y-auto">
          {tasks.map((t) => {
            const pct = t.size ? (t.sent / t.size) * 100 : 0;
            return (
              <li key={t.key} className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="shrink-0">
                    {t.status === 'done' ? (
                      <CircleCheck className="size-4 text-emerald-600" />
                    ) : t.status === 'error' ? (
                      <CircleX className="size-4 text-red-600" />
                    ) : t.status === 'cancelled' ? (
                      <X className="size-4 text-ink-400" />
                    ) : (
                      <LoaderCircle className="size-4 animate-spin text-brand-600" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium text-ink-800" title={t.name}>
                      {t.name}
                    </p>
                    <p className={cn('truncate text-xs', t.status === 'error' ? 'text-red-600' : 'text-ink-500')}>
                      {t.status === 'error' ? t.error : t.status === 'uploading' ? `${formatBytes(t.sent)} de ${formatBytes(t.size)} · ${Math.floor(pct)}%` : t.status === 'preparing' ? `${LABEL.preparing} · ${t.prepPct}%` : `${LABEL[t.status]} · ${formatBytes(t.size)}`}
                    </p>
                  </div>
                  {['queued', 'preparing', 'uploading'].includes(t.status) && (
                    <Button size="icon-sm" variant="ghost" title="Cancelar" onClick={() => cancelUpload(t.key)}>
                      <X />
                    </Button>
                  )}
                  {t.status === 'error' && (
                    <Button size="icon-sm" variant="ghost" title="Tentar novamente" onClick={() => retryUpload(t.key)}>
                      <RotateCcw />
                    </Button>
                  )}
                </div>
                {['uploading', 'finishing', 'processing'].includes(t.status) && <Progress className="mt-2" value={t.status === 'uploading' ? pct : 100} tone={t.status === 'uploading' ? 'brand' : 'amber'} />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
