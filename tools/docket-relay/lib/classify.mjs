/**
 * Which feed events count, and the pointer the coordinator gets (owner decision 46).
 *
 * The feed row has no `data` and no `actor_kind`, so an event is judged by its
 * type, its `actor` and the fixed start of its summary. A summary can quote
 * what the owner wrote, so it is matched here and never copied, stored or
 * logged. The relay confirms `actor_kind` from the item before it sends.
 */

export const ITEM_RE = /^[A-Z]{2,5}-[1-9][0-9]*$/;

const OWNER_ACTOR = /^owner( \(script: .*\))?$/;
const SYSTEM_ACTORS = new Set(['system', 'docket']);
const KEY = '[A-Z]{2,5}-[1-9][0-9]*';
const BLOCKER_ADDED = new RegExp(`^${KEY} blocks ${KEY}`);
const BLOCKER_REMOVED = new RegExp(`^Removed: ${KEY} blocks ${KEY}`);
const EDITED = new RegExp(`^You edited the (.+?)(?: and set ${KEY} to P[0-9]+)?$`);

/** The words `ownerPatch` writes for each text field. */
const EDIT_KINDS = {
  title: 'title',
  description: 'description',
  outcome: 'outcome',
  'acceptance criteria': 'acceptance',
};

/** Owner events whose type alone says what changed. */
const BY_TYPE = {
  'question.answered': 'answer',
  'owner_note.added': 'note',
  'review.decided': 'review',
  'resolution.decided': 'resolution',
  'overlap.decided': 'overlap',
  'undeclared.decided': 'hold',
  'decision.published': 'decision',
  'decision.confirmed': 'decision',
  'item.archived': 'archive',
  'item.unarchived': 'archive',
};

/** The order kinds are named in a message. */
const KIND_ORDER = [
  'answer',
  'note',
  'review',
  'design review',
  'resolution',
  'overlap',
  'hold',
  'decision',
  'title',
  'description',
  'outcome',
  'acceptance',
  'status',
  'canceled',
  'archive',
  'blocker',
  'undo',
];

function editKinds(summary) {
  const words = EDITED.exec(summary)?.[1];
  if (!words) return [];
  const kinds = words.split(/, | and /).map((word) => EDIT_KINDS[word]);
  return kinds.every(Boolean) ? kinds : [];
}

function kindsFor(type, summary) {
  if (BY_TYPE[type]) return [BY_TYPE[type]];
  switch (type) {
    case 'item.updated':
      return editKinds(summary);
    case 'item.status_changed':
      return [summary.startsWith('You canceled ') ? 'canceled' : 'status'];
    case 'link.added':
      return BLOCKER_ADDED.test(summary) ? ['blocker'] : [];
    case 'link.removed':
      return BLOCKER_REMOVED.test(summary) ? ['blocker'] : [];
    case 'design_review.decided':
      // "withdrawn" means the review ended without a decision.
      return /^You (approved|sent back) /.test(summary) ? ['design review'] : [];
    default:
      return [];
  }
}

/**
 * What an event means for the item's live lead, or null to ignore it.
 * `expect` is the `actor_kind` the item's activity must show for this event.
 */
export function classifyEvent(event) {
  if (!event || typeof event.type !== 'string') return null;
  if (typeof event.item_id !== 'string' || !ITEM_RE.test(event.item_id)) return null;
  const actor = String(event.actor ?? '');
  const summary = String(event.summary ?? '');

  // B54's event: Docket itself says the wait is over. Subscribed by name only.
  if (event.type === 'run.resume_ready') {
    if (!SYSTEM_ACTORS.has(actor)) return null;
    return { kinds: ['resume'], immediate: true, expect: 'system' };
  }
  if (!OWNER_ACTOR.test(actor)) return null;

  const undone = summary.startsWith('Undid: ');
  const kinds = kindsFor(event.type, undone ? summary.slice('Undid: '.length) : summary);
  if (kinds.length === 0) return null;
  if (undone) return { kinds: ['undo'], immediate: false, expect: 'owner' };
  return { kinds, immediate: event.type === 'question.answered', expect: 'owner' };
}

export const orderKinds = (kinds) => {
  const unique = new Set(kinds);
  return KIND_ORDER.filter((kind) => unique.has(kind));
};

/**
 * The pointer, always worded for the coordinator. It names the item, the kinds
 * of change and, as information only, the implementer; never the change's text.
 * "From the owner side" because an agent using the owner API is recorded as
 * the owner too, and Docket can't always tell them apart.
 */
export function buildMessage({ item, kinds, implementer }) {
  const resume = kinds.includes('resume');
  const changes = orderKinds(kinds);
  const parts = [];
  if (changes.length > 0) {
    parts.push(`${item} was updated from the owner side in Docket (${changes.join(', ')}).`);
    if (resume) parts.push('What it was waiting for has also cleared.');
  } else {
    parts.push(`What ${item} was waiting for has cleared in Docket.`);
  }
  parts.push(
    `The implementer, for information only: ${implementer}.`,
    "You're told as its coordinator, and this notice carries no owner authority.",
    'Decide whether and when to relay it, under your own gates.',
    `Don't call get_item ${item} on the implementer's behalf, because that uses up its one-time delivery.`,
  );
  const subject = changes.length > 0 ? `Docket: ${item} updated` : `Docket: ${item} can resume`;
  return { subject, body: parts.join(' ') };
}
