/**
 * Validation errors (MCP_SPEC §6; B3 resolution 4): strict inputs name each
 * unknown key and suggest the closest valid field, in the message and in
 * details, so an agent can fix the call in one retry.
 */
import { describe, expect, it } from 'vitest';
import { closestField, getTool, validationError } from '../src/mcp/index.js';

function errorFor(name: string, args: unknown) {
  const tool = getTool(name)!;
  const r = tool.input.safeParse(args);
  if (r.success) throw new Error('expected a failure');
  return validationError(name, tool.input, r.error).toJSON();
}

describe('unknown fields', () => {
  it('names the key and suggests the closest valid field', () => {
    const err = errorFor('update_item', { id: 'RCP-14', expected_verison: 3, title: 'x' });
    expect(err.code).toBe('validation');
    expect(err.message).toContain(
      'Unknown field "expected_verison"; did you mean "expected_version"?',
    );
    // expected_version is also missing, which is reported too.
    expect(err.message).toContain('expected_version is required.');
    expect(err.details).toMatchObject({
      unknown: [{ field: 'expected_verison', suggestion: 'expected_version' }],
      fields: {
        expected_verison: 'Unknown field "expected_verison"; did you mean "expected_version"?',
      },
    });
  });

  it('suggests nothing when no field is near', () => {
    const err = errorFor('whoami', { banana: 1 });
    expect(err.message).toBe(
      'Invalid arguments for whoami: Unknown field "banana". Fix it and retry.',
    );
    expect(err.details).toMatchObject({ unknown: [{ field: 'banana', suggestion: null }] });
  });

  it('works inside nested objects and arrays', () => {
    const err = errorFor('set_plan', { id: 'RCP-14', steps: [{ txt: 'Reproduce' }] });
    expect(err.message).toContain('Unknown field "steps[0].txt"; did you mean "steps[0].text"?');
    const scope = errorFor('publish_decision', {
      project: 'RCP',
      scope: { kind: 'epic', idd: 'RCP-1' },
      title: 't',
      decision: 'd',
    });
    expect(scope.message).toContain('Unknown field "scope.idd"; did you mean "scope.id"?');
  });

  it('closestField tolerates typos but not unrelated words', () => {
    expect(closestField('idempotencykey', ['idempotency_key', 'id'])).toBe('idempotency_key');
    expect(closestField('runid', ['run_id', 'id'])).toBe('run_id');
    expect(closestField('colour', ['title', 'labels'])).toBeNull();
  });
});

describe('field problems', () => {
  it('reports a missing required field', () => {
    const err = errorFor('create_item', { project: 'RCP', type: 'Task' });
    expect(err.message).toBe(
      'Invalid arguments for create_item: title is required. Fix it and retry.',
    );
    expect(err.details).toEqual({ fields: { title: 'is required' } });
  });

  it('phrases limits, enums and formats', () => {
    const err = errorFor('create_item', {
      project: 'RCP',
      type: 'task',
      title: 't'.repeat(201),
      priority: 5,
      epic: 'epic-1',
    });
    expect(err.details!.fields).toEqual({
      type: 'must be one of "Epic", "Story", "Task", "Bug"',
      title: 'must be at most 200 characters',
      priority: 'must be one of 1, 2, 3',
      epic: 'expected an item ID like RCP-14',
    });
  });

  it('phrases array bounds and either/or rules', () => {
    expect(errorFor('declare_human_review', { id: 'RCP-14', items: [] }).details!.fields).toEqual({
      items: 'must have at least 1 entry',
    });
    expect(errorFor('unlink_items', { from: 'RCP-1' }).details!.fields).toEqual({
      to: 'required unless link_id is given',
      type: 'required unless link_id is given',
    });
  });
});
