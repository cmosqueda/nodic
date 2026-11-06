import { useState, type FormEvent } from 'react';
import { IonIcon } from '@ionic/react';
import { addOutline, chevronForwardOutline } from 'ionicons/icons';
import { Link } from 'react-router-dom';
import type { TaskPriority, TaskStatus } from '../../../protocol/contracts';
import type { Task } from '../../domain/models';
import { useWorkspace } from '../../app/workspace-context';
import { Modal } from '../../shared/Modal';

const columns: Array<{ status: TaskStatus; label: string }> = [
  { status: 'TODO', label: 'To Do' },
  { status: 'IN_PROGRESS', label: 'In Progress' },
  { status: 'DONE', label: 'Done' },
];

function TaskCard({ task, nextStatus }: { task: Task; nextStatus?: TaskStatus }) {
  const { channel, moveTask } = useWorkspace();
  const assignee = channel?.members.find((member) => member.deviceId === task.assigneeDeviceId);

  return (
    <article className={`task-card priority-${task.priority.toLowerCase()}`}>
      <div className="task-card__topline">
        <span className="priority-label">{task.priority}</span>
        {task.pending && <span style={{ fontSize: '10px', color: '#b45309' }}>Syncing...</span>}
      </div>
      <h3>{task.title}</h3>
      {task.description && <p>{task.description}</p>}
      <footer>
        <span className="assignee-avatar" title={assignee?.displayName}>
          {assignee?.initials ?? '—'}
        </span>
        <span style={{ fontSize: '11px', color: 'var(--nodic-muted)' }}>
          {assignee?.displayName ?? 'Unassigned'}
        </span>
        {nextStatus && (
          <button
            className="advance-task"
            onClick={() => void moveTask(task.id, nextStatus)}
            aria-label={`Move ${task.title} forward`}
          >
            <IonIcon icon={chevronForwardOutline} />
          </button>
        )}
      </footer>
    </article>
  );
}

export function BoardPage() {
  const { channel, tasks, createTask } = useWorkspace();
  const [showModal, setShowModal] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('MEDIUM');
  const [assigneeDeviceId, setAssigneeDeviceId] = useState('');

  if (!channel) {
    return (
      <div className="screen-container">
        <div className="page-wrap narrow-page" style={{ textAlign: 'center', paddingTop: '40px' }}>
          <div
            className="hub-card"
            style={{
              display: 'grid',
              gap: '16px',
              textAlign: 'center',
              placeItems: 'center',
              padding: '48px 24px',
            }}
          >
            <p style={{ maxWidth: '380px', color: 'var(--nodic-ink)', margin: 0, fontSize: '16px', fontWeight: 500, lineHeight: 1.6 }}>
              you have no channel space yet.<br />
              please create one to load your channel and start collaborating.
            </p>
            <Link to="/network">
              <button className="dialog-btn-primary">
                Open Network Configuration & Join
              </button>
            </Link>
          </div>
        </div>
      </div>
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
    <div className="screen-container">
      <div className="page-wrap">
        {/* Header Chip matching wireframe prototype */}
        <div className="channel-header-chip">
          <div>
            <strong>{channel.name}</strong>
            <small>Kanban Board</small>
          </div>
          <button className="dialog-btn-primary" onClick={() => setShowModal(true)}>
            <IonIcon icon={addOutline} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
            Add Card
          </button>
        </div>

        {/* Kanban Columns */}
        <div className="kanban-wire-columns" aria-label="Kanban Columns">
          {columns.map((column, columnIndex) => {
            const columnTasks = tasks.filter(
              (task) =>
                task.status === column.status ||
                (column.status === 'IN_PROGRESS' && task.status === 'BLOCKED'),
            );
            const nextStatus = columns[columnIndex + 1]?.status;

            return (
              <div className="kanban-wire-column" key={column.status}>
                <div className="kanban-wire-header">
                  <span>{column.label}</span>
                  <span style={{ background: '#dce8ea', padding: '2px 8px', borderRadius: '10px', fontSize: '11px' }}>
                    {columnTasks.length}
                  </span>
                </div>

                <div style={{ flex: 1 }}>
                  {columnTasks.map((task) => (
                    <TaskCard key={task.id} task={task} nextStatus={nextStatus} />
                  ))}
                  {columnTasks.length === 0 && (
                    <div style={{ padding: '24px 8px', color: 'var(--nodic-muted)', textAlign: 'center', fontSize: '12px' }}>
                      No cards
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* New Task Pure React Modal */}
        <Modal
          isOpen={showModal}
          onClose={() => setShowModal(false)}
          title="Create New Task"
        >
          <form
            onSubmit={(e) => void handleCreate(e)}
            style={{ display: 'grid', gap: '14px' }}
          >
            <div>
              <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '13px' }}>Task Title *</label>
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Inspect field nodes"
                style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '13px' }}>Description</label>
              <textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Details or notes..."
                style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white' }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '13px' }}>Priority</label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as TaskPriority)}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white' }}
                >
                  <option value="LOW">Low</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="HIGH">High</option>
                  <option value="URGENT">Urgent</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '13px' }}>Assignee</label>
                <select
                  value={assigneeDeviceId}
                  onChange={(e) => setAssigneeDeviceId(e.target.value)}
                  style={{ width: '100%', padding: '10px 12px', borderRadius: '8px', border: '1px solid var(--nodic-line)', background: 'white' }}
                >
                  <option value="">Unassigned</option>
                  {channel.members.map((m) => (
                    <option key={m.deviceId} value={m.deviceId}>
                      {m.displayName}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div style={{ display: 'flex', gap: '10px', marginTop: '10px', justifyContent: 'flex-end' }}>
              <button type="button" className="dialog-btn-outline" onClick={() => setShowModal(false)}>
                Cancel
              </button>
              <button type="submit" className="dialog-btn-primary" disabled={!title.trim()}>
                Create
              </button>
            </div>
          </form>
        </Modal>
      </div>
    </div>
  );
}