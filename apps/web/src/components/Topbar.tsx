import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

export default function Topbar({ right, tag }: { right?: ReactNode; tag?: string }) {
  return (
    <div className="topbar">
      <Link to="/" className="brand">
        Print<em>Q</em>
        {tag && <small>{tag}</small>}
      </Link>
      <div className="row">{right}</div>
    </div>
  );
}
