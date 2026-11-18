import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useBlocker, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronLeft, Clock, Eye, Film, GripVertical, ImageIcon, ListVideo, Plus, Save, Search, Send, X } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatBytes, formatDateTime, formatDuration, formatDurationLong } from '../lib/format';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Field, Input, Loading, Modal, Segmented, Select, Switch, Textarea, cn } from '../components/ui';
import { MediaThumb, MediaTypeBadge, type MediaItem } from '../components/domain';
import { PreviewPlayer, snapshotToPreview, type PreviewItem } from '../components/PreviewPlayer';
import { PublishDialog } from '../components/PublishDialog';
import { PlaylistStatus } from './Playlists';
import type { FitMode, PlaylistSettings, VersionSnapshot } from '../../shared/types';

interface PlaylistDetail {
  id: string;
  name: string;
  description: string | null;
  revision: number;
  settings: PlaylistSettings;
  items: Array<{ id: string; position: number; durationSec: number | null; media: MediaItem }>;
  versions: Array<{ id: string; number: number; publishedAt: string; itemCount: number; totalDurationMs: number; totalBytes: number; sourceRevision: number; publishedBy: string | null }>;
  hasUnpublishedChanges: boolean;
  devices: Array<{ id: string; name: string; publishedVersionId: string | null }>;
  schedules: Array<{ id: string; name: string; device: string }>;
}

interface EditItem {
  key: string;
  id?: string;
  media: MediaItem;
  durationSec: number | null;
}

interface Draft {
  name: string;
  description: string;
  settings: PlaylistSettings;
  items: EditItem[];
}

const serialize = (d: Draft) =>
  JSON.stringify({ n: d.name.trim(), d: d.description.trim(), s: d.settings, i: d.items.map((i) => [i.id ?? i.key, i.media.id, i.durationSec]) });

export default function PlaylistEditor() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['playlist', id], queryFn: () => api<{ playlist: PlaylistDetail; defaults: { imageDurationSec: number } }>(`/api/playlists/${id}`) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState('');
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [picker, setPicker] = useState(false);
  const [preview, setPreview] = useState<{ title: string; items: PreviewItem[]; fit: FitMode } | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [conflict, setConflict] = useState(false);

  const load = useCallback((p: PlaylistDetail) => {
    const d: Draft = {
      name: p.name,
      description: p.description ?? '',
      settings: p.settings,
      items: p.items.map((i) => ({ key: i.id, id: i.id, media: i.media, durationSec: i.durationSec })),
    };
    setDraft(d);
    setBaseline(serialize(d));
    setRevision(p.revision);
    setConflict(false);
  }, []);

  useEffect(() => {
    if (data && (!draft || (serialize(draft) === baseline && data.playlist.revision !== revision))) load(data.playlist);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const dirty = !!draft && serialize(draft) !== baseline;
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const defaultImageSec = draft?.settings.imageDurationSec ?? data?.defaults.imageDurationSec ?? 30;
  const totalMs = useMemo(() => (draft ? draft.items.reduce((s, i) => s + (i.media.type === 'video' ? (i.media.durationMs ?? 0) : (i.durationSec ?? defaultImageSec) * 1000), 0) : 0), [draft, defaultImageSec]);

  if (isLoading || !draft || !data) return error ? <Alert tone="red">{errorMessage(error)}</Alert> : <Loading />;
  const p = data.playlist;
  const notReady = draft.items.filter((i) => i.media.status !== 'ready');
  const imageMedia = draft.items.map((i) => i.media).filter((m) => m.type === 'image');

  const update = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const updateSettings = (patch: Partial<PlaylistSettings>) => setDraft((d) => (d ? { ...d, settings: { ...d.settings, ...patch } } : d));

  const save = async (): Promise<number | null> => {
    if (!draft.name.trim()) {
      toast.error('Informe o nome da playlist.');
      return null;
    }
    setSaving(true);
    try {
      const r = await api<{ revision: number }>(`/api/playlists/${id}`, {
        method: 'PUT',
        body: {
          revision,
          name: draft.name.trim(),
          description: draft.description.trim() || null,
          settings: draft.settings,
          items: draft.items.map((i) => ({ id: i.id, mediaId: i.media.id, durationSec: i.media.type === 'image' ? i.durationSec : null })),
        },
      });
      setRevision(r.revision);
      const fresh = await refetch();
      if (fresh.data) load(fresh.data.playlist);
      void qc.invalidateQueries({ queryKey: ['playlists'] });
      toast.success('Rascunho salvo. O telão só muda após publicar.');
      return r.revision;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'STALE_REVISION') setConflict(true);
      toast.error(errorMessage(e));
      return null;
    } finally {
      setSaving(false);
    }
  };

  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = draft.items.findIndex((i) => i.key === e.active.id);
    const to = draft.items.findIndex((i) => i.key === e.over!.id);
    update({ items: arrayMove(draft.items, from, to) });
  };

  const draftPreview = (): PreviewItem[] =>
    draft.items
      .filter((i) => i.media.status === 'ready')
      .map((i) => ({ key: i.key, mediaId: i.media.id, type: i.media.type, name: i.media.name, durationMs: i.media.type === 'video' ? (i.media.durationMs ?? 0) : (i.durationSec ?? defaultImageSec) * 1000 }));

  const openVersionPreview = async (versionId: string) => {
    try {
      const r = await api<{ snapshot: VersionSnapshot }>(`/api/versions/${versionId}`);
      setPreview({ title: `Versão ${r.snapshot.number} (publicada)`, items: snapshotToPreview(r.snapshot.items), fit: r.snapshot.settings.fitMode });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div>
      <Link to="/admin/playlists" className="mb-3 inline-flex items-center gap-1 text-[13px] text-ink-500 hover:text-ink-800">
        <ChevronLeft className="size-4" /> Playlists
      </Link>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <input
            value={draft.name}
            onChange={(e) => update({ name: e.target.value })}
            maxLength={120}
            aria-label="Nome da playlist"
            className="w-full max-w-xl rounded-md border border-transparent bg-transparent px-1 -ml-1 text-[22px] font-semibold tracking-tight text-ink-900 hover:border-ink-200 focus:border-brand-400 focus:bg-white focus:outline-none"
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-ink-500">
            <PlaylistStatus p={{ latestVersion: p.versions[0] ?? null, hasUnpublishedChanges: p.hasUnpublishedChanges || dirty }} />
            {dirty && <Badge tone="amber">Rascunho não salvo</Badge>}
            <span>
              {draft.items.length} item(ns) · {formatDurationLong(totalMs)} por ciclo
            </span>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button icon={<Eye />} disabled={!draft.items.length} onClick={() => setPreview({ title: 'Prévia do rascunho', items: draftPreview(), fit: draft.settings.fitMode })}>
            Pré-visualizar
          </Button>
          <Button icon={<Save />} disabled={!dirty || conflict} loading={saving} onClick={() => void save()}>
            Salvar
          </Button>
          {user.canPublish && (
            <Button variant="primary" icon={<Send />} disabled={!draft.items.length || notReady.length > 0 || conflict} onClick={() => setPublishing(true)} title={notReady.length ? 'Há mídias em processamento' : undefined}>
              Publicar no telão
            </Button>
          )}
        </div>
      </div>

      {conflict && (
        <Alert tone="red" title="Esta playlist foi alterada em outro lugar" className="mb-4">
          Para evitar sobrescrever o trabalho de outra pessoa, recarregue a versão atual.{' '}
          <button
            className="font-medium underline"
            onClick={async () => {
              const fresh = await refetch();
              if (fresh.data) load(fresh.data.playlist);
            }}
          >
            Recarregar playlist
          </button>
        </Alert>
      )}
      {notReady.length > 0 && (
        <Alert className="mb-4" title="Há mídias que ainda não estão prontas">
          {notReady.map((i) => i.media.name).join(', ')} — aguarde o processamento (ou remova os itens com falha) para publicar.
        </Alert>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader
            icon={<ListVideo />}
            title="Sequência de exibição"
            description="Arraste para reordenar. Vídeos tocam até o fim; imagens usam o tempo definido."
            actions={
              <Button variant="primary" size="sm" icon={<Plus />} onClick={() => setPicker(true)}>
                Adicionar mídias
              </Button>
            }
          />
          {draft.items.length === 0 ? (
            <EmptyState
              icon={<ListVideo />}
              title="Playlist vazia"
              description="Adicione vídeos e imagens da biblioteca."
              action={
                <Button variant="primary" icon={<Plus />} onClick={() => setPicker(true)}>
                  Adicionar mídias
                </Button>
              }
            />
          ) : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={draft.items.map((i) => i.key)} strategy={verticalListSortingStrategy}>
                <ol className="divide-y divide-ink-100">
                  {draft.items.map((item, index) => (
                    <SortableRow
                      key={item.key}
                      item={item}
                      index={index}
                      defaultSec={defaultImageSec}
                      onDuration={(sec) => update({ items: draft.items.map((x) => (x.key === item.key ? { ...x, durationSec: sec } : x)) })}
                      onRemove={() => update({ items: draft.items.filter((x) => x.key !== item.key) })}
                    />
                  ))}
                </ol>
              </SortableContext>
            </DndContext>
          )}
          {draft.items.length > 0 && (
            <div className="flex items-center justify-between border-t border-ink-100 px-5 py-3 text-xs text-ink-500">
              <span>Ao terminar o último item, {draft.settings.loop ? 'a lista recomeça automaticamente.' : 'a última mídia permanece na tela.'}</span>
              <span className="tabular flex items-center gap-1">
                <Clock className="size-3.5" /> {formatDurationLong(totalMs)}
              </span>
            </div>
          )}
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader title="Configurações da playlist" />
            <div className="space-y-5 p-5">
              <Switch checked={draft.settings.loop} onChange={(v) => updateSettings({ loop: v })} label="Loop infinito" description="Recomeça do primeiro item ao terminar." />
              <Switch checked={draft.settings.audio} onChange={(v) => updateSettings({ audio: v })} label="Áudio dos vídeos" description="Requer liberação de autoplay com som no navegador do telão." />
              <Field label="Ajuste na tela">
                <Segmented
                  value={draft.settings.fitMode}
                  onChange={(v) => updateSettings({ fitMode: v })}
                  options={[
                    { value: 'contain', label: 'Mostrar completo' },
                    { value: 'cover', label: 'Preencher a tela' },
                  ]}
                />
              </Field>
              <Field label="Duração padrão das imagens (segundos)" hint={`Vazio = padrão do sistema (${data.defaults.imageDurationSec} s). Pode ser alterada item a item.`}>
                <Input
                  type="number"
                  min={1}
                  max={86400}
                  value={draft.settings.imageDurationSec ?? ''}
                  placeholder={String(data.defaults.imageDurationSec)}
                  onChange={(e) => updateSettings({ imageDurationSec: e.target.value ? Math.max(1, Math.min(86400, Math.round(Number(e.target.value)))) : null })}
                />
              </Field>
              <Field label="Imagem de fallback" hint="Exibida se nenhuma mídia puder ser reproduzida.">
                <Select value={draft.settings.fallbackMediaId ?? ''} onChange={(e) => updateSettings({ fallbackMediaId: e.target.value || null })}>
                  <option value="">Nenhuma (mantém a última imagem)</option>
                  {draft.settings.fallbackMediaId && !imageMedia.some((m) => m.id === draft.settings.fallbackMediaId) && <option value={draft.settings.fallbackMediaId}>Imagem selecionada anteriormente</option>}
                  {imageMedia.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Descrição">
                <Textarea rows={2} value={draft.description} onChange={(e) => update({ description: e.target.value })} maxLength={500} />
              </Field>
            </div>
          </Card>

          <Card>
            <CardHeader title="Onde está publicada" />
            <div className="space-y-2 p-5 text-[13px]">
              {p.devices.length ? p.devices.map((d) => <p key={d.id} className="text-ink-700">• {d.name}</p>) : <p className="text-ink-500">Não atribuída a nenhum telão como programação padrão.</p>}
              {p.schedules.map((s) => (
                <p key={s.id} className="text-violet-700">
                  • Agendamento “{s.name}” ({s.device})
                </p>
              ))}
            </div>
          </Card>

          <Card>
            <CardHeader title="Versões publicadas" description="Cada publicação gera uma versão imutável." />
            {p.versions.length ? (
              <ul className="scrollbar-thin max-h-80 divide-y divide-ink-100 overflow-y-auto">
                {p.versions.map((v) => (
                  <li key={v.id} className="flex items-center gap-3 px-5 py-2.5">
                    <span className="tabular grid h-8 w-10 shrink-0 place-items-center rounded-md bg-ink-100 text-xs font-semibold text-ink-700">v{v.number}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] text-ink-800">{formatDateTime(v.publishedAt)}</p>
                      <p className="truncate text-xs text-ink-500">
                        {v.itemCount} itens · {formatBytes(v.totalBytes)}
                        {v.publishedBy ? ` · ${v.publishedBy}` : ''}
                      </p>
                    </div>
                    <Button size="icon-sm" variant="ghost" title="Pré-visualizar versão" onClick={() => void openVersionPreview(v.id)}>
                      <Eye />
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-5 py-6 text-[13px] text-ink-500">Ainda não publicada.</p>
            )}
          </Card>
        </div>
      </div>

      {picker && (
        <MediaPicker
          onClose={() => setPicker(false)}
          onAdd={(media) => {
            update({ items: [...draft.items, ...media.map((m) => ({ key: crypto.randomUUID(), media: m, durationSec: null }))] });
            setPicker(false);
          }}
        />
      )}

      <Modal open={!!preview} onClose={() => setPreview(null)} title={preview?.title ?? ''} description="Reprodução local, sem afetar o telão." size="xl">
        {preview && <PreviewPlayer items={preview.items} fit={preview.fit} loop={draft.settings.loop} />}
      </Modal>

      <PublishDialog
        open={publishing}
        onClose={() => setPublishing(false)}
        playlistId={p.id}
        playlistName={draft.name}
        beforePublish={async () => (dirty ? await save() : revision)}
      />

      <Modal
        open={blocker.state === 'blocked'}
        onClose={() => blocker.reset?.()}
        title="Sair sem salvar?"
        size="sm"
        footer={
          <>
            <Button onClick={() => blocker.reset?.()}>Continuar editando</Button>
            <Button variant="danger" onClick={() => blocker.proceed?.()}>
              Descartar alterações
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-600">Há alterações no rascunho que ainda não foram salvas.</p>
      </Modal>
    </div>
  );
}

function SortableRow({ item, index, defaultSec, onDuration, onRemove }: { item: EditItem; index: number; defaultSec: number; onDuration: (sec: number | null) => void; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.key });
  const m = item.media;
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn('flex items-center gap-3 bg-white px-3 py-2.5 sm:px-5', isDragging && 'relative z-10 rounded-lg shadow-lg ring-1 ring-brand-200')}>
      <button className="cursor-grab touch-none rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700 active:cursor-grabbing" aria-label={`Mover ${m.name}`} {...attributes} {...listeners}>
        <GripVertical className="size-4" />
      </button>
      <span className="tabular w-6 shrink-0 text-center text-xs font-semibold text-ink-400">{index + 1}</span>
      <MediaThumb media={m} className="w-24 shrink-0" showType={false} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink-900" title={m.name}>
          {m.name}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <MediaTypeBadge type={m.type} />
          {m.status !== 'ready' && <Badge tone={m.status === 'failed' ? 'red' : 'amber'}>{m.status === 'failed' ? 'Falhou' : 'Processando'}</Badge>}
        </div>
      </div>
      <div className="w-36 shrink-0 text-right">
        {m.type === 'video' ? (
          <span className="tabular inline-flex items-center gap-1 text-[13px] text-ink-600">
            <Film className="size-3.5 text-ink-400" /> {formatDuration(m.durationMs)} <span className="text-ink-400">(completo)</span>
          </span>
        ) : (
          <label className="inline-flex items-center gap-1.5 text-[13px] text-ink-600">
            <ImageIcon className="size-3.5 text-ink-400" />
            <input
              type="number"
              min={1}
              max={86400}
              value={item.durationSec ?? ''}
              placeholder={String(defaultSec)}
              onChange={(e) => onDuration(e.target.value ? Math.max(1, Math.min(86400, Math.round(Number(e.target.value)))) : null)}
              className="tabular h-8 w-16 rounded-md border border-ink-200 px-2 text-right text-[13px] focus:border-brand-500 focus:outline-none"
              aria-label="Duração em segundos"
              title={item.durationSec ? 'Duração personalizada' : 'Usando a duração padrão'}
            />
            s
          </label>
        )}
      </div>
      <Button size="icon-sm" variant="ghost" onClick={onRemove} aria-label={`Remover ${m.name}`} title="Remover da playlist">
        <X />
      </Button>
    </li>
  );
}

function MediaPicker({ onClose, onAdd }: { onClose: () => void; onAdd: (media: MediaItem[]) => void }) {
  const [search, setSearch] = useState('');
  const [type, setType] = useState<'all' | 'image' | 'video'>('all');
  const [selected, setSelected] = useState<string[]>([]);
  const { data, isLoading } = useQuery({ queryKey: ['media', 'picker'], queryFn: () => api<{ media: MediaItem[] }>('/api/media?status=ready') });
  const list = (data?.media ?? []).filter((m) => (type === 'all' || m.type === type) && (!search || m.name.toLowerCase().includes(search.toLowerCase())));
  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title="Adicionar mídias"
      description="Selecione na ordem em que devem entrar na sequência."
      footer={
        <>
          <Link to="/admin/media" className="mr-auto self-center text-[13px] text-brand-700 hover:underline">
            Enviar novos arquivos
          </Link>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="primary" disabled={!selected.length} onClick={() => onAdd(selected.map((id) => data!.media.find((m) => m.id === id)!))}>
            Adicionar {selected.length || ''} {selected.length === 1 ? 'mídia' : 'mídias'}
          </Button>
        </>
      }
    >
      <div className="mb-4 flex flex-wrap gap-3">
        <div className="relative min-w-52 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-400" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Pesquisar…" className="pl-9" />
        </div>
        <Segmented value={type} onChange={setType} options={[{ value: 'all', label: 'Todos' }, { value: 'image', label: 'Imagens' }, { value: 'video', label: 'Vídeos' }]} />
      </div>
      {isLoading ? (
        <Loading />
      ) : !list.length ? (
        <p className="py-10 text-center text-sm text-ink-500">Nenhuma mídia pronta encontrada.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {list.map((m) => {
            const order = selected.indexOf(m.id);
            return (
              <button
                key={m.id}
                onClick={() => setSelected((s) => (order >= 0 ? s.filter((x) => x !== m.id) : [...s, m.id]))}
                className={cn('relative overflow-hidden rounded-lg border-2 text-left transition', order >= 0 ? 'border-brand-500 ring-2 ring-brand-500/20' : 'border-transparent hover:border-ink-200')}
              >
                <MediaThumb media={m} className="rounded-none" />
                <div className="p-2">
                  <p className="truncate text-xs font-medium text-ink-800">{m.name}</p>
                  <p className="text-[11px] text-ink-500">{m.type === 'video' ? `Vídeo · ${formatDuration(m.durationMs)}` : 'Imagem'}</p>
                </div>
                {order >= 0 && <span className="absolute top-1.5 left-1.5 grid h-6 w-6 place-items-center rounded-full bg-brand-600 text-xs font-bold text-white shadow">{order + 1}</span>}
              </button>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
