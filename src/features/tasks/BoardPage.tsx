import { useState, type FormEvent } from 'react';
import {
  IonButton,
  IonContent,
  IonIcon,
  IonModal,
  IonPage,
  IonHeader,
  IonToolbar,
  IonTitle,
  IonButtons,
} from '@ionic/react';
import { addOutline, chevronForwardOutline, closeOutline, cloudDoneOutline, timeOutline } from 'ionicons/icons';
import { Link } from 'react-router-dom';
import type { TaskPriority, TaskStatus } from '../../../protocol/contracts';
import type { Task } from '../../domain/models';
import { useWorkspace } from '../../app/workspace-context';
import { PageHeader } from '../../shared/PageHeader';

const columns: Array<{ status: TaskStatus; label: string }> = [
  { status: 'TODO', label: 'Ready' },
  { status: 'IN_PROGRESS', label: 'In motion' },
  { status: 'BLOCKED', label: 'Needs a link' },
  { status: 'DONE', label: 'Landed' },
];

function formatDue(date: string | null) {
  if (!date) return 'No due date';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(date));
}

function TaskCard({ task, nextStatus }: { task: Task; nextStatus?: TaskStatus }) {
  const { channel, moveTask } = useWorkspace();
  const assignee = channel?.members.find((member) => member.deviceId === task.assigneeDeviceId);

  return (
    <article className={`task-card priority-${task.priority.toLowerCase()}`}>
      <div className="task-card__topline">
        <span className="priority-label">{task.priority}</span>
        {task.pending ? <span className="pending-label"><IonIcon icon={timeOutline} /> Pending</span> : <IonIcon className="synced-icon" icon={cloudDoneOutline} />}
      </div>
      <h3>{task.title}</h3>
      {task.description && <p>{task.description}</p>}
      <footer>
        <span className="assignee-avatar" title={assignee?.displayName}>{assignee?.initials ?? '—'}</span>
        <span className="due-label">{formatDue(task.dueAt)}</span>
        {nextStatus && (
          <button className="advance-task" onClick={() => void moveTask(task.id, nextStatus)} aria-label={`Move ${task.title} forward`}>
            <IonIcon icon={chevronForwardOutline} />
          </button>
        )}
      </footer>
    </article>
  );
}

export function BoardPage() {
  const { channel, identity, tasks, createTask } = useWorkspace();
  const [showModal, setShowModal] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('MEDIUM');
  const [assigneeDeviceId, setAssigneeDeviceId] = useState('');

  if (!channel) {
    return (
      <IonPage>
        <IonContent fullscreen>
          <div className="page-wrap narrow-page" style={{ textAlign: 'center', paddingTop: '40px' }}>
            <PageHeader
              eyebrow="Nodic Local Mesh"
              title="No Channel Active"
              detail={`You are connected as "${identity?.displayName ?? 'New User'}" (${identity?.shortId ?? 'nodic-node'}).`}
            />
            <div className="network-card" style={{ display: 'grid', gap: '16px', textAlign: 'center', placeItems: 'center', padding: '36px 20px', gridTemplateColumns: '1fr' }}>
              <p style={{ maxWidth: '420px', color: 'var(--nodic-muted)', margin: 0, fontSize: '15px', lineHeight: 1.5 }}>
                To start coordinating tasks and peer chat, create a channel as Team Lead, or paste an invitation code from a nearby lead.
              </p>
              <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center' }}>
                <Link to="/network">
                  <IonButton className="primary-action">
                    Open Configuration & Channels
                  </IonButton>
                </Link>
              </div>
            </div>
          </div>
        </IonContent>
      </IonPage>
    );
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;

    await createTask({
      title: title.trim(),
      description: description.trim() || undefined,
      priority,
      assigneeDeviceId: assigneeDeviceId || undefined,
    });

    setTitle('');
    setDescription('');
    setPriority('MEDIUM');
    setAssigneeDeviceId('');
    setShowModal(false);
  }

  return (
    <IonPage>
      <IonContent fullscreen>
        <div className="page-wrap board-page">
          <PageHeader
            eyebrow="Team board · Live Local Sync"
            title="Work travels through people."
            detail="Assign the next useful action, then let the network carry it."
            action={
              <IonButton className="primary-action" onClick={() => setShowModal(true)}>
                <IonIcon slot="start" icon={addOutline} />
                New task
              </IonButton>
            }
          />

          <section className="board-summary" aria-label="Board summary">
            <div><strong>{tasks.filter((task) => task.status !== 'DONE').length}</strong><span>Open tasks</span></div>
            <div><strong>{tasks.filter((task) => task.priority === 'URGENT').length}</strong><span>Urgent relay</span></div>
            <div>
              <strong>{tasks.filter((task) => task.pending).length}</strong>
              <Link to="/network" style={{ color: 'var(--nodic-current)', textDecoration: 'none', fontWeight: 600 }}>
                <span>Awaiting peer · Network &rarr;</span>
              </Link>
            </div>
          </section>

          <section className="kanban" aria-label="Team Kanban board">
            {columns.map((column, columnIndex) => {
              const columnTasks = tasks.filter((task) => task.status === column.status);
              const nextStatus = columns[columnIndex + 1]?.status;
              return (
                <div className="kanban-column" key={column.status}>
                  <header><span>{column.label}</span><strong>{columnTasks.length}</strong></header>
                  <div className="kanban-stack">
                    {columnTasks.map((task) => <TaskCard key={task.id} task={task} nextStatus={nextStatus} />)}
                    {columnTasks.length === 0 && <div className="column-empty">Nothing waiting here.</div>}
                  </div>
                </div>
              );
            })}
          </section>

          {/* New Task Modal */}
          <IonModal isOpen={showModal} onDidDismiss={() => setShowModal(false)}>
            <IonHeader>
              <IonToolbar>
                <IonTitle>Create New Task</IonTitle>
                <IonButtons slot="end">
                  <IonButton onClick={() => setShowModal(false)}>
                    <IonIcon icon={closeOutline} />
                  </IonButton>
                </IonButtons>
              </IonToolbar>
            </IonHeader>
            <IonContent className="ion-padding">
              <form onSubmit={(e) => void handleCreate(e)} style={{ display: 'grid', gap: '16px', maxWidth: '500px', margin: '0 auto', paddingTop: '10px' }}>
                <div>
                  <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600 }}>Task Title *</label>
                  <input
                    type="text"
                    required
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="e.g. Inspect power distribution rack"
                    style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white' }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600 }}>Description</label>
                  <textarea
                    rows={3}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Additional context or links..."
                    style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white' }}
                  />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div>
                    <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600 }}>Priority</label>
                    <select
                      value={priority}
                      onChange={(e) => setPriority(e.target.value as TaskPriority)}
                      style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white' }}
                    >
                      <option value="LOW">Low</option>
                      <option value="MEDIUM">Medium</option>
                      <option value="HIGH">High</option>
                      <option value="URGENT">Urgent</option>
                    </select>
                  </div>

                  <div>
                    <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600 }}>Assignee</label>
                    <select
                      value={assigneeDeviceId}
                      onChange={(e) => setAssigneeDeviceId(e.target.value)}
                      style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white' }}
                    >
                      <option value="">Unassigned</option>
                      {channel.members.map((m) => (
                        <option key={m.deviceId} value={m.deviceId}>
                          {m.displayName} ({m.role})
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '10px', marginTop: '12px', justifyContent: 'flex-end' }}>
                  <IonButton fill="outline" onClick={() => setShowModal(false)}>Cancel</IonButton>
                  <IonButton type="submit" disabled={!title.trim()}>Create Task</IonButton>
                </div>
              </form>
            </IonContent>
          </IonModal>
        </div>
      </IonContent>
    </IonPage>
  );
}
