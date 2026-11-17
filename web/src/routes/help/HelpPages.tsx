import { useId } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useBreadcrumb } from '../../app/ShellState';
import { Card } from '../../components/kit';
import { articleBySlug, HELP_GROUPS, searchArticles, type HelpArticle } from '../../help/articles';
import { ArticleBody } from '../../help/ArticleBody';
import { Related } from '../../help/HelpLink';
import { paths } from '../../lib/paths';
import '../screens.css';
import '../../help/help.css';

/**
 * Help (`/help`, UI_SPEC §6.7c): every article with its one-line summary,
 * grouped as Getting started, Working with agents, Recovery, Planning and
 * Operations. The search box filters as you type; its text is in the URL
 * (`?q=`), like the other filters (UI_SPEC §2).
 */
export function HelpIndex() {
  useBreadcrumb({ crumbs: [{ kind: 'current', text: 'Help' }] });
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const searchId = useId();
  const matches = searchArticles(q);
  const searching = q.trim() !== '';
  return (
    <div className="help-index stack" data-help-index="">
      <h1>Help</h1>
      <div className="stack" style={{ gap: 4 }}>
        <label htmlFor={searchId} className="src">
          Search help
        </label>
        <input
          id={searchId}
          type="search"
          className="help-search"
          value={q}
          placeholder="For example: parked, restore, Jira"
          onChange={(e) =>
            setParams(e.target.value ? { q: e.target.value } : {}, { replace: true })
          }
        />
        <p className="src" role="status" data-help-count="" style={{ margin: 0 }}>
          {!searching
            ? ''
            : matches.length === 0
              ? `No articles match “${q.trim()}”. Try another word.`
              : `${matches.length} ${matches.length === 1 ? 'article matches' : 'articles match'} “${q.trim()}”.`}
        </p>
      </div>
      {HELP_GROUPS.map((g) => {
        const rows = matches.filter((a) => a.group === g);
        return rows.length === 0 ? null : <HelpGroupList key={g} group={g} rows={rows} />;
      })}
    </div>
  );
}

function HelpGroupList({ group, rows }: { group: string; rows: HelpArticle[] }) {
  const id = useId();
  return (
    <section className="help-group" aria-labelledby={id} data-help-group={group}>
      <h2 id={id}>{group}</h2>
      <Card>
        <ul className="help-list">
          {rows.map((a) => (
            <li key={a.slug} data-help-article={a.slug}>
              <Link to={paths.help(a.slug)}>{a.title}</Link>
              <div className="src">{a.summary}</div>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}

/** One article (`/help/:slug`): the rendered Markdown, then "Related" links. */
export function HelpArticlePage() {
  const { slug } = useParams();
  const article = articleBySlug(slug);
  const navigate = useNavigate();
  useBreadcrumb({
    crumbs: [
      { kind: 'link', text: 'Help', to: paths.help() },
      { kind: 'current', text: article?.title ?? 'Not found' },
    ],
  });
  if (!article) {
    return (
      <div className="help-article stack">
        <h1>No such help article</h1>
        <p>
          There’s no article called “{slug}”. <Link to={paths.help()}>See every article</Link>.
        </p>
      </div>
    );
  }
  return (
    <article className="help-article stack" data-help-article-page={article.slug}>
      <div className="src">{article.group}</div>
      <h1>{article.title}</h1>
      <p className="helpsum">{article.summary}</p>
      <Card padded>
        <ArticleBody
          body={article.body}
          label={article.title}
          onInternalLink={(href) => navigate(href)}
        />
        <Related article={article} />
      </Card>
    </article>
  );
}
