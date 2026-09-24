const environment = import.meta.env.VITE_PRINTQ_ENVIRONMENT;

/** A deliberately quiet but persistent guard against confusing development
 * with the live counter. It is absent unless the build is explicitly marked. */
export default function EnvironmentBanner() {
  if (environment !== 'development' && environment !== 'test') return null;
  return (
    <div className="environment-banner" role="status">
      <span className="stamp yellow">{environment}</span>
      <span>Isolated {environment} environment — do not use live students, shop payments, or printer credentials here.</span>
    </div>
  );
}
