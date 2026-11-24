/**
 * Ticket types by kind of work (owner decision 67; BUILD_SPEC §5.46).
 *
 * - **The types** name the work, so they say how other tickets depend on it:
 *   Epic, Exploration, Design (documentation included), Implementation, Bug
 *   and Release (`release.ts`).
 * - **Story and Task** became Implementation, marked **inferred** until someone
 *   sets the type. Tools still accept them for a transition period, store
 *   Implementation, and say so in the reply.
 * - **A Jira import** keeps Jira's original type as a reference.
 * - **Rollout** marks an Implementation ticket that changes a shared environment
 *   other tickets depend on (a test deploy, a data cutover, a test flag flip).
 */
import { z } from 'zod';
import {
  ITEM_TYPES,
  ITEM_TYPE_ALIASES,
  type ItemType,
  type ItemTypeAlias,
  type ItemTypeInput,
} from './enums.js';
import { TEXT_LIMITS } from './mcp/limits.js';

/** What each type is for and when it's finished (the design's table; Help and tooltips). */
export const TYPE_MEANINGS: Record<ItemType, { use: string; finished: string }> = {
  Epic: {
    use: 'A body of work with an outcome. It holds tickets and isn’t worked directly.',
    finished: 'Its Release is done; the epic then closes on its own.',
  },
  Exploration: {
    use: 'Research other tickets will use: a spike, a prototype to learn from, a comparison or a measurement. Time-boxed.',
    finished:
      'Its findings are recorded with a recommendation and linked to the tickets that use them. No code is merged.',
  },
  Design: {
    use: 'Product, UX, technical or data design, specs, contracts and decisions to make before building, and documentation that defines how something works.',
    finished: 'The design is recorded and accepted, by the owner when it needs their approval.',
  },
  Implementation: {
    use: 'Building or changing something: code, configuration, tooling, migrations.',
    finished: 'Tested, merged and deployed as the project allows, by its implementer.',
  },
  Bug: {
    use: 'Something that worked or should have worked, and doesn’t.',
    finished: 'Fixed, with a test that would have caught it, merged and deployed.',
  },
  Release: {
    use: 'The one closing ticket of every epic: checks across tickets, the deploy and the release decision.',
    finished: 'All of its gates pass, and its own checklist is done.',
  },
};

/** What a link means for the ticket waiting, by the blocker's type (the design's table). */
export const DEPENDENCY_MEANINGS: Record<ItemType, string> = {
  Exploration: 'waits for its findings to start shaping, or to start',
  Design: 'waits to start: it can’t be built before the design exists',
  Implementation: 'waits to start',
  Bug: 'waits to start',
  Release: 'nothing inside the epic depends on it; another epic may',
  Epic: 'an epic link never blocks child tickets on its own',
};

/** The stored type for a tool's input, and the old type it came as (null when none). */
export function resolveType(input: ItemTypeInput): { type: ItemType; alias: ItemTypeAlias | null } {
  if (input === 'Story' || input === 'Task') {
    return { type: ITEM_TYPE_ALIASES[input], alias: input };
  }
  return { type: input, alias: null };
}

/** The reply's note when a tool got Story or Task. */
export function aliasNote(alias: ItemTypeAlias, id: string): string {
  return `${alias} is now Implementation (decision 67): ${id} was stored as Implementation.`;
}

/**
 * How a blocker reads in a wait line, by its type: "GF-3's findings",
 * "GF-3's design", "GF-3's release", or just "GF-3".
 */
export function blockerPhrase(type: ItemType | undefined, id: string): string {
  if (type === 'Exploration') return `${id}’s findings`;
  if (type === 'Design') return `${id}’s design`;
  if (type === 'Release') return `${id}’s release`;
  return id;
}

/** "12 inferred types to check". */
export const inferredTypesText = (n: number) => `${n} inferred type${n === 1 ? '' : 's'} to check`;

/** The marker's word, never colour alone. */
export const ROLLOUT_LABEL = 'Rollout';
export const ROLLOUT_HELP =
  'An intermediate change to a shared environment that other tickets depend on, such as a deploy to a test environment, a data cutover or a test flag flip. Always its own ticket.';

/** The word on a type marked inferred. */
export const INFERRED_LABEL = 'inferred';

/** How many open tickets of each type (types with none left out), in `ITEM_TYPES` order. */
export const typeMixSchema = z.array(z.object({ type: z.enum(ITEM_TYPES), n: z.number().int() }));
export type TypeMix = z.infer<typeof typeMixSchema>;

/** "2 explorations · 1 design · 4 implementation · 1 release". */
export function typeMixText(mix: TypeMix): string {
  return mix
    .map(({ type, n }) => {
      const word = type.toLowerCase();
      return `${n} ${n === 1 || type === 'Implementation' ? word : `${word}s`}`;
    })
    .join(' · ');
}

/** An Exploration's findings write-up, at most this long. */
export const FINDINGS_MAX = TEXT_LIMITS.note;
