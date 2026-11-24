/**
 * The bundled agent files (owner decision 29; BUILD_SPEC §5.17; T153): at
 * startup the server reads the copies shipped in the image and loads them
 * into the bundled layer. A new bundled version is added only when a file's
 * content changed (an upgrade); owner edits are never touched.
 *
 * Where they are: the image and the workspace share one layout (index.ts),
 * so from `server/dist/` (or `server/src/` in tests) the root is two levels
 * up, holding `skills/<name>/SKILL.md` (with any `skills/<name>/references/<topic>.md`,
 * decision 66), `docs/templates/AGENTS-docket.md` and
 * `docs/templates/ONBOARDING-guide.md` (the onboarding guide, agent file
 * `guide:onboarding`; decision 31, B30). The Dockerfile copies them into `/app`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AGENT_FILE_KEY_RE,
  AGENT_SETUP_LIMITS,
  ONBOARDING_GUIDE_KEY,
  SKILL_PART_RE,
  SKILL_REFERENCES_DIR,
  skillReferenceKey,
} from '@docket/shared';
import type { BundledAgentFile, Services } from '../domain/contracts.js';
import { SYSTEM_ACTOR, type WritePath } from '../domain/write.js';

/** The image's (or the checkout's) root: `skills/` and `docs/templates/` live here. */
export const DEFAULT_BUNDLED_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

export const AGENTS_TEMPLATE = join('docs', 'templates', 'AGENTS-docket.md');
export const ONBOARDING_GUIDE_TEMPLATE = join('docs', 'templates', 'ONBOARDING-guide.md');

/**
 * Every shipped agent file under `root`: each `skills/<name>/SKILL.md` whose
 * name is a valid key, each of its `references/<topic>.md` (decision 66, as
 * `skill:<name>--<topic>`), the AGENTS.md block and the onboarding guide.
 * Missing files are skipped, with a line in `problems`.
 */
export function readBundledFiles(root: string): { files: BundledAgentFile[]; problems: string[] } {
  const files: BundledAgentFile[] = [];
  const problems: string[] = [];
  const add = (key: string, path: string) => {
    if (!AGENT_FILE_KEY_RE.test(key)) {
      problems.push(`${path}: "${key}" isn't a valid agent file name; skipped.`);
      return;
    }
    const content = readFileSync(path, 'utf8');
    if (content.length === 0 || content.length > AGENT_SETUP_LIMITS.agent_file_content) {
      problems.push(
        `${path}: empty or over ${AGENT_SETUP_LIMITS.agent_file_content} characters; skipped.`,
      );
      return;
    }
    files.push({ key, content });
  };

  const skillsDir = join(root, 'skills');
  if (existsSync(skillsDir)) {
    for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(skillsDir, entry.name, 'SKILL.md');
      if (!existsSync(path)) continue;
      if (!SKILL_PART_RE.test(entry.name)) {
        problems.push(`${path}: "${entry.name}" isn't a valid skill name; skipped.`);
        continue;
      }
      add(`skill:${entry.name}`, path);
      const refs = join(skillsDir, entry.name, SKILL_REFERENCES_DIR);
      if (!existsSync(refs)) continue;
      for (const ref of readdirSync(refs, { withFileTypes: true })) {
        if (!ref.isFile() || !ref.name.endsWith('.md')) continue;
        const topic = ref.name.slice(0, -'.md'.length);
        const refPath = join(refs, ref.name);
        if (!SKILL_PART_RE.test(topic)) {
          problems.push(`${refPath}: "${topic}" isn't a valid reference name; skipped.`);
          continue;
        }
        add(skillReferenceKey(entry.name, topic), refPath);
      }
    }
  } else {
    problems.push(`${skillsDir} is missing; no bundled skills loaded.`);
  }
  const template = join(root, AGENTS_TEMPLATE);
  if (existsSync(template)) add('agents_block', template);
  else problems.push(`${template} is missing; no bundled AGENTS.md block loaded.`);
  const guide = join(root, ONBOARDING_GUIDE_TEMPLATE);
  if (existsSync(guide)) add(ONBOARDING_GUIDE_KEY, guide);
  else problems.push(`${guide} is missing; no bundled onboarding guide loaded.`);
  return { files, problems };
}

/** Load the shipped files into the bundled layer, as the system, in one write. */
export function syncBundledFiles(
  runtime: { write: WritePath; services: Services; log: (line: string) => void },
  root: string = DEFAULT_BUNDLED_ROOT,
): { added: string[]; retired: string[] } {
  const { files, problems } = readBundledFiles(root);
  for (const p of problems) runtime.log(`Agent files: ${p}`);
  if (files.length === 0) return { added: [], retired: [] };
  const { result } = runtime.write.run(
    {
      actor: SYSTEM_ACTOR,
      operation: 'agentFiles.syncBundled',
      args: { keys: files.map((f) => f.key) },
    },
    (w) => runtime.services.agentFiles.syncBundled(w, { files }),
  );
  return result;
}
