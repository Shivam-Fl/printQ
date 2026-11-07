import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

export default function Topbar({ right, tag }: { right?: ReactNode; tag?: string }) {
  return (
    <div className="topbar">
      <Link to="/" className="brand">
        {/* one span: the brand link is inline-flex, so bare text + <em> would be read as "Print Q" */}
        <span>Print<em>Q</em>s</span>
        {tag && <small title={tag}>{tag}</small>}
      </Link>
      <div className="row">{right}</div>
    </div>
  );
}
