// Works out how to build, test and run an unfamiliar repository.
//
// Pure functions over a description of the repo (file list + parsed manifests) so the whole
// thing is testable without a filesystem. `sdlc install` gathers the facts; this decides.
//
// Everything here is a GUESS, and it says so. The output is written into config.yml as a
// starting point a human corrects — an install that silently guesses wrong produces a
// pipeline whose CI passes because it runs nothing.

/**
 * @param {{files: string[], pkg?: object, workflows?: string[]}} repo
 * @returns {{stack: string, verify: object, env: object, confidence: object, notes: string[]}}
 */
export function detect(repo) {
  const files = new Set(repo.files ?? []);
  const pkg = repo.pkg ?? null;
  const scripts = pkg?.scripts ?? {};
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const has = (f) => files.has(f);
  const notes = [];
  const confidence = {};

  // --- language / stack ------------------------------------------------------
  let stack = 'unknown';
  if (pkg) stack = 'node';
  if (has('go.mod')) stack = 'go';
  if (has('Cargo.toml')) stack = 'rust';
  if (has('pyproject.toml') || has('setup.py') || has('requirements.txt')) stack = 'python';
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) stack = 'jvm';

  // A JS framework is more useful than "node" when picking a preview strategy.
  const framework =
    deps.next ? 'next'
    : deps.nuxt ? 'nuxt'
    : deps['@remix-run/react'] ? 'remix'
    : deps.astro ? 'astro'
    : deps.vite ? 'vite'
    : deps['react-scripts'] ? 'cra'
    : deps['@angular/core'] ? 'angular'
    : null;

  // --- verify commands -------------------------------------------------------
  // Prefer a script the repo already defines: it encodes flags and config we cannot infer.
  const script = (...names) => {
    for (const n of names) if (scripts[n]) return `npm run ${n}`;
    return '';
  };

  const verify = { typecheck: '', lint: '', unit: '', build: '', e2e: '' };

  if (stack === 'node') {
    verify.typecheck = script('typecheck', 'type-check', 'tsc', 'types');
    if (!verify.typecheck && (has('tsconfig.json') || deps.typescript)) {
      verify.typecheck = 'npx tsc --noEmit';
      notes.push('no typecheck script found; guessed `npx tsc --noEmit` from tsconfig.json');
      confidence.typecheck = 'guessed';
    }
    verify.lint = script('lint', 'eslint');
    verify.unit = script('test:unit', 'test', 'jest', 'vitest');
    verify.build = script('build', 'compile');

    const e2eScript = script('test:e2e', 'e2e', 'playwright', 'cypress');
    if (e2eScript) verify.e2e = e2eScript;
    else if (deps['@playwright/test']) {
      verify.e2e = 'npx playwright test';
      confidence.e2e = 'guessed';
    }

    // `npm test` on a repo with no tests configured exits 1 and reads as a real failure.
    if (scripts.test && /no test specified/i.test(scripts.test)) {
      verify.unit = '';
      notes.push('the `test` script is the npm placeholder — left unit empty rather than failing every PR');
    }
  } else if (stack === 'python') {
    verify.unit = has('pyproject.toml') && files.has('poetry.lock') ? 'poetry run pytest' : 'pytest';
    verify.lint = files.has('.ruff.toml') || files.has('ruff.toml') ? 'ruff check .' : '';
    verify.typecheck = files.has('mypy.ini') || files.has('.mypy.ini') ? 'mypy .' : '';
    confidence.unit = 'guessed';
  } else if (stack === 'go') {
    verify.unit = 'go test ./...';
    verify.build = 'go build ./...';
    verify.lint = files.has('.golangci.yml') || files.has('.golangci.yaml') ? 'golangci-lint run' : '';
  } else if (stack === 'rust') {
    verify.unit = 'cargo test';
    verify.build = 'cargo build';
    verify.lint = 'cargo clippy -- -D warnings';
    verify.typecheck = 'cargo check';
  } else if (stack === 'jvm') {
    const gradle = has('build.gradle') || has('build.gradle.kts');
    verify.unit = gradle ? './gradlew test' : 'mvn -B test';
    verify.build = gradle ? './gradlew build -x test' : 'mvn -B package -DskipTests';
    confidence.unit = 'guessed';
  }

  // --- QA environment --------------------------------------------------------
  // A library has no URL to drive, and browser QA against it is meaningless. Saying so is
  // far better than emitting a compose config with an empty boot command, which fails at
  // wait-ready and reads as a broken pipeline rather than an inapplicable stage.
  const isLibrary =
    Boolean(pkg) && !scripts.start && !scripts.dev && !scripts.serve &&
    Boolean(pkg.main || pkg.exports || pkg.module) &&
    !deps.next && !deps.nuxt && !deps.astro && !deps['react-scripts'] && !deps['@angular/core'];

  const hasPreviewHost =
    has('vercel.json') || has('netlify.toml') || has('render.yaml') || has('fly.toml');
  const env = isLibrary && !hasPreviewHost && !framework
    ? { mode: 'none', url_allowlist: [], ready: '' }
    : hasPreviewHost || framework
    ? {
        mode: 'preview',
        url_allowlist: previewHostsFor({ files, framework }),
        ready: '/',
      }
    : {
        mode: 'compose',
        url_allowlist: ['localhost:*'],
        base_url: 'http://localhost:3000',
        boot: has('docker-compose.yml') || has('compose.yaml')
          ? 'docker compose up -d'
          : scripts.start ? 'npm start' : scripts.dev ? 'npm run dev' : '',
        ready: '/',
      };

  if (env.mode === 'none') {
    notes.push('this looks like a library, not an app — browser QA is disabled (env.mode: none). CI, review and the unit suite still gate every PR. Set env.mode if it does ship a runnable surface.');
    confidence.env = 'library';
  }
  if (env.mode === 'preview') {
    notes.push('preview mode assumed — QA waits for a deployment_status event. If this repo has no per-PR preview deploys, switch env.mode to compose.');
    confidence.env = 'guessed';
  }
  if (env.mode === 'compose' && !env.boot) {
    notes.push('could not work out how to start this app — set env.boot, or QA will have nothing to drive');
    confidence.env = 'unknown';
  }

  // --- monorepo ---------------------------------------------------------------
  if (pkg?.workspaces) {
    const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages ?? [];
    notes.push(
      `npm workspaces detected (${ws.join(', ')}). Monorepos usually need codegen or a shared ` +
      'package built before typecheck will run — set verify.prepare, or every check fails for ' +
      'reasons unrelated to the PR.',
    );
    confidence.prepare = 'needs-a-human';
  }

  // --- existing CI -----------------------------------------------------------
  const existing = (repo.workflows ?? []).filter((w) => !w.startsWith('sdlc-') && w !== 'ci-verify.yml');
  // A repo with its own CI should keep using it. Running a second, weaker set of checks
  // beside it burns minutes and gates on less than the team actually trusts.
  const verifyMode = existing.length ? 'existing' : 'own';
  if (existing.length) {
    notes.push(
      `this repo already has ${existing.length} workflow(s) (${existing.slice(0, 3).join(', ')}` +
      `${existing.length > 3 ? ', …' : ''}), so verify.mode is set to "existing" — the pipeline ` +
      'waits for those checks rather than duplicating them. Set verify.required_checks to the ' +
      'job names that must pass, or leave it empty to wait for all of them.',
    );
    confidence.verify_mode = 'from existing CI';
  }

  for (const k of Object.keys(verify)) {
    if (!verify[k] && !confidence[k]) confidence[k] = 'none found';
  }

  return { stack, framework, verify, verifyMode, existingWorkflows: existing, env, confidence, notes };
}

function previewHostsFor({ files, framework }) {
  const hosts = [];
  if (files.has('vercel.json') || framework === 'next') hosts.push('*.vercel.app');
  if (files.has('netlify.toml')) hosts.push('*.netlify.app');
  if (files.has('render.yaml')) hosts.push('*.onrender.com');
  if (files.has('fly.toml')) hosts.push('*.fly.dev');
  return hosts.length ? hosts : ['*.vercel.app'];
}

/**
 * Paths no agent should touch, on top of the framework defaults. Derived from what the repo
 * actually contains rather than a fixed list, because "infra/" means nothing in a repo that
 * keeps its terraform in "deploy/".
 */
export function forbiddenFor(repo) {
  const files = repo.files ?? [];
  const base = ['.github/**', '.sdlc/config.yml', '**/*.env*'];

  // Matched ANYWHERE in the path, not just at the root. A monorepo keeps its migrations at
  // apps/api/prisma/migrations/, and anchoring to the start silently reserves nothing —
  // which is the worst possible outcome for this particular guard.
  const DIRS = [
    'migrations', 'migrate', 'alembic',
    'infra', 'infrastructure', 'terraform', 'deploy', 'charts', 'k8s', 'helm',
  ];
  const FILES = ['Jenkinsfile', '.gitlab-ci.yml', 'docker-compose.yml', 'Dockerfile', 'render.yaml', 'vercel.json'];

  const found = new Set(base);
  for (const raw of files) {
    const f = String(raw).replace(/\\/g, '/');
    const parts = f.split('/');

    for (const d of DIRS) {
      const i = parts.indexOf(d);
      if (i !== -1) found.add(parts.slice(0, i + 1).join('/') + '/**');
    }
    // Deploy and CI descriptors change how the app ships — reserved wherever they sit.
    if (FILES.includes(parts.at(-1))) found.add(f);
  }
  return [...found].sort();
}
