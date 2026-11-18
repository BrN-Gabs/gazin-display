import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, ListVideo, Pencil, Plus, Trash } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { formatDateTime, formatDuration } from '../lib/format';
import { Badge, Button, Card, EmptyState, Field, Input, Loading, Modal, PageHeader, Textarea, useConfirm } from '../components/ui';

interface PlaylistRow {
  id: string;
  name: string;
  description: string | null;
  itemCount: number;
  scheduleCount: number;
  updatedAt: string;
  createdBy: string | null;
  latestVersion: { number: number; publishedAt: string; publishedBy: string | null; totalDurationMs: number } | null;
  hasUnpublishedChanges: boolean;
  devices: Array<{ id: string; name: string }>;
  thumbnails: string[];
}

export function PlaylistStatus({ p }: { p: { latestVersion: { number: number } | null; hasUnpublishedChanges: boolean } }) {
  if (!p.latestVersion) return <Badge tone="neutral">Nunca publicada</Badge>;
  if (p.hasUnpublishedChanges) return <Badge tone="amber">Alterações não publicadas</Badge>;
  return <Badge tone="green">Publicada · v{p.latestVersion.number}</Badge>;
}

export default function Playlists() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const { data, isLoading } = useQuery({ queryKey: ['playlists'], queryFn: () => api<{ playlists: PlaylistRow[] }>('/api/playlists') });

  const create = useMutation({
    mutationFn: () => api<{ playlist: { id: string } }>('/api/playlists', { body: { name: name.trim(), description: description.trim() || undefined } }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['playlists'] });
      navigate(`/admin/playlists/${r.playlist.id}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const duplicate = async (p: PlaylistRow) => {
    try {
      const r = await api<{ playlist: { id: string } }>(`/api/playlists/${p.id}/duplicate`, { body: {} });
      toast.success('Playlist duplicada');
      void qc.invalidateQueries({ queryKey: ['playlists'] });
      navigate(`/admin/playlists/${r.playlist.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const remove = async (p: PlaylistRow) => {
    if (!(await confirm({ title: `Excluir "${p.name}"?`, description: 'A playlist e o histórico de versões serão excluídos. As mídias continuam na biblioteca.', confirmLabel: 'Excluir' }))) return;
    try {
      await api(`/api/playlists/${p.id}`, { method: 'DELETE' });
      toast.success('Playlist excluída');
      void qc.invalidateQueries({ queryKey: ['playlists'] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  return (
    <div>
      <PageHeader
        title="Playlists"
        description="Monte sequências de vídeos e imagens, salve como rascunho e publique nos telões."
        actions={
          <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
            Nova playlist
          </Button>
        }
      />
      {isLoading ? (
        <Loading />
      ) : !data?.playlists.length ? (
        <Card>
          <EmptyState
            icon={<ListVideo />}
            title="Nenhuma playlist criada"
            description="Crie a primeira playlist para organizar a programação do telão."
            action={
              <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
                Criar playlist
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          {data.playlists.map((p) => (
            <Card key={p.id} className="flex flex-col overflow-hidden transition hover:border-brand-200">
              <Link to={`/admin/playlists/${p.id}`} className="grid h-28 grid-cols-4 gap-px bg-ink-100">
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i} className="bg-ink-50">
                    {p.thumbnails[i] && <img src={p.thumbnails[i]} alt="" className="h-full w-full object-cover" loading="lazy" />}
                  </div>
                ))}
              </Link>
              <div className="flex flex-1 flex-col p-4">
                <div className="flex items-start justify-between gap-3">
                  <Link to={`/admin/playlists/${p.id}`} className="min-w-0">
                    <h3 className="truncate text-[15px] font-semibold text-ink-900 hover:text-brand-700">{p.name}</h3>
                    <p className="truncate text-xs text-ink-500">{p.description || `${p.itemCount} item(ns)${p.latestVersion ? ` · ${formatDuration(p.latestVersion.totalDurationMs)}` : ''}`}</p>
                  </Link>
                  <PlaylistStatus p={p} />
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {p.devices.map((d) => (
                    <Badge key={d.id} tone="brand">
                      {d.name}
                    </Badge>
                  ))}
                  {p.scheduleCount > 0 && <Badge tone="violet">{p.scheduleCount} agendamento(s)</Badge>}
                </div>
                <div className="mt-auto flex items-center justify-between gap-2 pt-4">
                  <span className="text-xs text-ink-500">Atualizada {formatDateTime(p.updatedAt)}</span>
                  <div className="flex gap-1">
                    <Button size="icon-sm" variant="ghost" title="Duplicar" onClick={() => duplicate(p)}>
                      <Copy />
                    </Button>
                    <Button size="icon-sm" variant="ghost" title="Excluir" onClick={() => remove(p)}>
                      <Trash />
                    </Button>
                    <Link to={`/admin/playlists/${p.id}`}>
                      <Button size="sm" icon={<Pencil />}>
                        Editar
                      </Button>
                    </Link>
                  </div>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Nova playlist"
        footer={
          <>
            <Button onClick={() => setCreating(false)}>Cancelar</Button>
            <Button variant="primary" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
              Criar e editar
            </Button>
          </>
        }
      >
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <Field label="Nome">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Telão da Matriz — Institucional" maxLength={120} />
          </Field>
          <Field label="Descrição" hint="Opcional.">
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} maxLength={500} />
          </Field>
        </form>
      </Modal>
    </div>
  );
}
