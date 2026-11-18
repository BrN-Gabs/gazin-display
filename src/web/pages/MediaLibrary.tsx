import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudUpload, Film, ImagePlus, Images, LayoutGrid, List, ListPlus, Pencil, Search, Trash } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError, errorMessage } from '../lib/api';
import { enqueueFiles, loadUploadConfig } from '../lib/upload';
import { formatBytes, formatDateTime, formatDuration, resolution } from '../lib/format';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader, Segmented, Select, Textarea, cn, useConfirm } from '../components/ui';
import { MediaStatusBadge, MediaThumb, MediaTypeBadge, type MediaItem } from '../components/domain';

type Sort = 'date-desc' | 'date-asc' | 'name' | 'size';

export default function MediaLibrary() {
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  const [type, setType] = useState<'all' | 'image' | 'video'>('all');
  const [sort, setSort] = useState<Sort>('date-desc');
  const [view, setView] = useState<'grid' | 'list'>(() => (localStorage.getItem('gd.media.view') as 'grid' | 'list') || 'grid');
  const [selected, setSelected] = useState<MediaItem | null>(null);
  const [dragging, setDragging] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search), 250);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    void loadUploadConfig().catch(() => {});
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('gd.media.view', view);
    } catch {
      /* noop */
    }
  }, [view]);

  const params = new URLSearchParams();
  if (debounced) params.set('search', debounced);
  if (type !== 'all') params.set('type', type);
  const [sortKey, order] = sort === 'date-desc' ? ['date', 'desc'] : sort === 'date-asc' ? ['date', 'asc'] : sort === 'name' ? ['name', 'asc'] : ['size', 'desc'];
  params.set('sort', sortKey!);
  params.set('order', order!);
  const { data, isLoading } = useQuery({
    queryKey: ['media', params.toString()],
    queryFn: () => api<{ media: MediaItem[] }>(`/api/media?${params}`),
    refetchInterval: (q) => (q.state.data?.media.some((m) => m.status === 'processing') ? 3000 : false),
  });

  const addFiles = async (fileList: FileList | File[] | null, kind?: 'image' | 'video') => {
    // copia já: FileList é "vivo" e esvazia quando o input é limpo
    const files = fileList ? [...fileList] : [];
    if (!files.length) return;
    await loadUploadConfig().catch(() => {});
    const rejected = enqueueFiles(files, kind);
    for (const r of rejected) toast.error(`${r.name}: ${r.error}`);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void addFiles(e.dataTransfer.files);
  };

  const media = data?.media ?? [];
  return (
    <div
      className="relative"
      onDragEnter={(e) => {
        if (![...e.dataTransfer.types].includes('Files')) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <PageHeader
        title="Biblioteca de Mídias"
        description="Vídeos e imagens disponíveis para as playlists. Os arquivos ficam armazenados no servidor."
        actions={
          <>
            <Button icon={<ImagePlus />} onClick={() => imageInput.current?.click()}>
              Adicionar imagens
            </Button>
            <Button variant="primary" icon={<Film />} onClick={() => videoInput.current?.click()}>
              Adicionar vídeos
            </Button>
          </>
        }
      />
      <input ref={imageInput} type="file" multiple accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => (void addFiles(e.target.files, 'image'), (e.target.value = ''))} />
      <input ref={videoInput} type="file" multiple accept="video/*" className="hidden" onChange={(e) => (void addFiles(e.target.files, 'video'), (e.target.value = ''))} />

      <button
        type="button"
        onClick={() => videoInput.current?.click()}
        className="mb-6 flex w-full items-center justify-center gap-3 rounded-xl border-2 border-dashed border-ink-200 bg-white px-6 py-6 text-sm text-ink-500 transition hover:border-brand-300 hover:bg-brand-50/40"
      >
        <CloudUpload className="size-6 text-brand-500" />
        <span>
          <span className="font-medium text-ink-800">Arraste arquivos para cá</span> ou clique para selecionar · JPG, PNG, WebP, MP4 (H.264) e WebM
        </span>
      </button>

      <Card className="mb-4 flex flex-wrap items-center gap-3 p-3">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-400" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Pesquisar por nome…" className="pl-9" />
        </div>
        <Segmented value={type} onChange={setType} options={[{ value: 'all', label: 'Todos' }, { value: 'image', label: 'Imagens' }, { value: 'video', label: 'Vídeos' }]} />
        <Select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="w-44">
          <option value="date-desc">Mais recentes</option>
          <option value="date-asc">Mais antigos</option>
          <option value="name">Nome (A–Z)</option>
          <option value="size">Maior tamanho</option>
        </Select>
        <Segmented value={view} onChange={setView} options={[{ value: 'grid', label: '', icon: <LayoutGrid /> }, { value: 'list', label: '', icon: <List /> }]} />
      </Card>

      {isLoading ? (
        <Loading />
      ) : !media.length ? (
        <Card>
          <EmptyState icon={<Images />} title={debounced || type !== 'all' ? 'Nenhuma mídia encontrada' : 'Sua biblioteca está vazia'} description={debounced || type !== 'all' ? 'Ajuste a pesquisa ou os filtros.' : 'Envie vídeos e imagens para montar a programação do telão.'} />
        </Card>
      ) : view === 'grid' ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5">
          {media.map((m) => (
            <button key={m.id} onClick={() => setSelected(m)} className="group overflow-hidden rounded-xl border border-ink-200/80 bg-white text-left shadow-(--shadow-card) transition hover:-translate-y-0.5 hover:border-brand-300 hover:shadow-md">
              <MediaThumb media={m} className="rounded-none" />
              <div className="space-y-1.5 p-3">
                <p className="truncate text-[13px] font-medium text-ink-900" title={m.name}>
                  {m.name}
                </p>
                <div className="flex items-center justify-between gap-2">
                  <MediaTypeBadge type={m.type} />
                  <MediaStatusBadge status={m.status} />
                </div>
                <p className="truncate text-xs text-ink-500">
                  {formatBytes(m.sizeBytes)} · {resolution(m.width, m.height)}
                </p>
              </div>
            </button>
          ))}
        </div>
      ) : (
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b border-ink-100 text-left text-xs font-medium text-ink-500">
              <tr>
                <th className="px-4 py-3">Mídia</th>
                <th className="px-4 py-3">Tipo</th>
                <th className="px-4 py-3">Duração</th>
                <th className="px-4 py-3">Resolução</th>
                <th className="px-4 py-3">Tamanho</th>
                <th className="px-4 py-3">Envio</th>
                <th className="px-4 py-3">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100">
              {media.map((m) => (
                <tr key={m.id} onClick={() => setSelected(m)} className="cursor-pointer hover:bg-ink-50">
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-3">
                      <MediaThumb media={m} className="w-20 shrink-0" showType={false} />
                      <span className="max-w-72 truncate font-medium text-ink-800">{m.name}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2.5">
                    <MediaTypeBadge type={m.type} />
                  </td>
                  <td className="tabular px-4 py-2.5 text-ink-600">{m.type === 'video' ? formatDuration(m.durationMs) : '—'}</td>
                  <td className="tabular px-4 py-2.5 text-ink-600">{resolution(m.width, m.height)}</td>
                  <td className="tabular px-4 py-2.5 text-ink-600">{formatBytes(m.sizeBytes)}</td>
                  <td className="px-4 py-2.5 text-ink-600">{formatDateTime(m.createdAt)}</td>
                  <td className="px-4 py-2.5">{m.status === 'ready' ? <Badge tone="green">Pronto</Badge> : <MediaStatusBadge status={m.status} />}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 grid animate-fade-in place-items-center bg-brand-950/60 backdrop-blur-sm">
          <div className="rounded-2xl border-2 border-dashed border-white/70 px-16 py-12 text-center text-white">
            <CloudUpload className="mx-auto mb-3 size-10" />
            <p className="text-lg font-semibold">Solte os arquivos para enviar</p>
          </div>
        </div>
      )}

      {selected && <MediaDetails media={media.find((m) => m.id === selected.id) ?? selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

function MediaDetails({ media, onClose }: { media: MediaItem; onClose: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [name, setName] = useState(media.name);
  const [description, setDescription] = useState(media.description ?? '');
  const [playlistId, setPlaylistId] = useState('');
  const usage = useQuery({ queryKey: ['media', media.id, 'usage'], queryFn: () => api<{ playlists: Array<{ id: string; name: string }>; activeOn: string[] }>(`/api/media/${media.id}/usage`) });
  const playlists = useQuery({ queryKey: ['playlists'], queryFn: () => api<{ playlists: Array<{ id: string; name: string }> }>('/api/playlists') });
  const dirty = name.trim() !== media.name || description.trim() !== (media.description ?? '');

  const save = useMutation({
    mutationFn: () => api(`/api/media/${media.id}`, { method: 'PATCH', body: { name: name.trim(), description: description.trim() || null } }),
    onSuccess: () => {
      toast.success('Informações salvas');
      void qc.invalidateQueries({ queryKey: ['media'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const addToPlaylist = useMutation({
    mutationFn: async () => {
      const { playlist } = await api<{ playlist: { revision: number; name: string; items: Array<{ id: string; durationSec: number | null; media: { id: string } }> } }>(`/api/playlists/${playlistId}`);
      await api(`/api/playlists/${playlistId}`, {
        method: 'PUT',
        body: { revision: playlist.revision, items: [...playlist.items.map((i) => ({ id: i.id, mediaId: i.media.id, durationSec: i.durationSec })), { mediaId: media.id }] },
      });
      return playlist.name;
    },
    onSuccess: (pname) => {
      toast.success(`Adicionada ao rascunho de "${pname}". Publique a playlist para enviar ao telão.`);
      void qc.invalidateQueries({ queryKey: ['playlists'] });
      void qc.invalidateQueries({ queryKey: ['playlist', playlistId] });
      void usage.refetch();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const remove = async () => {
    const activeOn = usage.data?.activeOn ?? [];
    if (activeOn.length) {
      toast.error(`Esta mídia está na programação publicada (${[...new Set(activeOn)].join(', ')}). Publique uma versão sem ela antes de removê-la.`);
      return;
    }
    const inPlaylists = usage.data?.playlists ?? [];
    const ok = await confirm({
      title: 'Remover mídia da biblioteca?',
      description: inPlaylists.length ? (
        <>
          Ela também será retirada do rascunho de: <b>{inPlaylists.map((p) => p.name).join(', ')}</b>. O arquivo será excluído do servidor.
        </>
      ) : (
        'O arquivo será excluído permanentemente do servidor.'
      ),
      confirmLabel: 'Remover',
    });
    if (!ok) return;
    try {
      await api(`/api/media/${media.id}${inPlaylists.length ? '?force=true' : ''}`, { method: 'DELETE' });
      toast.success('Mídia removida');
      void qc.invalidateQueries({ queryKey: ['media'] });
      void qc.invalidateQueries({ queryKey: ['playlists'] });
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError && e.code === 'MEDIA_IN_USE' ? e.message : errorMessage(e));
    }
  };

  return (
    <Modal open onClose={onClose} size="xl" title={media.name} description={media.originalFilename}>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <div className="overflow-hidden rounded-xl bg-black">
            {media.status !== 'ready' ? (
              <div className="grid aspect-video place-items-center text-sm text-ink-300">{media.status === 'processing' ? 'Processando arquivo…' : 'Processamento falhou'}</div>
            ) : media.type === 'video' ? (
              <video src={media.fileUrl ?? undefined} poster={media.previewUrl ?? undefined} controls preload="metadata" className="aspect-video w-full" />
            ) : (
              <img src={media.previewUrl ?? media.fileUrl ?? undefined} alt={media.name} className="aspect-video w-full object-contain" />
            )}
          </div>
          {media.status === 'failed' && <Alert tone="red" title="Não foi possível processar este arquivo">{media.error}</Alert>}
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2.5 rounded-xl border border-ink-100 bg-ink-50/50 p-4 text-[13px] sm:grid-cols-3">
            {[
              ['Tipo', media.type === 'video' ? 'Vídeo' : 'Imagem'],
              ['Formato', media.mimeType.replace(/^\w+\//, '').toUpperCase() + (media.videoCodec ? ` · ${media.videoCodec.toUpperCase()}` : '')],
              ['Tamanho', formatBytes(media.sizeBytes)],
              ['Resolução', resolution(media.width, media.height)],
              ['Duração', media.type === 'video' ? formatDuration(media.durationMs) : 'definida na playlist'],
              ['Enviado em', formatDateTime(media.createdAt)],
              ['Enviado por', media.uploadedBy ?? '—'],
              ['Convertido', media.transcoded ? `Sim (original de ${formatBytes(media.originalSize)} preservado)` : 'Não'],
            ].map(([k, v]) => (
              <div key={k} className="min-w-0">
                <dt className="text-ink-500">{k}</dt>
                <dd className="truncate font-medium text-ink-800" title={String(v)}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="space-y-5">
          <Field label="Nome">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Descrição" hint="Opcional. Visível apenas no painel.">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} rows={3} />
          </Field>
          <Button icon={<Pencil />} disabled={!dirty || !name.trim()} loading={save.isPending} onClick={() => save.mutate()}>
            Salvar informações
          </Button>

          <div className="border-t border-ink-100 pt-5">
            <Field label="Adicionar à playlist" hint="A mídia entra no final do rascunho. O telão só muda após publicar.">
              <div className="flex gap-2">
                <Select value={playlistId} onChange={(e) => setPlaylistId(e.target.value)} disabled={media.status !== 'ready'}>
                  <option value="">Selecione…</option>
                  {playlists.data?.playlists.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
                <Button icon={<ListPlus />} disabled={!playlistId || media.status !== 'ready'} loading={addToPlaylist.isPending} onClick={() => addToPlaylist.mutate()}>
                  Adicionar
                </Button>
              </div>
            </Field>
          </div>

          <div className="border-t border-ink-100 pt-5 text-[13px]">
            <p className="font-medium text-ink-700">Uso</p>
            {usage.data?.playlists.length ? <p className="mt-1 text-ink-600">Playlists: {usage.data.playlists.map((p) => p.name).join(', ')}</p> : <p className="mt-1 text-ink-500">Não está em nenhuma playlist.</p>}
            {!!usage.data?.activeOn.length && (
              <p className={cn('mt-1 text-emerald-700')}>Em exibição / programada em: {[...new Set(usage.data.activeOn)].join(', ')}</p>
            )}
          </div>

          <div className="border-t border-ink-100 pt-5">
            <Button variant="ghost" className="text-red-700 hover:bg-red-50 hover:text-red-800" icon={<Trash />} onClick={remove} disabled={media.status === 'processing'}>
              Remover da biblioteca
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
