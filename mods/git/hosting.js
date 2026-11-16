// Ported from Lazygit pkg/commands/hosting_service at 54cc6af1d77b5a6cec3dc9ad0b203afdb4ad3451.
// Pure URL construction: no Git commands, network requests, or browser opens.
const DEFAULT_PATTERNS = [
  /^(?:https?|ssh):\/\/[^/]+\/(?<owner>.*)\/(?<repo>.*?)(?:\.git)?$/,
  /^(.*?@)?.*:\/*(?<owner>.*)\/(?<repo>.*?)(?:\.git)?$/,
];
const REPO_URL = "https://{{.webDomain}}/{{.owner}}/{{.repo}}";
const REPO_NAME = "{{.owner}}/{{.repo}}";
const DEFINITIONS = {
  github: {
    defaultPR: "/compare/{{.From}}?expand=1", targetPR: "/compare/{{.To}}...{{.From}}?expand=1", commit: "/commit/{{.CommitHash}}",
    patterns: DEFAULT_PATTERNS, repoURL: REPO_URL, repoName: REPO_NAME,
  },
  bitbucket: {
    defaultPR: "/pull-requests/new?source={{.From}}&t=1", targetPR: "/pull-requests/new?source={{.From}}&dest={{.To}}&t=1", commit: "/commits/{{.CommitHash}}",
    patterns: [/^(?:https?|ssh):\/\/.*\/(?<owner>.*)\/(?<repo>.*?)(?:\.git)?$/, /^.*@.*:\/*(?<owner>.*)\/(?<repo>.*?)(?:\.git)?$/],
    repoURL: REPO_URL, repoName: REPO_NAME,
  },
  gitlab: {
    defaultPR: "/-/merge_requests/new?merge_request%5Bsource_branch%5D={{.From}}",
    targetPR: "/-/merge_requests/new?merge_request%5Bsource_branch%5D={{.From}}&merge_request%5Btarget_branch%5D={{.To}}", commit: "/-/commit/{{.CommitHash}}",
    patterns: DEFAULT_PATTERNS, repoURL: REPO_URL, repoName: REPO_NAME,
  },
  azuredevops: {
    defaultPR: "/pullrequestcreate?sourceRef={{.From}}", targetPR: "/pullrequestcreate?sourceRef={{.From}}&targetRef={{.To}}", commit: "/commit/{{.CommitHash}}",
    patterns: [
      /^.+@vs-ssh\.visualstudio\.com[:/](?:v3\/)?(?<org>[^/]+)\/(?<project>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/,
      /^git@ssh.dev.azure.com.*\/(?<org>.*)\/(?<project>.*)\/(?<repo>.*?)(?:\.git)?$/,
      /^https:\/\/.*@dev.azure.com\/(?<org>.*?)\/(?<project>.*?)\/_git\/(?<repo>.*?)(?:\.git)?$/,
      /^https:\/\/.*\/(?<org>.*?)\/(?<project>.*?)\/_git\/(?<repo>.*?)(?:\.git)?$/,
    ],
    repoURL: "https://{{.webDomain}}/{{.org}}/{{.project}}/_git/{{.repo}}", repoName: "{{.org}}/{{.project}}/{{.repo}}",
  },
  bitbucketServer: {
    defaultPR: "/pull-requests?create&sourceBranch={{.From}}", targetPR: "/pull-requests?create&targetBranch={{.To}}&sourceBranch={{.From}}", commit: "/commits/{{.CommitHash}}",
    patterns: [/^ssh:\/\/git@.*\/(?<project>.*)\/(?<repo>.*?)(?:\.git)?$/, /^https:\/\/.*\/scm\/(?<project>.*)\/(?<repo>.*?)(?:\.git)?$/],
    repoURL: "https://{{.webDomain}}/projects/{{.project}}/repos/{{.repo}}", repoName: "{{.project}}/{{.repo}}",
  },
  gitea: {
    defaultPR: "/compare/{{.From}}", targetPR: "/compare/{{.To}}...{{.From}}", commit: "/commit/{{.CommitHash}}",
    patterns: DEFAULT_PATTERNS, repoURL: REPO_URL,
  },
  codeberg: {
    defaultPR: "/compare/{{.From}}", targetPR: "/compare/{{.To}}...{{.From}}", commit: "/commit/{{.CommitHash}}",
    patterns: DEFAULT_PATTERNS, repoURL: REPO_URL,
  },
};
const DEFAULT_DOMAINS = [
  ["github.com", "github", "github.com"], ["bitbucket.org", "bitbucket", "bitbucket.org"],
  ["gitlab.com", "gitlab", "gitlab.com"], ["dev.azure.com", "azuredevops", "dev.azure.com"],
  ["try.gitea.io", "gitea", "try.gitea.io"], ["codeberg.org", "codeberg", "codeberg.org"],
];
const resolve = (template, values) => template.replace(/\{\{\.?([A-Za-z]+)\}\}/g, (token, key) => values[key] ?? token);
// Match Go net/url.QueryEscape, including + for spaces and escaped !'()*.
const queryEscape = (value) => encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, "+");
const failure = (message, code, configurationErrors = []) => Object.assign(new Error(message), { code, configurationErrors });

// services has Lazygit's shape: {"git.work.com": "gitlab:code.work.com:8443"}.
// Invalid unrelated mappings are reported as metadata, as upstream logs and
// skips them rather than preventing a supported built-in remote from working.
export function hostingURLs(remoteUrl, services = {}) {
  const remote = typeof remoteUrl === "string" ? remoteUrl : "";
  const domains = [...DEFAULT_DOMAINS], configurationErrors = [];
  for (const [gitDomain, value] of Object.entries(services ?? {})) {
    const split = typeof value === "string" ? value.indexOf(":") : -1;
    const provider = split < 0 ? "" : value.slice(0, split), webDomain = split < 0 ? "" : value.slice(split + 1);
    if (split < 0 || webDomain.split(":").length > 2) {
      configurationErrors.push(`Unexpected format for git service: '${value}'. Expected something like 'github.com:github.com'`);
    } else if (!Object.hasOwn(DEFINITIONS, provider)) {
      configurationErrors.push(`Unknown git service type: '${provider}'. Expected one of ${Object.keys(DEFINITIONS).join(", ")}`);
    } else domains.push([gitDomain, provider, webDomain]);
  }
  // Preserve upstream's default-domain precedence and substring matching.
  const domain = domains.find(([gitDomain]) => remote.includes(gitDomain));
  if (!domain) throw failure("Unsupported git service", "unsupported-service", configurationErrors);
  const [, provider, webDomain] = domain, definition = DEFINITIONS[provider];
  let captures;
  for (const pattern of definition.patterns) {
    const match = pattern.exec(remote);
    if (match) { captures = match.groups; break; }
  }
  if (!captures) throw failure("Failed to parse repo information from url", "invalid-remote", configurationErrors);
  const repoURL = resolve(definition.repoURL, { ...captures, webDomain });
  return {
    provider, webDomain, repoURL, owner: captures.owner ?? "", repository: captures.repo,
    // Gitea/Codeberg omit repoNameTemplate in the pinned upstream definition.
    repoName: resolve(definition.repoName ?? "", captures), configurationErrors,
    commit: (hash) => repoURL + resolve(definition.commit, { CommitHash: String(hash) }),
    pullRequest: (from, to = "") => repoURL + resolve(to === "" ? definition.defaultPR : definition.targetPR,
      { From: queryEscape(from), To: queryEscape(to) }),
    // The pinned Lazygit hosting helper has no branch-page URL contract.
    branch: () => { throw failure("Branch URLs are not supported", "unsupported-operation"); },
  };
}
