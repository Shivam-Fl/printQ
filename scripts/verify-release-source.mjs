// The required CI / check job runs this for every PR. Production releases must
// originate from the protected integration branch; feature PRs target development.
const eventName = process.env.GITHUB_EVENT_NAME;
const baseRef = process.env.GITHUB_BASE_REF;
const headRef = process.env.GITHUB_HEAD_REF;

if (eventName === 'pull_request' && baseRef === 'master' && headRef !== 'development') {
  console.error('Production master PRs must originate from the protected development branch.');
  process.exitCode = 1;
}
