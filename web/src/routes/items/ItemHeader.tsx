import { useId, useState } from 'react';
import { Link } from 'react-router';
import { PRIORITIES, TEXT_LIMITS, type ItemDetailResponse } from '@tasklite/shared';
import {
  BlockedChip,
  Button,
  Chip,
  EditableText,
  IconButton,
  Label,
  Provenance,
  Skeleton,
  StatusChip,
  TypeBadge,
} from '../../components/kit';
import { apiClient } from '../../app/queryClient';
import { queryKeys } from '../../lib/api';
import { paths } from '../../lib/paths';
import { runOwnerMutation, showToast } from '../../lib/undo';

/** Closed provenance on done items (UI_SPEC §6.3 header, second line). */
function ClosedProvenance({ item }: { item: ItemDetailResponse['item'] }) {
  if (item.status !== 'done' || !item.closed_by) return null;
  if (item.closed_by === 'owner') {
    const deferred = item.human_review.deferred;
    return deferred > 0 ? (
      <Provenance kind="owner_defer" label={`Closed · ${deferred} review deferred, not verified`} />
    ) : (
      <Provenance kind="owner_approve" label="Closed after your human review" />
    );
  }
  if (item.closed_by === 'agent')
    return <Provenance kind="agent" label="Closed by agent: checks passed, no human review" />;
  return null;
}

/**
 * The item header (UI_SPEC §6.3): ID, type, epic, labels, "Imported from
 * Jira"; the h1 (editable inline); status, blocked, closed provenance,
 * priority and the contextual actions with the "⋯" overflow. US2 fills the
 * read view; US7 wires the actions.
 */
export function ItemHeader({ id, data }: { id: string; data?: ItemDetailResponse }) {
  const prioId = useId();
  const [menu, setMenu] = useState(false);
  const item = data?.item;
  if (!item) {
    return (
      <div className="tk-head">
        <div className="grow">
          <div className="row wrap">
            <span className="mono muted">{id}</span>
          </div>
          <h1 className="sr">{id}</h1>
          <Skeleton lines={1} label="Loading the title" />
        </div>
      </div>
    );
  }
  const epic = item.type === 'Epic';
  const open = !['done', 'canceled'].includes(item.status);
  const saveTitle = async (title: string) => {
    try {
      const res = await runOwnerMutation(
        () =>
          apiClient['items.patch']({
            params: { id: item.id },
            body: { expected_version: item.version, title },
          }),
        { success: 'Saved. Agents see it on their next read.', refetch: [queryKeys.item(item.id)] },
      );
      return res !== null;
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Couldn’t save. Try again.');
      return false;
    }
  };
  return (
    <div className="tk-head" data-section="header">
      <div className="grow">
        <div className="row wrap">
          <span className="mono muted">{item.id}</span>
          <TypeBadge type={item.type} />
          {item.epic && item.epic_title && (
            <>
              <span className="muted">in</span>
              <Link className="epiclink" to={paths.item(item.epic)}>
                <span className="ed" aria-hidden="true">
                  ◆
                </span>{' '}
                {item.epic_title}
              </Link>
              <span className="mono muted">{item.epic}</span>
            </>
          )}
          {item.labels.map((l) => (
            <Label key={l} project={item.project} name={l} />
          ))}
          {item.jira_key && <Chip kind="neutral">Imported from Jira</Chip>}
        </div>
        <div style={{ marginTop: 4 }}>
          <EditableText
            field="title"
            value={item.title}
            maxLength={TEXT_LIMITS.title}
            onSave={saveTitle}
          >
            <h1 className={item.status === 'canceled' ? 'struck' : undefined}>{item.title}</h1>
          </EditableText>
        </div>
        <div className="row wrap" style={{ marginTop: 6 }}>
          <StatusChip status={item.status} />
          <BlockedChips item={item} />
          <ClosedProvenance item={item} />
          {epic && data && (
            <span className="src">
              {item.project} · {data.children.length} items ·{' '}
              {data.children.filter((c) => c.status === 'done').length} done
            </span>
          )}
          <span className="row" style={{ gap: 4 }}>
            <label className="src" htmlFor={prioId}>
              Priority
            </label>
            <select id={prioId} value={item.priority} disabled title="Lands with US7">
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  P{p}
                </option>
              ))}
            </select>
          </span>
          {item.status === 'inbox' && <Button size="sm">Move to Planning</Button>}
          {item.status === 'planning' && (
            <>
              <Button size="sm" variant="primary" icon="promote">
                Move to Ready
              </Button>
              <span className="src">
                {epic
                  ? 'This epic is still a brief.'
                  : 'Planning is yours. Move it when you’re satisfied, or ask an agent to.'}
              </span>
            </>
          )}
          {item.status === 'done' &&
            (item.archived ? (
              <>
                <Chip kind="neutral">Archived</Chip>
                <Button size="sm">Unarchive</Button>
              </>
            ) : (
              <Button size="sm">Archive</Button>
            ))}
          {open && (
            <span className="overflow">
              <IconButton
                icon="more"
                aria-label="More actions"
                aria-haspopup="menu"
                aria-expanded={menu}
                onClick={() => setMenu(!menu)}
              />
              {menu && (
                <div className="menu" role="menu" aria-label="More actions">
                  <button type="button" role="menuitem" onClick={() => setMenu(false)}>
                    Cancel item…
                  </button>
                </div>
              )}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * "⊘ Blocked by RCP-12, …", and a chip of its own for each done blocker the
 * link still holds: "⊘ Blocked by RCP-19 (needs merge)" or "(needs your
 * verification)" (UI_SPEC §5).
 */
function BlockedChips({ item }: { item: ItemDetailResponse['item'] }) {
  if (!item.blocked) return null;
  const waiting = item.links.blocked_by.filter(
    (l) => l.cleared === false && (l.waiting_for === 'merge' || l.waiting_for === 'verification'),
  );
  const held = new Set(waiting.map((l) => l.id));
  const rest = item.blocked_by.filter((id) => !held.has(id));
  return (
    <>
      {rest.length > 0 && <BlockedChip blockers={rest} />}
      {waiting.map((l) => (
        <BlockedChip
          key={l.link_id}
          blockers={[l.id]}
          waitingFor={l.waiting_for as 'merge' | 'verification'}
        />
      ))}
    </>
  );
}
