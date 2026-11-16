import { Link } from 'react-router';
import { Card } from '../components/kit';
import { paths } from '../lib/paths';

/** Any path outside UI_SPEC §2's routes. */
export function NotFound() {
  return (
    <div>
      <h1>Page not found</h1>
      <Card padded>
        <span className="muted">There’s no page here. </span>
        <Link to={paths.needsYou()}>Go to Needs you</Link>
      </Card>
    </div>
  );
}
