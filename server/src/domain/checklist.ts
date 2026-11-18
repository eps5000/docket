/**
 * Work steps, subagent logs and agent checks (BUILD_SPEC §5.5): the `checklist` service.
 *
 * US1 (T073) implements the agent's side: `set_plan` (patch and replace,
 * with plan versions and reasons), `update_step`, `log_subagent`,
 * `set_checks` and `update_check`. Writes patch (MCP_SPEC §3.3): what you
 * don't restate, you don't change. Owner-added entries are always kept;
 * agents may change their state, never their text.
 *
 * US6 (T120) adds the owner's own steps and checks (`added_by: owner`):
 * the owner adds them (undoable) and removes their own while a step isn't
 * done, or while a check hasn't run. They join the current plan without a
 * new plan version: they are the owner's additions, not a revision of the
 * agent's plan.
 *
 * Plan history: each `set_plan` writes a `plan_versions` row and moves the
 * surviving steps to that version; removed steps keep their old version
 * number, so earlier plans stay readable.
 */
import { LIMITS, ToolError } from '@docket/shared';
import { type ChecklistService, type In, type Out, type ServiceDeps } from './contracts.js';
import { newId } from './ids.js';
import {
  assertCallerRun,
  callerName,
  checkRows,
  checkView,
  checksOf,
  currentSteps,
  ms,
  planVersion,
  requireItem,
  stepView,
  type CheckRow,
  type ItemRow,
  type StepRow,
} from './model.js';
import type { InverseOp, WriteContext } from './write.js';

const isOwner = (addedBy: string) => addedBy === 'owner';

/** Insert `id` after `after` (or at the end) in `order`. */
function place(order: string[], id: string, after: string | undefined, label: string): void {
  const i = order.indexOf(id);
  if (i >= 0) order.splice(i, 1);
  if (after === undefined) {
    order.push(id);
    return;
  }
  const at = order.indexOf(after);
  if (at < 0) {
    throw new ToolError(
      'validation',
      `Unknown ${label} id in after: ${after}. Use an id from get_item.`,
      {
        details: { fields: { after: `unknown ${label} id` } },
      },
    );
  }
  order.splice(at + 1, 0, id);
}

/** Final order for replace mode: the listed entries in order, then owner entries not listed, as they were. */
function replaceOrder(old: { id: string; added_by: string }[], listed: string[]): string[] {
  return [
    ...listed,
    ...old.filter((e) => isOwner(e.added_by) && !listed.includes(e.id)).map((e) => e.id),
  ];
}

function unknownId(kind: string, id: string, item: string): ToolError {
  return new ToolError(
    'validation',
    `Unknown ${kind} id ${id} on ${item}. Use an id from get_item.`,
    {
      details: { fields: { id: `unknown ${kind} id` }, unknown_id: id },
    },
  );
}

function ownerOnly(kind: string, id: string): ToolError {
  return new ToolError(
    'forbidden',
    `${id} was added by the owner; only the owner can change its text or remove it. You may change its state.`,
    { details: { kind } },
  );
}

const quote = (text: string) => `“${text.length > 60 ? `${text.slice(0, 59)}…` : text}”`;

/** The owner adds steps and checks to open items only. */
function openItem(w: WriteContext, id: string, what: string): ItemRow {
  const item = requireItem(w.db, id);
  if (item.status === 'done' || item.status === 'canceled') {
    throw new ToolError(
      'validation',
      `${item.id} is ${item.status}, so it takes no new ${what}. Reopen it, or create a follow-up item.`,
      { details: { status: item.status } },
    );
  }
  return item;
}

export function createChecklistService(_deps: ServiceDeps): ChecklistService {
  return {
    setPlan(w, input: In<'set_plan'>): Out<'set_plan'> {
      assertCallerRun(w.db, w.actor, w.now);
      const item = requireItem(w.db, input.id);
      const version = planVersion(w.db, item.id);
      if (version > 0 && !input.reason) {
        throw new ToolError(
          'validation',
          `${item.id} already has a plan (v${version}); say why you are revising it: pass reason.`,
          { details: { fields: { reason: 'is required to revise a plan' } } },
        );
      }
      const steps = currentSteps(w.db, item.id);
      const byId = new Map(steps.map((s) => [s.id, s]));
      const inputs = input.steps ?? [];
      const removes = input.remove ?? [];
      if (inputs.length === 0 && removes.length === 0) {
        throw new ToolError('validation', 'Nothing to change: send steps, or step ids in remove.', {
          details: { fields: { steps: 'send at least one step' } },
        });
      }
      const who = callerName(w.db, w.actor);
      const changes = new Map<string, Record<string, unknown>>();
      const created = new Map<string, Record<string, unknown>>();
      const change = (id: string, set: Record<string, unknown>) =>
        changes.set(id, { ...(changes.get(id) ?? {}), ...set });

      const applyExisting = (s: StepRow, step: (typeof inputs)[number]) => {
        if (step.text !== undefined && step.text !== s.text) {
          if (isOwner(s.added_by)) throw ownerOnly('work step', s.id);
          change(s.id, {
            text: step.text,
            was_text: s.text,
            change_reason: step.change_reason ?? input.reason ?? null,
          });
        } else if (step.change_reason !== undefined) {
          change(s.id, { change_reason: step.change_reason });
        }
        if (step.state !== undefined && step.state !== s.state) {
          change(s.id, { state: step.state, state_by: who, state_at: w.now });
        }
      };
      const newStep = (step: (typeof inputs)[number]): string => {
        if (step.text === undefined) {
          throw new ToolError(
            'validation',
            'A new step needs text (or pass the id of the step to change).',
            {
              details: { fields: { text: 'is required for a new step' } },
            },
          );
        }
        const id = newId('wst', ms(w.now));
        created.set(id, {
          text: step.text,
          state: step.state ?? 'todo',
          change_reason: step.change_reason ?? null,
          added_by: who,
          ...(step.state && step.state !== 'todo' ? { state_by: who, state_at: w.now } : {}),
        });
        return id;
      };

      let order = steps.map((s) => s.id);
      const removed: string[] = [];
      for (const id of removes) {
        const s = byId.get(id);
        if (!s) throw unknownId('step', id, item.id);
        if (isOwner(s.added_by)) throw ownerOnly('work step', id);
        removed.push(id);
      }
      if (input.mode === 'replace') {
        const listed: string[] = [];
        for (const step of inputs) {
          if (step.id !== undefined) {
            const s = byId.get(step.id);
            if (!s) throw unknownId('step', step.id, item.id);
            applyExisting(s, step);
            listed.push(s.id);
          } else {
            listed.push(newStep(step));
          }
        }
        order = replaceOrder(steps, listed);
        for (const s of steps) if (!order.includes(s.id)) removed.push(s.id);
      } else {
        for (const step of inputs) {
          if (step.id !== undefined) {
            const s = byId.get(step.id);
            if (!s) throw unknownId('step', step.id, item.id);
            applyExisting(s, step);
            if (step.after !== undefined) place(order, s.id, step.after, 'step');
          } else {
            place(order, newStep(step), step.after, 'step');
          }
        }
      }
      order = order.filter((id) => !removed.includes(id));
      if (order.length > LIMITS.plan_steps_max) {
        throw new ToolError(
          'validation',
          `A plan has at most ${LIMITS.plan_steps_max} steps; this would make ${order.length}. Merge steps, or split the work into another item.`,
          { details: { fields: { steps: `at most ${LIMITS.plan_steps_max} on the plan` } } },
        );
      }

      const next = version + 1;
      w.insert('plan_versions', {
        id: newId('pv', ms(w.now)),
        item_id: item.id,
        version_no: next,
        reason: input.reason ?? null,
        created_by: who,
      });
      order.forEach((id, position) => {
        const fresh = created.get(id);
        if (fresh) {
          w.insert('work_steps', {
            id,
            item_id: item.id,
            plan_version_no: next,
            position,
            ...fresh,
          });
        } else {
          w.update('work_steps', id, {
            plan_version_no: next,
            position,
            ...(changes.get(id) ?? {}),
          });
        }
      });
      const facts = [
        created.size > 0 ? `+${created.size}` : null,
        removed.length > 0 ? `-${removed.length}` : null,
        changes.size > 0 ? `~${changes.size}` : null,
      ].filter(Boolean);
      w.event({
        type: 'plan.updated',
        summary: `${who} ${version === 0 ? 'published the plan' : 'revised the checklist'} (v${next}, ${order.length} steps${facts.length ? `: ${facts.join(' ')}` : ''})${input.reason ? `: ${input.reason}` : ''}`,
        item_id: item.id,
        project_key: item.project_key,
        data: {
          plan_version: { old: version, new: next },
          added: [...created.keys()],
          removed,
          changed: Object.fromEntries(changes),
          reason: input.reason ?? null,
        },
      });
      return { plan_version: next, work: stepView(w.db, currentSteps(w.db, item.id)) };
    },

    updateStep(w, input) {
      const run = assertCallerRun(w.db, w.actor, w.now);
      const item = requireItem(w.db, input.id);
      const step = currentSteps(w.db, item.id).find((s) => s.id === input.step_id);
      if (!step) {
        throw new ToolError(
          'not_found',
          `No work step ${input.step_id} on ${item.id}'s current plan. Use a step id from get_item.`,
        );
      }
      const who = callerName(w.db, w.actor);
      w.update('work_steps', step.id, { state: input.state, state_by: who, state_at: w.now });
      if (input.state === 'current' && run && run.item_id === item.id) {
        w.update('runs', run.id, { current_step_id: step.id });
      }
      w.event({
        type: 'step.updated',
        summary: `${who}: ${step.text} → ${input.state}${input.note ? `: ${input.note}` : ''}`,
        item_id: item.id,
        project_key: item.project_key,
        data: {
          step_id: step.id,
          state: { old: step.state, new: input.state },
          note: input.note ?? null,
        },
      });
      const after = currentSteps(w.db, item.id).find((s) => s.id === step.id)!;
      return { step: stepView(w.db, [after])[0]! };
    },

    logSubagent(w, input) {
      const run = assertCallerRun(w.db, w.actor, w.now);
      const item = requireItem(w.db, input.id);
      if (input.step_id && !currentSteps(w.db, item.id).some((s) => s.id === input.step_id)) {
        throw new ToolError(
          'validation',
          `${input.step_id} is not a step on ${item.id}'s current plan. Use a step id from get_item, or leave step_id out.`,
          { details: { fields: { step_id: 'unknown step id' } } },
        );
      }
      if (input.child_run_id) {
        const child = w.db.sqlite
          .prepare('SELECT item_id, state FROM runs WHERE id = ?')
          .get(input.child_run_id) as { item_id: string; state: string } | undefined;
        if (!child || child.item_id !== item.id) {
          throw new ToolError(
            'validation',
            `${input.child_run_id} is not a run on ${item.id}. Pass the child run start_run gave you, or leave child_run_id out.`,
            { details: { fields: { child_run_id: 'unknown run on this item' } } },
          );
        }
        // A parent reporting on a child's behalf is a relayed signal for the child (§5.4), never for the lead.
        if (child.state === 'open' || child.state === 'needs_input') {
          w.db.sqlite
            .prepare(
              "UPDATE runs SET last_signal_at = ?, last_signal_kind = 'relayed' WHERE id = ?",
            )
            .run(w.now, input.child_run_id);
        }
      }
      const id = newId('sub', ms(w.now));
      w.insert('subagent_logs', {
        id,
        item_id: item.id,
        work_step_id: input.step_id ?? null,
        name: input.name,
        outcome: input.outcome,
        evidence: input.evidence ?? null,
        provenance: input.provenance,
        child_run_id: input.child_run_id ?? null,
        reported_by_run_id: run?.id ?? null,
      });
      w.event({
        type: 'subagent.logged',
        summary: `${input.provenance} ${input.name}: ${input.outcome}`,
        item_id: item.id,
        project_key: item.project_key,
        data: {
          step_id: input.step_id ?? null,
          provenance: input.provenance,
          child_run_id: input.child_run_id ?? null,
        },
      });
      return { logged: true as const };
    },

    setChecks(w, input) {
      assertCallerRun(w.db, w.actor, w.now);
      const item = requireItem(w.db, input.id);
      const rows = checkRows(w.db, item.id);
      const byId = new Map(rows.map((c) => [c.id, c]));
      const inputs = input.checks ?? [];
      const removes = input.remove ?? [];
      if (inputs.length === 0 && removes.length === 0) {
        throw new ToolError(
          'validation',
          'Nothing to change: send checks, or check ids in remove.',
          {
            details: { fields: { checks: 'send at least one check' } },
          },
        );
      }
      const who = callerName(w.db, w.actor);
      const changes = new Map<string, Record<string, unknown>>();
      const created = new Map<string, Record<string, unknown>>();

      const applyExisting = (c: CheckRow, check: (typeof inputs)[number]) => {
        const set: Record<string, unknown> = {};
        if (check.text !== undefined && check.text !== c.text) {
          if (isOwner(c.added_by)) throw ownerOnly('check', c.id);
          set.text = check.text;
        }
        if (check.state !== undefined && check.state !== c.state) set.state = check.state;
        if (check.evidence !== undefined && check.evidence !== c.evidence)
          set.evidence = check.evidence;
        // Restating state or evidence is a new assertion, with this call's provenance.
        if (
          (check.state !== undefined || check.evidence !== undefined) &&
          check.provenance !== c.provenance
        ) {
          set.provenance = check.provenance;
        }
        if (Object.keys(set).length > 0) changes.set(c.id, set);
      };
      const newCheck = (check: (typeof inputs)[number]): string => {
        if (check.text === undefined) {
          throw new ToolError(
            'validation',
            'A new check needs text (or pass the id of the check to change).',
            {
              details: { fields: { text: 'is required for a new check' } },
            },
          );
        }
        const id = newId('chk', ms(w.now));
        created.set(id, {
          text: check.text,
          state: check.state ?? 'todo',
          evidence: check.evidence ?? null,
          provenance: check.provenance,
          added_by: who,
        });
        return id;
      };

      let order = rows.map((c) => c.id);
      const removed: string[] = [];
      for (const id of removes) {
        const c = byId.get(id);
        if (!c) throw unknownId('check', id, item.id);
        if (isOwner(c.added_by)) throw ownerOnly('check', id);
        removed.push(id);
      }
      if (input.mode === 'replace') {
        const listed: string[] = [];
        for (const check of inputs) {
          if (check.id !== undefined) {
            const c = byId.get(check.id);
            if (!c) throw unknownId('check', check.id, item.id);
            applyExisting(c, check);
            listed.push(c.id);
          } else {
            listed.push(newCheck(check));
          }
        }
        order = replaceOrder(rows, listed);
        for (const c of rows) if (!order.includes(c.id)) removed.push(c.id);
      } else {
        for (const check of inputs) {
          if (check.id !== undefined) {
            const c = byId.get(check.id);
            if (!c) throw unknownId('check', check.id, item.id);
            applyExisting(c, check);
          } else {
            order.push(newCheck(check));
          }
        }
      }
      order = order.filter((id) => !removed.includes(id));
      if (order.length > LIMITS.checks_max) {
        throw new ToolError(
          'validation',
          `An item has at most ${LIMITS.checks_max} checks; this would make ${order.length}. Merge checks and retry.`,
          { details: { fields: { checks: `at most ${LIMITS.checks_max} in total` } } },
        );
      }
      for (const id of removed) w.remove('agent_checks', id);
      order.forEach((id, position) => {
        const fresh = created.get(id);
        if (fresh) w.insert('agent_checks', { id, item_id: item.id, position, ...fresh });
        else if (changes.has(id) || byId.get(id)!.position !== position) {
          w.update('agent_checks', id, { position, ...(changes.get(id) ?? {}) });
        }
      });
      const pass = checksOf(w.db, item.id).filter((c) => c.state === 'pass').length;
      w.event({
        type: 'checks.updated',
        summary: `${who} updated checks (${pass}/${order.length} pass)`,
        item_id: item.id,
        project_key: item.project_key,
        data: { added: [...created.keys()], removed, changed: Object.fromEntries(changes) },
      });
      return { checks: checksOf(w.db, item.id) };
    },

    updateCheck(w, input) {
      assertCallerRun(w.db, w.actor, w.now);
      const item = requireItem(w.db, input.id);
      const c = checkRows(w.db, item.id).find((x) => x.id === input.check_id);
      if (!c) {
        throw new ToolError(
          'not_found',
          `No check ${input.check_id} on ${item.id}. Use a check id from get_item.`,
        );
      }
      const set: Record<string, unknown> = { state: input.state };
      if (input.evidence !== undefined) set.evidence = input.evidence;
      if (input.provenance !== undefined) set.provenance = input.provenance;
      w.update('agent_checks', c.id, set);
      const who = callerName(w.db, w.actor);
      w.event({
        type: 'check.updated',
        summary: `${who}: ${c.text} → ${input.state}${input.evidence ? ` (${input.evidence})` : ''}`,
        item_id: item.id,
        project_key: item.project_key,
        data: {
          check_id: c.id,
          state: { old: c.state, new: input.state },
          evidence: input.evidence ?? null,
        },
      });
      return { check: checkView(checkRows(w.db, item.id).find((x) => x.id === c.id)!) };
    },

    ownerAddStep(w, input) {
      const item = openItem(w, input.id, 'steps');
      const steps = currentSteps(w.db, item.id);
      if (steps.length >= LIMITS.plan_steps_max) {
        throw new ToolError(
          'validation',
          `${item.id} already has ${steps.length} steps, the most a plan can hold. Remove one first, or leave the agent a note.`,
          { details: { fields: { text: `at most ${LIMITS.plan_steps_max} steps on the plan` } } },
        );
      }
      const id = newId('wst', ms(w.now));
      const order = steps.map((s) => s.id);
      place(order, id, input.after, 'step');
      const at = order.indexOf(id);
      // Renumber from the new step on (positions may have gaps after removals).
      const ops: InverseOp[] = [];
      const position = at === 0 ? 0 : steps.find((s) => s.id === order[at - 1])!.position + 1;
      let next = position + 1;
      for (const sid of order.slice(at + 1)) {
        const s = steps.find((x) => x.id === sid)!;
        if (s.position < next) ops.push(w.update('work_steps', s.id, { position: next }));
        next = Math.max(next, s.position) + 1;
      }
      ops.push(
        w.insert('work_steps', {
          id,
          item_id: item.id,
          plan_version_no: planVersion(w.db, item.id),
          position,
          text: input.text,
          state: 'todo',
          added_by: 'owner',
        }),
      );
      w.event({
        type: 'plan.updated',
        summary: `You added a work step on ${item.id}: ${quote(input.text)}`,
        item_id: item.id,
        project_key: item.project_key,
        data: { added: [id], removed: [], added_by: 'owner', after: input.after ?? null },
        inverse: ops,
      });
      return stepView(
        w.db,
        currentSteps(w.db, item.id).filter((s) => s.id === id),
      )[0]!;
    },

    ownerRemoveStep(w, input) {
      const item = requireItem(w.db, input.id);
      const step = currentSteps(w.db, item.id).find((s) => s.id === input.stepId);
      if (!step) {
        throw new ToolError(
          'not_found',
          `No work step ${input.stepId} on ${item.id}'s current plan. Reload the item.`,
        );
      }
      if (!isOwner(step.added_by)) {
        throw new ToolError(
          'forbidden',
          `${step.id} is the agent’s step; you can only remove steps you added. Leave the agent a note instead.`,
        );
      }
      if (step.state === 'done') {
        throw new ToolError(
          'validation',
          `${step.id} is already done, so it stays on the checklist.`,
          { details: { state: step.state } },
        );
      }
      const inverse = w.remove('work_steps', step.id);
      w.event({
        type: 'plan.updated',
        summary: `You removed the work step ${quote(step.text)} from ${item.id}`,
        item_id: item.id,
        project_key: item.project_key,
        data: { added: [], removed: [step.id], added_by: 'owner', text: step.text },
        inverse: [inverse],
      });
    },

    ownerAddCheck(w, input) {
      const item = openItem(w, input.id, 'checks');
      const rows = checkRows(w.db, item.id);
      if (rows.length >= LIMITS.checks_max) {
        throw new ToolError(
          'validation',
          `${item.id} already has ${rows.length} checks, the most an item can hold. Remove one first.`,
          { details: { fields: { text: `at most ${LIMITS.checks_max} checks` } } },
        );
      }
      const id = newId('chk', ms(w.now));
      const inverse = w.insert('agent_checks', {
        id,
        item_id: item.id,
        position: rows.reduce((max, c) => Math.max(max, c.position), -1) + 1,
        text: input.text,
        state: 'todo',
        evidence: null,
        provenance: 'agent',
        added_by: 'owner',
      });
      w.event({
        type: 'checks.updated',
        summary: `You added a check on ${item.id}: ${quote(input.text)}`,
        item_id: item.id,
        project_key: item.project_key,
        data: { added: [id], removed: [], changed: {}, added_by: 'owner' },
        inverse: [inverse],
      });
      return checkView(checkRows(w.db, item.id).find((c) => c.id === id)!);
    },

    ownerRemoveCheck(w, input) {
      const item = requireItem(w.db, input.id);
      const c = checkRows(w.db, item.id).find((x) => x.id === input.checkId);
      if (!c) {
        throw new ToolError(
          'not_found',
          `No check ${input.checkId} on ${item.id}. Reload the item.`,
        );
      }
      if (!isOwner(c.added_by)) {
        throw new ToolError(
          'forbidden',
          `${c.id} is the agent’s check; you can only remove checks you added. Leave the agent a note instead.`,
        );
      }
      if (c.state !== 'todo') {
        throw new ToolError(
          'validation',
          `${c.id} has already run (${c.state}), so it stays on the checklist.`,
          { details: { state: c.state } },
        );
      }
      const inverse = w.remove('agent_checks', c.id);
      w.event({
        type: 'checks.updated',
        summary: `You removed the check ${quote(c.text)} from ${item.id}`,
        item_id: item.id,
        project_key: item.project_key,
        data: { added: [], removed: [c.id], changed: {}, added_by: 'owner', text: c.text },
        inverse: [inverse],
      });
    },
  };
}
