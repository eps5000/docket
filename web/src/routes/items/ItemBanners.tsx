import { Link } from 'react-router';
import type { ItemDetailResponse, QuestionForm } from '@docket/shared';
import { Button, Callout, Icon } from '../../components/kit';
import { useShell } from '../../app/ShellState';
import { useBootstrap } from '../../app/useBootstrap';
import { paths } from '../../lib/paths';
import { formatClock, isoTitle, plural } from '../../lib/format';
import { AnswerBox } from '../shared/AnswerBox';
import { QuestionAnswer, RecommendedLine } from '../shared/QuestionAnswer';
import { HelpLink } from '../../help/HelpLink';
import { ProblemBanners } from './ProblemBanners';

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
            <b className="bad-text">Out of date:</b>{' '}
            {packet.criteria_changed
              ? 'this ticket was split, so its acceptance criteria changed.'
              : 'a newer commit was reported after it.'}
          </>
        )}
      </div>
      <Link className="btn primary" to={paths.review(id, packet.round)}>
        Open packet
      </Link>
    </div>
  );
}

/**
 * Open question (UI_SPEC §6.3): who asked and when, the question, an answer
 * box and *Send answer*. After answering: "You answered: “…”. Waiting for
 * codex to read it." until the agent's next `get_item` delivers it.
 */
export function QuestionBanner({
  itemId,
  question,
  agent,
  unread,
  form = null,
}: {
  itemId: string;
  question: NonNullable<ItemDetailResponse['item']['open_question']>;
  /** Who asked, for "Waiting for codex to read it". */
  agent: string;
  /** The answer hasn't been delivered yet (BUILD_SPEC §5.7). */
  unread: boolean;
  /** Decision 47: the answer dialog's content; null on an older question. */
  form?: QuestionForm | null;
}) {
  if (question.answer) {
    return (
      <Callout tone="ok" className="mb answered">
        You answered: “{question.answer}”.{unread ? ` Waiting for ${agent} to read it.` : ''}
      </Callout>
    );
  }
  return (
    <div className="banner q" data-banner="question">
      <Icon name="question" />
      <div className="grow">
        <b>
          {agent} asked at{' '}
          <span title={isoTitle(question.asked_at)}>{formatClock(question.asked_at)}</span>:
        </b>{' '}
        “{question.text}”
        {form ? (
          <div className="q-banner-action">
            <RecommendedLine form={form} />
            <QuestionAnswer
              key={question.id}
              itemId={itemId}
              questionId={question.id}
              question={question.text}
              form={form}
              agent={agent}
              buttonLabel={`Answer ${agent} on ${itemId}`}
            />
          </div>
        ) : (
          <AnswerBox
            itemId={itemId}
            questionId={question.id}
            agent={agent}
            label="Your answer"
            hint={`The run stays paused until ${agent} reads it.`}
          />
        )}
      </div>
      <HelpLink anchor="item.question" />
    </div>
  );
}

/** Who asked the open question: the latest `question.asked` in the activity, else the lead. */
export function askerOf(data: ItemDetailResponse): string {
  const asked = data.activity.find((a) => a.type === 'question.asked');
  return asked?.actor ?? data.item.lead?.client ?? data.item.runs[0]?.client ?? 'the agent';
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

/**
 * The banners above the tabs, visible on every tab (UI_SPEC §6.3); the
 * problem banner first (decision 37).
 */
export function ItemBanners({ data }: { data: ItemDetailResponse }) {
  const { scope } = useShell();
  const item = data.item;
  return (
    <>
      <ProblemBanners data={data} />
      {scope !== 'all' && item.project !== scope && (
        <OutOfScopeBanner id={item.id} project={item.project} />
      )}
      {data.open_packet && <PacketBanner id={item.id} packet={data.open_packet} />}
      {item.open_question && (
        <QuestionBanner
          itemId={item.id}
          question={item.open_question}
          agent={askerOf(data)}
          unread={data.answer_unread}
          form={data.question_form ?? null}
        />
      )}
      {data.from_review && <FromReviewBanner from={data.from_review} />}
    </>
  );
}
