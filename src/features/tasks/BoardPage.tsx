import {
  useState,
  useRef,
  type FormEvent,
  type DragEvent,
  type TouchEvent,
  type MouseEvent,
} from 'react';
import { IonIcon } from '@ionic/react';
import {
  addOutline,
  checkmarkCircle,
  createOutline,
  personOutline,
  reorderTwoOutline,
  timeOutline,
  trashOutline,
  swapHorizontalOutline,
} from 'ionicons/icons';
import { Link } from 'react-router-dom';
import type { TaskPriority, TaskStatus } from '../../../protocol/contracts';
import type { Member, Task } from '../../domain/models';
import { canAuthorEvent, canChangeTaskStatus } from '../../domain/permissions/permissions';
import { useWorkspace } from '../../app/workspace-context';
import { Modal } from '../../shared/Modal';
import { BottomSheet } from '../../shared/BottomSheet';
import { useFeedback } from '../../shared/feedback';

interface ChannelMemberSelectorProps {
  members: Member[];
  currentUserDeviceId: string;
  selectedDeviceId: string;
  onChange: (deviceId: string) => void;
  selectId?: string;
}

function ChannelMemberSelector({
  members,
  currentUserDeviceId,
  selectedDeviceId,
  onChange,
  selectId,
}: ChannelMemberSelectorProps) {
  return (
    <div className="member-assignee-picker">
      <div className="member-assignee-pills" role="radiogroup" aria-label="Assign to channel member">
        <button
          type="button"
          role="radio"
          aria-checked={selectedDeviceId === ''}
          className={`member-assignee-pill ${selectedDeviceId === '' ? 'is-selected' : ''}`}
          onClick={() => onChange('')}
        >
          <span className="assignee-avatar member-assignee-pill__avatar">—</span>
          <span className="member-assignee-pill__info">
            <strong className="member-assignee-pill__name">Unassigned</strong>
            <small className="member-assignee-pill__meta">Anyone in channel</small>
          </span>
        </button>

        {members.map((member) => {
          const isSelected = selectedDeviceId === member.deviceId;
          const isSelf = member.deviceId === currentUserDeviceId;
          return (
            <button
              key={member.deviceId}
              type="button"
              role="radio"
              aria-checked={isSelected}
              className={`member-assignee-pill ${isSelected ? 'is-selected' : ''}`}
              onClick={() => onChange(member.deviceId)}
            >
              <span className="assignee-avatar member-assignee-pill__avatar">
                {member.initials}
              </span>
              <span className="member-assignee-pill__info">
                <strong className="member-assignee-pill__name">
                  {member.displayName}
                  {isSelf ? ' (You)' : ''}
                </strong>
                <small className="member-assignee-pill__meta">
                  {member.role} · nodic-{member.deviceId.slice(0, 8)}
                </small>
              </span>
              {isSelected && (
                <IonIcon
                  icon={checkmarkCircle}
                  className="member-assignee-pill__check"
                  aria-hidden="true"
                />
              )}
            </button>
          );
        })}
      </div>

      <select
        id={selectId}
        aria-label="Assign to channel member dropdown"
        value={selectedDeviceId}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: '100%',
          padding: '9px 12px',
          borderRadius: '8px',
          border: '1px solid var(--nodic-line)',
          background: 'white',
          marginTop: '8px',
          fontSize: '13px',
        }}
      >
        <option value="">Unassigned</option>
        {members.map((m) => (
          <option key={m.deviceId} value={m.deviceId}>
            {m.displayName}
            {m.deviceId === currentUserDeviceId ? ' (You)' : ''} — {m.role}
          </option>
        ))}
      </select>
    </div>
  );
}

export const BOARD_COLUMNS: Array<{ status: TaskStatus; label: string; shortLabel: string }> = [
  { status: 'TODO', label: 'To Do', shortLabel: 'To Do' },
  { status: 'IN_PROGRESS', label: 'In Progress', shortLabel: 'In Prog' },
  { status: 'DONE', label: 'Done', shortLabel: 'Done' },
];

export function normalizeColumnStatus(status: TaskStatus): TaskStatus {
  if (status === 'BLOCKED') return 'IN_PROGRESS';
  if (status === 'BACKLOG') return 'TODO';
  return status;
}

interface TaskCardProps {
  task: Task;
  canMove: boolean;
  isDragging: boolean;
  onSelect: (task: Task) => void;
  onMoveToStatus: (taskId: string, targetStatus: TaskStatus) => void;
  onDragStartCard: (taskId: string) => void;
  onDragEndCard: () => void;
  onTouchDragMoveColumn: (taskId: string, targetStatus: TaskStatus | null) => void;
  onTouchDropColumn: (taskId: string, targetStatus: TaskStatus | null) => void;
}

function TaskCard({
  task,
  canMove,
  isDragging,
  onSelect,
  onMoveToStatus,
  onDragStartCard,
  onDragEndCard,
  onTouchDragMoveColumn,
  onTouchDropColumn,
}: TaskCardProps) {
  const { channel } = useWorkspace();
  const assignee = channel?.members.find((member) => member.deviceId === task.assigneeDeviceId);
  const effectiveStatus = normalizeColumnStatus(task.status);
  const otherColumns = BOARD_COLUMNS.filter((col) => col.status !== effectiveStatus);

  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const isTouchDraggingRef = useRef(false);
  const lastHoverStatusRef = useRef<TaskStatus | null>(null);
  const suppressNextClickRef = useRef(false);

  const handleDragStart = (e: DragEvent<HTMLElement>) => {
    if (!canMove) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData('text/plain', task.id);
    e.dataTransfer.effectAllowed = 'move';
    onDragStartCard(task.id);
  };

  const handleDragEnd = () => {
    onDragEndCard();
  };

  const handleTouchStart = (e: TouchEvent<HTMLElement>) => {
    if (!canMove) return;
    const touch = e.touches[0];
    if (!touch) return;
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    isTouchDraggingRef.current = false;
    lastHoverStatusRef.current = null;
  };

  const handleTouchMove = (e: TouchEvent<HTMLElement>) => {
    if (!canMove || !touchStartRef.current) return;
    const touch = e.touches[0];
    if (!touch) return;

    const dx = touch.clientX - touchStartRef.current.x;
    const dy = touch.clientY - touchStartRef.current.y;
    const distance = Math.hypot(dx, dy);

    if (!isTouchDraggingRef.current && distance > 12) {
      isTouchDraggingRef.current = true;
      onDragStartCard(task.id);
    }

    if (isTouchDraggingRef.current) {
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      const colEl = el?.closest('[data-column-status]') as HTMLElement | null;
      const hoverStatus = (colEl?.dataset.columnStatus as TaskStatus | undefined) ?? null;
      lastHoverStatusRef.current = hoverStatus;
      onTouchDragMoveColumn(task.id, hoverStatus);
    }
  };

  const handleTouchEnd = () => {
    if (isTouchDraggingRef.current) {
      suppressNextClickRef.current = true;
      const dropStatus = lastHoverStatusRef.current;
      isTouchDraggingRef.current = false;
      touchStartRef.current = null;
      lastHoverStatusRef.current = null;
      onTouchDropColumn(task.id, dropStatus);
      return;
    }
    touchStartRef.current = null;
  };

  const handleCardClick = (e: MouseEvent<HTMLElement>) => {
    if (suppressNextClickRef.current) {
      suppressNextClickRef.current = false;
      e.preventDefault();
      return;
    }
    onSelect(task);
  };

  return (
    <article
      className={`task-card priority-${task.priority.toLowerCase()} ${
        isDragging ? 'is-dragging' : ''
      } ${canMove ? 'is-draggable' : ''}`}
      draggable={canMove}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onClick={handleCardClick}
      role="button"
      tabIndex={0}
      aria-label={`Task: ${task.title}. Click to view details or drag to another column.`}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(task);
        }
      }}
    >
      <div className="task-card__topline">
        <span className="priority-label">{task.priority}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {task.pending && <span style={{ fontSize: '10px', color: '#b45309' }}>Syncing...</span>}
          {canMove && (
            <span
              className="task-card__drag-handle"
              title="Drag to any column"
              aria-hidden="true"
            >
              <IonIcon icon={reorderTwoOutline} />
            </span>
          )}
        </div>
      </div>

      <h3>{task.title}</h3>
      {task.description && <p className="task-card__desc-preview">{task.description}</p>}

      <footer>
        <span className="assignee-avatar" title={assignee?.displayName}>
          {assignee?.initials ?? '—'}
        </span>
        <span
          style={{
            fontSize: '11px',
            color: 'var(--nodic-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {assignee?.displayName ?? 'Unassigned'}
        </span>

        {canMove && (
          <div
            className="task-card__move-actions"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {otherColumns.map((col) => (
              <button
                key={col.status}
                type="button"
                className="task-move-chip"
                onClick={() => onMoveToStatus(task.id, col.status)}
                aria-label={`Move ${task.title} to ${col.label}`}
                title={`Move to ${col.label}`}
              >
                → {col.shortLabel}
              </button>
            ))}
          </div>
        )}
      </footer>
    </article>
  );
}

export function BoardPage() {
  const { channel, tasks, createTask, moveTask, updateTask, archiveTask } = useWorkspace();
  const feedback = useFeedback();
  const [showModal, setShowModal] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('MEDIUM');
  const [assigneeDeviceId, setAssigneeDeviceId] = useState('');

  // Drag & Drop state
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dragOverStatus, setDragOverStatus] = useState<TaskStatus | null>(null);

  // Selected Task for BottomSheet view
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [isEditingTask, setIsEditingTask] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editPriority, setEditPriority] = useState<TaskPriority>('MEDIUM');
  const [editAssigneeId, setEditAssigneeId] = useState('');

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
            <p
              style={{
                maxWidth: '380px',
                color: 'var(--nodic-ink)',
                margin: 0,
                fontSize: '16px',
                fontWeight: 500,
                lineHeight: 1.6,
              }}
            >
              you have no channel space yet.
              <br />
              please create one to load your channel and start collaborating.
            </p>
            <Link to="/network">
              <button className="dialog-btn-primary">Open Network Configuration & Join</button>
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const currentUser = channel.members.find((m) => m.deviceId === channel.currentUserDeviceId);
  const canManageTasks = currentUser
    ? canAuthorEvent(currentUser.role, 'TASK_FIELDS_UPDATED')
    : false;

  const canUserMoveTask = (task: Task): boolean => {
    if (!currentUser) return true;
    return canChangeTaskStatus({
      role: currentUser.role,
      actorDeviceId: currentUser.deviceId,
      assigneeDeviceId: task.assigneeDeviceId,
    });
  };

  const selectedTask = tasks.find((t) => t.id === selectedTaskId && !t.archived) ?? null;
  const selectedAssignee = channel.members.find(
    (m) => m.deviceId === selectedTask?.assigneeDeviceId,
  );
  const selectedTaskColumn = BOARD_COLUMNS.find(
    (c) => c.status === (selectedTask ? normalizeColumnStatus(selectedTask.status) : 'TODO'),
  );

  function handleSelectTask(task: Task) {
    setSelectedTaskId(task.id);
    setIsEditingTask(false);
    setEditTitle(task.title);
    setEditDescription(task.description ?? '');
    setEditPriority(task.priority);
    setEditAssigneeId(task.assigneeDeviceId ?? '');
  }

  function handleCloseBottomSheet() {
    setSelectedTaskId(null);
    setIsEditingTask(false);
  }

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;

    const ok = await feedback.run(
      () =>
        createTask({
          title: title.trim(),
          description: description.trim() || undefined,
          priority,
          assigneeDeviceId: assigneeDeviceId || undefined,
        }),
      { success: 'Task created' },
    );
    if (!ok) return; // keep the form open so nothing is lost

    setTitle('');
    setDescription('');
    setPriority('MEDIUM');
    setAssigneeDeviceId('');
    setShowModal(false);
  }

  async function handleSaveTaskEdit(e: FormEvent) {
    e.preventDefault();
    if (!selectedTask || !editTitle.trim()) return;

    const ok = await feedback.run(
      () =>
        updateTask(selectedTask.id, {
          title: editTitle.trim(),
          description: editDescription.trim() || null,
          priority: editPriority,
          assigneeDeviceId: editAssigneeId || null,
        }),
      { success: 'Task updated' },
    );
    if (ok) setIsEditingTask(false);
  }

  async function handleArchiveSelectedTask() {
    if (!selectedTask) return;
    const ok = await feedback.run(() => archiveTask(selectedTask.id), { success: 'Task archived' });
    if (ok) handleCloseBottomSheet();
  }

  function handleMoveTaskToStatus(taskId: string, targetStatus: TaskStatus) {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    if (normalizeColumnStatus(task.status) === targetStatus && task.status === targetStatus) {
      return;
    }
    void feedback.run(() => moveTask(taskId, targetStatus), { error: "Couldn't move the task. You may not have permission." });
  }

  function handleColumnDragOver(e: DragEvent<HTMLDivElement>, status: TaskStatus) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverStatus !== status) {
      setDragOverStatus(status);
    }
  }

  function handleColumnDragEnter(e: DragEvent<HTMLDivElement>, status: TaskStatus) {
    e.preventDefault();
    setDragOverStatus(status);
  }

  function handleColumnDragLeave(e: DragEvent<HTMLDivElement>, status: TaskStatus) {
    const related = e.relatedTarget as Node | null;
    if (!e.currentTarget.contains(related)) {
      if (dragOverStatus === status) {
        setDragOverStatus(null);
      }
    }
  }

  function handleColumnDrop(e: DragEvent<HTMLDivElement>, targetStatus: TaskStatus) {
    e.preventDefault();
    const droppedTaskId = e.dataTransfer.getData('text/plain') || draggingTaskId;
    setDraggingTaskId(null);
    setDragOverStatus(null);

    if (droppedTaskId) {
      handleMoveTaskToStatus(droppedTaskId, targetStatus);
    }
  }

  return (
    <div className="screen-container">
      <div className="page-wrap">
        {/* Header Chip matching wireframe prototype */}
        <div className="channel-header-chip">
          <div>
            <strong>{channel.name}</strong>
            <small>Kanban Board · Drag cards or tap to view</small>
          </div>
          <button className="dialog-btn-primary" onClick={() => setShowModal(true)}>
            <IonIcon icon={addOutline} style={{ marginRight: '4px', verticalAlign: 'middle' }} />
            Add Card
          </button>
        </div>

        {/* Kanban Columns */}
        <div className="kanban-wire-columns" aria-label="Kanban Columns">
          {BOARD_COLUMNS.map((column) => {
            const columnTasks = tasks.filter(
              (task) => !task.archived && normalizeColumnStatus(task.status) === column.status,
            );
            const isDropTarget = dragOverStatus === column.status && draggingTaskId !== null;

            return (
              <div
                className={`kanban-wire-column ${isDropTarget ? 'is-drop-target' : ''}`}
                key={column.status}
                data-column-status={column.status}
                onDragOver={(e) => handleColumnDragOver(e, column.status)}
                onDragEnter={(e) => handleColumnDragEnter(e, column.status)}
                onDragLeave={(e) => handleColumnDragLeave(e, column.status)}
                onDrop={(e) => handleColumnDrop(e, column.status)}
              >
                <div className="kanban-wire-header">
                  <span>{column.label}</span>
                  <span
                    style={{
                      background: '#dce8ea',
                      padding: '2px 8px',
                      borderRadius: '10px',
                      fontSize: '11px',
                    }}
                  >
                    {columnTasks.length}
                  </span>
                </div>

                <div className="kanban-column-dropzone" style={{ flex: 1 }}>
                  {columnTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      canMove={canUserMoveTask(task)}
                      isDragging={draggingTaskId === task.id}
                      onSelect={handleSelectTask}
                      onMoveToStatus={handleMoveTaskToStatus}
                      onDragStartCard={(taskId) => setDraggingTaskId(taskId)}
                      onDragEndCard={() => {
                        setDraggingTaskId(null);
                        setDragOverStatus(null);
                      }}
                      onTouchDragMoveColumn={(_taskId, hoverStatus) => {
                        setDragOverStatus(hoverStatus);
                      }}
                      onTouchDropColumn={(taskId, targetStatus) => {
                        setDraggingTaskId(null);
                        setDragOverStatus(null);
                        if (targetStatus) {
                          handleMoveTaskToStatus(taskId, targetStatus);
                        }
                      }}
                    />
                  ))}
                  {columnTasks.length === 0 && (
                    <div
                      className={`kanban-empty-slot ${isDropTarget ? 'is-active' : ''}`}
                      style={{
                        padding: '24px 8px',
                        color: 'var(--nodic-muted)',
                        textAlign: 'center',
                        fontSize: '12px',
                      }}
                    >
                      {isDropTarget ? `Drop card into ${column.label}` : 'No cards'}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Task Details BottomSheet */}
        <BottomSheet
          isOpen={Boolean(selectedTask)}
          onClose={handleCloseBottomSheet}
          title={selectedTask?.title}
          subtitle={
            selectedTask
              ? `Updated ${new Date(selectedTask.updatedAt).toLocaleString([], {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}`
              : undefined
          }
          headerBadge={
            selectedTask ? (
              <div className="task-sheet-badges">
                <span
                  className={`task-sheet-priority-badge priority-${selectedTask.priority.toLowerCase()}`}
                >
                  {selectedTask.priority}
                </span>
                <span className="task-sheet-status-badge">
                  {selectedTaskColumn?.label ?? selectedTask.status}
                </span>
                {selectedTask.pending && (
                  <span className="task-sheet-sync-badge">Syncing...</span>
                )}
              </div>
            ) : undefined
          }
          footer={
            selectedTask && canManageTasks && !isEditingTask ? (
              <div className="task-sheet-footer-actions">
                <button
                  type="button"
                  className="dialog-btn-outline"
                  onClick={() => setIsEditingTask(true)}
                >
                  <IonIcon
                    icon={createOutline}
                    style={{ marginRight: '6px', verticalAlign: 'middle' }}
                  />
                  Edit Task
                </button>
                <button
                  type="button"
                  className="dialog-btn-danger"
                  onClick={() => void handleArchiveSelectedTask()}
                >
                  <IonIcon
                    icon={trashOutline}
                    style={{ marginRight: '6px', verticalAlign: 'middle' }}
                  />
                  Archive
                </button>
              </div>
            ) : undefined
          }
        >
          {selectedTask && !isEditingTask && (
            <div className="task-sheet-content">
              {/* Description Section */}
              <div className="task-sheet-section">
                <span className="task-sheet-label">Description</span>
                <p className="task-sheet-description">
                  {selectedTask.description || 'No description provided for this task.'}
                </p>
              </div>

              {/* Non-Linear Move to Column Switcher */}
              <div className="task-sheet-section">
                <span className="task-sheet-label">
                  <IonIcon
                    icon={swapHorizontalOutline}
                    style={{ marginRight: '4px', verticalAlign: 'middle' }}
                  />
                  Move to Column
                </span>
                <div className="task-sheet-column-switcher" role="group" aria-label="Move task to column">
                  {BOARD_COLUMNS.map((col) => {
                    const isCurrent =
                      normalizeColumnStatus(selectedTask.status) === col.status;
                    const allowed = canUserMoveTask(selectedTask);
                    return (
                      <button
                        key={col.status}
                        type="button"
                        disabled={!allowed}
                        className={`task-sheet-column-btn ${isCurrent ? 'is-active' : ''}`}
                        onClick={() => handleMoveTaskToStatus(selectedTask.id, col.status)}
                        aria-pressed={isCurrent}
                      >
                        {isCurrent && (
                          <IonIcon
                            icon={checkmarkCircle}
                            style={{ marginRight: '5px', fontSize: '15px' }}
                          />
                        )}
                        <span>{col.label}</span>
                      </button>
                    );
                  })}
                </div>
                {!canUserMoveTask(selectedTask) && (
                  <small style={{ color: 'var(--nodic-muted)', fontSize: '11px' }}>
                    Only the assigned member, Co-Lead, or Team Lead can change this task&apos;s status.
                  </small>
                )}
              </div>

              {/* Assignee & Metadata Grid */}
              <div className="task-sheet-meta-grid">
                <div className="task-sheet-meta-card">
                  <span className="task-sheet-label">
                    <IonIcon
                      icon={personOutline}
                      style={{ marginRight: '4px', verticalAlign: 'middle' }}
                    />
                    Assignee
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px' }}>
                    <span className="assignee-avatar" style={{ width: '30px', height: '30px', fontSize: '11px' }}>
                      {selectedAssignee?.initials ?? '—'}
                    </span>
                    <div>
                      <strong style={{ display: 'block', fontSize: '13px', color: 'var(--nodic-ink)' }}>
                        {selectedAssignee?.displayName ?? 'Unassigned'}
                      </strong>
                      <small style={{ fontSize: '11px', color: 'var(--nodic-muted)' }}>
                        {selectedAssignee
                          ? `${selectedAssignee.role} · ${selectedAssignee.presence}`
                          : 'No member assigned'}
                      </small>
                    </div>
                  </div>
                </div>

                <div className="task-sheet-meta-card">
                  <span className="task-sheet-label">
                    <IonIcon
                      icon={timeOutline}
                      style={{ marginRight: '4px', verticalAlign: 'middle' }}
                    />
                    Last Activity
                  </span>
                  <div style={{ marginTop: '6px' }}>
                    <strong style={{ display: 'block', fontSize: '13px', color: 'var(--nodic-ink)' }}>
                      {new Date(selectedTask.updatedAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </strong>
                    <small style={{ fontSize: '11px', color: 'var(--nodic-muted)' }}>
                      {new Date(selectedTask.updatedAt).toLocaleDateString()}
                    </small>
                  </div>
                </div>
              </div>
            </div>
          )}

          {selectedTask && isEditingTask && (
            <form
              onSubmit={(e) => void handleSaveTaskEdit(e)}
              style={{ display: 'grid', gap: '14px' }}
            >
              <div>
                <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '13px' }}>
                  Task Title *
                </label>
                <input
                  type="text"
                  required
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    border: '1px solid var(--nodic-line)',
                    background: 'white',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '13px' }}>
                  Description
                </label>
                <textarea
                  rows={3}
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    border: '1px solid var(--nodic-line)',
                    background: 'white',
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '13px' }}>
                  Priority
                </label>
                <select
                  value={editPriority}
                  onChange={(e) => setEditPriority(e.target.value as TaskPriority)}
                  style={{
                    width: '100%',
                    padding: '10px 12px',
                    borderRadius: '8px',
                    border: '1px solid var(--nodic-line)',
                    background: 'white',
                  }}
                >
                  <option value="LOW">Low</option>
                  <option value="MEDIUM">Medium</option>
                  <option value="HIGH">High</option>
                  <option value="URGENT">Urgent</option>
                </select>
              </div>

              <div>
                <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '13px' }}>
                  Assign to Channel Member ({channel.members.length})
                </label>
                <ChannelMemberSelector
                  members={channel.members}
                  currentUserDeviceId={channel.currentUserDeviceId}
                  selectedDeviceId={editAssigneeId}
                  onChange={setEditAssigneeId}
                  selectId="edit-task-assignee-select"
                />
              </div>

              <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '6px' }}>
                <button
                  type="button"
                  className="dialog-btn-outline"
                  onClick={() => setIsEditingTask(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="dialog-btn-primary"
                  disabled={!editTitle.trim()}
                >
                  Save Changes
                </button>
              </div>
            </form>
          )}
        </BottomSheet>

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
              <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '13px' }}>
                Task Title *
              </label>
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. Inspect field nodes"
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: '8px',
                  border: '1px solid var(--nodic-line)',
                  background: 'white',
                }}
              />
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '13px' }}>
                Description
              </label>
              <textarea
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Details or notes..."
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: '8px',
                  border: '1px solid var(--nodic-line)',
                  background: 'white',
                }}
              />
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '13px' }}>
                Priority
              </label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as TaskPriority)}
                style={{
                  width: '100%',
                  padding: '10px 12px',
                  borderRadius: '8px',
                  border: '1px solid var(--nodic-line)',
                  background: 'white',
                }}
              >
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
                <option value="URGENT">Urgent</option>
              </select>
            </div>

            <div>
              <label style={{ display: 'block', marginBottom: '6px', fontWeight: 600, fontSize: '13px' }}>
                Assign to Channel Member ({channel.members.length})
              </label>
              <ChannelMemberSelector
                members={channel.members}
                currentUserDeviceId={channel.currentUserDeviceId}
                selectedDeviceId={assigneeDeviceId}
                onChange={setAssigneeDeviceId}
                selectId="create-task-assignee-select"
              />
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
