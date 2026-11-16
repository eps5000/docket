import { Link } from 'react-router';
import { paths } from '../../lib/paths';

/** Outline tag that links to the label page (UI_SPEC §4 Label). */
export function Label({
  project,
  name,
  asLink = true,
}: {
  project: string;
  name: string;
  asLink?: boolean;
}) {
  if (!asLink) return <span className="label">{name}</span>;
  return (
    <Link className="label" to={paths.label(project, name)}>
      {name}
    </Link>
  );
}

/** ◆ in the epic colour plus the title; links to the epic (UI_SPEC §4 EpicLink). */
export function EpicLink({
  epic,
  asLink = true,
}: {
  epic: { id: string; title: string };
  asLink?: boolean;
}) {
  const body = (
    <>
      <span className="ed" aria-hidden="true">
        ◆
      </span>{' '}
      <span className="sr">Epic </span>
      {epic.title}
    </>
  );
  if (!asLink) {
    return (
      <span className="ptag" title={epic.title}>
        {body}
      </span>
    );
  }
  return (
    <Link className="epiclink" to={paths.item(epic.id)} title={epic.title}>
      {body}
    </Link>
  );
}
