import { useId } from 'react';
import { Link } from 'react-router';
import type { ItemDetailResponse } from '@tasklite/shared';
import { Button, Callout, Icon } from '../../components/kit';
import { useShell } from '../../app/ShellState';
import { useBootstrap } from '../../app/useBootstrap';
import { paths } from '../../lib/paths';
import { plural } from '../../lib/format';

/** Packet ready: amber banner with *Open packet* (UI_SPEC §6.3), and "out of date" when a newer commit came in. */
export function PacketBanner({
  id,
  packet,
}: {
  id: string;
  packet: NonNullable<ItemDetailResponse['open_packet']>;
}) {
  return (
    <div className="banner" data-banner="packet">
      <Icon name="packet" />
      <div className="grow">
        <b>Handoff packet ready (round {packet.round}).</b> {plural(packet.to_verify, 'thing')} to
        verify{packet.estimate ? `, about ${packet.estimate}` : ''}. The ticket can’t close until
        you approve.
        {packet.stale && (
          <>
            {' '}
            <b className="bad-text">Out of date:</b> a newer commit was reported after it.
          </>
        )}
      </div>
      <Link className="btn primary" to={paths.review(id, packet.round)}>
        Open packet
      </Link>
    </div>
  );
}

/** Open question: the question, an answer box and *Send answer* (UI_SPEC §6.3). US6 wires it. */
export function QuestionBanner({
  question,
  agent,
  unread,
}: {
  question: NonNullable<ItemDetailResponse['item']['open_question']>;
  /** Who asked (the lead's client), for "Waiting for codex to read it". */
  agent: string;
  /** The answer hasn't been delivered yet (BUILD_SPEC §5.7). */
  unread: boolean;
}) {
  const answerId = useId();
  if (question.answer) {
    return (
      <Callout tone="ok" className="mb">
        You answered: “{question.answer}”.{unread ? ` Waiting for ${agent} to read it.` : ''}
      </Callout>
    );
  }
  return (
    <div className="banner q" data-banner="question">
      <Icon name="question" />
      <div className="grow">
        <b>Question:</b> “{question.text}”
        <label className="f" htmlFor={answerId}>
          Your answer
        </label>
        <textarea id={answerId} />
        <div className="row wrap" style={{ marginTop: 6 }}>
          <Button variant="primary" size="sm" disabled title="Lands with US6">
            Send answer
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Out of scope: "RCP-21 belongs to Recipe App, outside the project you're viewing." */
export function OutOfScopeBanner({ id, project }: { id: string; project: string }) {
  const { setScope } = useShell();
  const boot = useBootstrap();
  const name = boot.data?.projects.find((p) => p.key === project)?.short_name ?? project;
  return (
    <Callout className="mb">
      <div className="row wrap">
        <span className="grow">
          {id} belongs to <b>{name}</b>, outside the project you’re viewing.
        </span>
        <Button size="sm" onClick={() => setScope(project)}>
          Switch to {name}
        </Button>
      </div>
    </Callout>
  );
}

/** From review: "Created from your human review of RCP-12 (…)" (UI_SPEC §6.3). */
export function FromReviewBanner({
  from,
}: {
  from: NonNullable<ItemDetailResponse['from_review']>;
}) {
  return (
    <Callout className="mb">
      Created from your human review of{' '}
      <Link to={paths.review(from.item_id, from.round)}>{from.item_id}</Link>
      {from.text ? ` (“${from.text}”)` : ''}.
    </Callout>
  );
}

/** The banners above the tabs, visible on every tab (UI_SPEC §6.3). */
export function ItemBanners({ data }: { data: ItemDetailResponse }) {
  const { scope } = useShell();
  const item = data.item;
  return (
    <>
      {scope !== 'all' && item.project !== scope && (
        <OutOfScopeBanner id={item.id} project={item.project} />
      )}
      {data.open_packet && <PacketBanner id={item.id} packet={data.open_packet} />}
      {item.open_question && (
        <QuestionBanner
          question={item.open_question}
          agent={item.lead?.client ?? item.runs[0]?.client ?? 'the agent'}
          unread={data.answer_unread}
        />
      )}
      {data.from_review && <FromReviewBanner from={data.from_review} />}
    </>
  );
}
