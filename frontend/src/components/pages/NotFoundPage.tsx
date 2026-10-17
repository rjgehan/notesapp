import { Compass } from 'lucide-react';
import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <div className="empty-state">
      <Compass size={44} aria-hidden />
      <h2>Page not found</h2>
      <p>
        <Link to="/">Go to the start page</Link>
      </p>
    </div>
  );
}
