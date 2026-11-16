// Expected PR and metadata cases are transcribed from Lazygit's
// hosting_service_test.go at 54cc6af1d77b5a6cec3dc9ad0b203afdb4ad3451.
// The tests are self-contained; they do not require an upstream checkout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostingURLs } from './hosting.js';

const upstreamPullRequests = [
  {"name": "Opens a link to new pull request on bitbucket", "from": "feature/profile-page", "remoteUrl": "git@bitbucket.org:johndoe/social_network.git", "expected": "https://bitbucket.org/johndoe/social_network/pull-requests/new?source=feature%2Fprofile-page&t=1"},
  {"name": "Opens a link to new pull request on bitbucket with extra slash removed", "from": "feature/profile-page", "remoteUrl": "git@bitbucket.org:/johndoe/social_network.git", "expected": "https://bitbucket.org/johndoe/social_network/pull-requests/new?source=feature%2Fprofile-page&t=1"},
  {"name": "Opens a link to new pull request on bitbucket with http remote url", "from": "feature/events", "remoteUrl": "https://my_username@bitbucket.org/johndoe/social_network.git", "expected": "https://bitbucket.org/johndoe/social_network/pull-requests/new?source=feature%2Fevents&t=1"},
  {"name": "Opens a link to new pull request on github", "from": "feature/sum-operation", "remoteUrl": "git@github.com:peter/calculator.git", "expected": "https://github.com/peter/calculator/compare/feature%2Fsum-operation?expand=1"},
  {"name": "Opens a link to new pull request on github custom SSH config alias and a corresponding service config", "from": "feature/sum-operation", "remoteUrl": "github:peter/calculator.git", "services": {"github": "github:github.com"}, "expected": "https://github.com/peter/calculator/compare/feature%2Fsum-operation?expand=1"},
  {"name": "Opens a link to new pull request on github with extra slash removed", "from": "feature/sum-operation", "remoteUrl": "git@github.com:/peter/calculator.git", "expected": "https://github.com/peter/calculator/compare/feature%2Fsum-operation?expand=1"},
  {"name": "Opens a link to new pull request on github with https remote url", "from": "feature/sum-operation", "remoteUrl": "https://github.com/peter/calculator.git", "expected": "https://github.com/peter/calculator/compare/feature%2Fsum-operation?expand=1"},
  {"name": "Opens a link to new pull request on bitbucket with specific target branch", "from": "feature/profile-page/avatar", "to": "feature/profile-page", "remoteUrl": "git@bitbucket.org:johndoe/social_network.git", "expected": "https://bitbucket.org/johndoe/social_network/pull-requests/new?source=feature%2Fprofile-page%2Favatar&dest=feature%2Fprofile-page&t=1"},
  {"name": "Opens a link to new pull request on bitbucket with http remote url with specified target branch", "from": "feature/remote-events", "to": "feature/events", "remoteUrl": "https://my_username@bitbucket.org/johndoe/social_network.git", "expected": "https://bitbucket.org/johndoe/social_network/pull-requests/new?source=feature%2Fremote-events&dest=feature%2Fevents&t=1"},
  {"name": "Opens a link to new pull request on github with specific target branch", "from": "feature/sum-operation", "to": "feature/operations", "remoteUrl": "git@github.com:peter/calculator.git", "expected": "https://github.com/peter/calculator/compare/feature%2Foperations...feature%2Fsum-operation?expand=1"},
  {"name": "Opens a link to new pull request on github with specific target branch (different git username)", "from": "feature/sum-operation", "to": "feature/operations", "remoteUrl": "ssh://org-12345@github.com:peter/calculator.git", "expected": "https://github.com/peter/calculator/compare/feature%2Foperations...feature%2Fsum-operation?expand=1"},
  {"name": "Opens a link to new pull request on github with https remote url with specific target branch", "from": "feature/sum-operation", "to": "feature/operations", "remoteUrl": "https://github.com/peter/calculator.git", "expected": "https://github.com/peter/calculator/compare/feature%2Foperations...feature%2Fsum-operation?expand=1"},
  {"name": "Opens a link to new pull request on gitlab", "from": "feature/ui", "remoteUrl": "git@gitlab.com:peter/calculator.git", "expected": "https://gitlab.com/peter/calculator/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fui"},
  {"name": "Opens a link to new pull request on gitlab with custom SSH config alias and a corresponding service config", "from": "feature/ui", "remoteUrl": "gitlab:peter/calculator.git", "services": {"gitlab": "gitlab:gitlab.com"}, "expected": "https://gitlab.com/peter/calculator/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fui"},
  {"name": "Opens a link to new pull request on gitlab with extra slash removed", "from": "feature/ui", "remoteUrl": "git@gitlab.com:/peter/calculator.git", "expected": "https://gitlab.com/peter/calculator/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fui"},
  {"name": "Opens a link to new pull request on gitlab in nested groups", "from": "feature/ui", "remoteUrl": "git@gitlab.com:peter/public/calculator.git", "expected": "https://gitlab.com/peter/public/calculator/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fui"},
  {"name": "Opens a link to new pull request on gitlab in nested groups and extra slash removed", "from": "feature/ui", "remoteUrl": "git@gitlab.com:/peter/public/calculator.git", "expected": "https://gitlab.com/peter/public/calculator/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fui"},
  {"name": "Opens a link to new pull request on gitlab with https remote url in nested groups", "from": "feature/ui", "remoteUrl": "https://gitlab.com/peter/public/calculator.git", "expected": "https://gitlab.com/peter/public/calculator/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fui"},
  {"name": "Opens a link to new pull request on gitlab with specific target branch", "from": "feature/commit-ui", "to": "epic/ui", "remoteUrl": "git@gitlab.com:peter/calculator.git", "expected": "https://gitlab.com/peter/calculator/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fcommit-ui&merge_request%5Btarget_branch%5D=epic%2Fui"},
  {"name": "Opens a link to new pull request on gitlab with specific target branch in nested groups", "from": "feature/commit-ui", "to": "epic/ui", "remoteUrl": "git@gitlab.com:peter/public/calculator.git", "expected": "https://gitlab.com/peter/public/calculator/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fcommit-ui&merge_request%5Btarget_branch%5D=epic%2Fui"},
  {"name": "Opens a link to new pull request on gitlab with https remote url with specific target branch in nested groups", "from": "feature/commit-ui", "to": "epic/ui", "remoteUrl": "https://gitlab.com/peter/public/calculator.git", "expected": "https://gitlab.com/peter/public/calculator/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fcommit-ui&merge_request%5Btarget_branch%5D=epic%2Fui"},
  {"name": "Opens a link to new pull request on bitbucket with a custom SSH username", "from": "feature/profile-page", "remoteUrl": "john@bitbucket.org:johndoe/social_network.git", "expected": "https://bitbucket.org/johndoe/social_network/pull-requests/new?source=feature%2Fprofile-page&t=1"},
  {"name": "Opens a link to new pull request on Azure DevOps (SSH)", "from": "feature/new", "remoteUrl": "git@ssh.dev.azure.com:v3/myorg/myproject/myrepo", "expected": "https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequestcreate?sourceRef=feature%2Fnew"},
  {"name": "Opens a link to new pull request on Azure DevOps (SSH) with extra slash removed", "from": "feature/new", "remoteUrl": "git@ssh.dev.azure.com:/v3/myorg/myproject/myrepo", "expected": "https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequestcreate?sourceRef=feature%2Fnew"},
  {"name": "Opens a link to new pull request on Azure DevOps (SSH) with specific target", "from": "feature/new", "to": "dev", "remoteUrl": "git@ssh.dev.azure.com:v3/myorg/myproject/myrepo", "expected": "https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequestcreate?sourceRef=feature%2Fnew&targetRef=dev"},
  {"name": "Opens a link to new pull request on Azure DevOps (HTTP)", "from": "feature/new", "remoteUrl": "https://myorg@dev.azure.com/myorg/myproject/_git/myrepo", "expected": "https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequestcreate?sourceRef=feature%2Fnew"},
  {"name": "Opens a link to new pull request on Azure DevOps (HTTP) with specific target", "from": "feature/new", "to": "dev", "remoteUrl": "https://myorg@dev.azure.com/myorg/myproject/_git/myrepo", "expected": "https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequestcreate?sourceRef=feature%2Fnew&targetRef=dev"},
  {"name": "Opens a link to new pull request on Azure DevOps Server (HTTP)", "from": "feature/new", "remoteUrl": "https://mycompany.azuredevops.com/collection/myproject/_git/myrepo", "services": {"mycompany.azuredevops.com": "azuredevops:mycompany.azuredevops.com"}, "expected": "https://mycompany.azuredevops.com/collection/myproject/_git/myrepo/pullrequestcreate?sourceRef=feature%2Fnew"},
  {"name": "Opens a link to new pull request on Azure DevOps (legacy vs-ssh.visualstudio.com SSH) with mapping to dev.azure.com", "from": "feature/new", "remoteUrl": "git@vs-ssh.visualstudio.com:v3/myorg/myproject/myrepo", "services": {"vs-ssh.visualstudio.com": "azuredevops:dev.azure.com"}, "expected": "https://dev.azure.com/myorg/myproject/_git/myrepo/pullrequestcreate?sourceRef=feature%2Fnew"},
  {"name": "Opens a link to new pull request on Bitbucket Server (SSH)", "from": "feature/new", "remoteUrl": "ssh://git@mycompany.bitbucket.com/myproject/myrepo.git", "services": {"mycompany.bitbucket.com": "bitbucketServer:mycompany.bitbucket.com"}, "expected": "https://mycompany.bitbucket.com/projects/myproject/repos/myrepo/pull-requests?create&sourceBranch=feature%2Fnew"},
  {"name": "Opens a link to new pull request on Bitbucket Server (SSH) with extra slash removed", "from": "feature/new", "remoteUrl": "ssh://git@mycompany.bitbucket.com:/myproject/myrepo.git", "services": {"mycompany.bitbucket.com": "bitbucketServer:mycompany.bitbucket.com"}, "expected": "https://mycompany.bitbucket.com/projects/myproject/repos/myrepo/pull-requests?create&sourceBranch=feature%2Fnew"},
  {"name": "Opens a link to new pull request on Bitbucket Server (SSH) with specific target", "from": "feature/new", "to": "dev", "remoteUrl": "ssh://git@mycompany.bitbucket.com/myproject/myrepo.git", "services": {"mycompany.bitbucket.com": "bitbucketServer:mycompany.bitbucket.com"}, "expected": "https://mycompany.bitbucket.com/projects/myproject/repos/myrepo/pull-requests?create&targetBranch=dev&sourceBranch=feature%2Fnew"},
  {"name": "Opens a link to new pull request on Bitbucket Server (HTTP)", "from": "feature/new", "remoteUrl": "https://mycompany.bitbucket.com/scm/myproject/myrepo.git", "services": {"mycompany.bitbucket.com": "bitbucketServer:mycompany.bitbucket.com"}, "expected": "https://mycompany.bitbucket.com/projects/myproject/repos/myrepo/pull-requests?create&sourceBranch=feature%2Fnew"},
  {"name": "Opens a link to new pull request on Bitbucket Server (HTTP) with specific target", "from": "feature/new", "to": "dev", "remoteUrl": "https://mycompany.bitbucket.com/scm/myproject/myrepo.git", "services": {"mycompany.bitbucket.com": "bitbucketServer:mycompany.bitbucket.com"}, "expected": "https://mycompany.bitbucket.com/projects/myproject/repos/myrepo/pull-requests?create&targetBranch=dev&sourceBranch=feature%2Fnew"},
  {"name": "Opens a link to new pull request on Gitea Server (SSH)", "from": "feature/new", "remoteUrl": "ssh://git@mycompany.gitea.io/myproject/myrepo.git", "services": {"mycompany.gitea.io": "gitea:mycompany.gitea.io"}, "expected": "https://mycompany.gitea.io/myproject/myrepo/compare/feature%2Fnew"},
  {"name": "Opens a link to new pull request on Gitea Server (SSH) with specific target", "from": "feature/new", "to": "dev", "remoteUrl": "ssh://git@mycompany.gitea.io/myproject/myrepo.git", "services": {"mycompany.gitea.io": "gitea:mycompany.gitea.io"}, "expected": "https://mycompany.gitea.io/myproject/myrepo/compare/dev...feature%2Fnew"},
  {"name": "Opens a link to new pull request on Gitea Server (HTTP)", "from": "feature/new", "remoteUrl": "https://mycompany.gitea.io/myproject/myrepo.git", "services": {"mycompany.gitea.io": "gitea:mycompany.gitea.io"}, "expected": "https://mycompany.gitea.io/myproject/myrepo/compare/feature%2Fnew"},
  {"name": "Opens a link to new pull request on Gitea Server (HTTP) with specific target", "from": "feature/new", "to": "dev", "remoteUrl": "https://mycompany.gitea.io/myproject/myrepo.git", "services": {"mycompany.gitea.io": "gitea:mycompany.gitea.io"}, "expected": "https://mycompany.gitea.io/myproject/myrepo/compare/dev...feature%2Fnew"},
  {"name": "Opens a link to new pull request on Codeberg (SSH)", "from": "feature/new", "remoteUrl": "git@codeberg.org:johndoe/myrepo.git", "expected": "https://codeberg.org/johndoe/myrepo/compare/feature%2Fnew"},
  {"name": "Opens a link to new pull request on Codeberg (SSH) with specific target", "from": "feature/new", "to": "dev", "remoteUrl": "git@codeberg.org:johndoe/myrepo.git", "expected": "https://codeberg.org/johndoe/myrepo/compare/dev...feature%2Fnew"},
  {"name": "Opens a link to new pull request on Codeberg (HTTP)", "from": "feature/new", "remoteUrl": "https://codeberg.org/johndoe/myrepo.git", "expected": "https://codeberg.org/johndoe/myrepo/compare/feature%2Fnew"},
  {"name": "Opens a link to new pull request on Codeberg (HTTP) with specific target", "from": "feature/new", "to": "dev", "remoteUrl": "https://codeberg.org/johndoe/myrepo.git", "expected": "https://codeberg.org/johndoe/myrepo/compare/dev...feature%2Fnew"},
  {"name": "Throws an error if git service is unsupported", "from": "feature/divide-operation", "remoteUrl": "git@something.com:peter/calculator.git", "error": true},
  {"name": "Does not log error when config service domains are valid", "from": "feature/profile-page", "remoteUrl": "git@bitbucket.org:johndoe/social_network.git", "services": {"git.work.com": "gitlab:code.work.com"}, "expected": "https://bitbucket.org/johndoe/social_network/pull-requests/new?source=feature%2Fprofile-page&t=1"},
  {"name": "Does not log error when config service domains are valid with extra slash", "from": "feature/profile-page", "remoteUrl": "git@bitbucket.org:/johndoe/social_network.git", "services": {"git.work.com": "gitlab:code.work.com"}, "expected": "https://bitbucket.org/johndoe/social_network/pull-requests/new?source=feature%2Fprofile-page&t=1"},
  {"name": "Does not log error when config service webDomain contains a port", "from": "feature/profile-page", "remoteUrl": "git@my.domain.test:johndoe/social_network.git", "services": {"my.domain.test": "gitlab:my.domain.test:1111"}, "expected": "https://my.domain.test:1111/johndoe/social_network/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fprofile-page"},
  {"name": "Logs error when webDomain contains more than one colon", "from": "feature/profile-page", "remoteUrl": "git@my.domain.test:johndoe/social_network.git", "services": {"my.domain.test": "gitlab:my.domain.test:1111:2222"}, "error": true, "configurationErrors": ["Unexpected format for git service: 'gitlab:my.domain.test:1111:2222'. Expected something like 'github.com:github.com'"]},
  {"name": "Logs error when config service domain is malformed", "from": "feature/profile-page", "remoteUrl": "git@bitbucket.org:johndoe/social_network.git", "services": {"noservice.work.com": "noservice.work.com"}, "expected": "https://bitbucket.org/johndoe/social_network/pull-requests/new?source=feature%2Fprofile-page&t=1", "configurationErrors": ["Unexpected format for git service: 'noservice.work.com'. Expected something like 'github.com:github.com'"]},
  {"name": "Logs error when config service domain uses unknown provider", "from": "feature/profile-page", "remoteUrl": "git@bitbucket.org:johndoe/social_network.git", "services": {"invalid.work.com": "noservice:invalid.work.com"}, "expected": "https://bitbucket.org/johndoe/social_network/pull-requests/new?source=feature%2Fprofile-page&t=1", "configurationErrors": ["Unknown git service type: 'noservice'. Expected one of github, bitbucket, gitlab, azuredevops, bitbucketServer, gitea, codeberg"]},
  {"name": "Escapes reserved URL characters in from branch name", "from": "feature/someIssue#123", "to": "master", "remoteUrl": "git@gitlab.com:me/public/repo-with-issues.git", "expected": "https://gitlab.com/me/public/repo-with-issues/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2FsomeIssue%23123&merge_request%5Btarget_branch%5D=master"},
  {"name": "Escapes reserved URL characters in to branch name", "from": "yolo", "to": "archive/never-ending-feature#666", "remoteUrl": "git@gitlab.com:me/public/repo-with-issues.git", "expected": "https://gitlab.com/me/public/repo-with-issues/-/merge_requests/new?merge_request%5Bsource_branch%5D=yolo&merge_request%5Btarget_branch%5D=archive%2Fnever-ending-feature%23666"},
];

for (const fixture of upstreamPullRequests) test(`upstream: ${fixture.name}`, () => {
  let error, urls, actual;
  try {
    urls = hostingURLs(fixture.remoteUrl, fixture.services);
    actual = urls.pullRequest(fixture.from, fixture.to);
  } catch (caught) { error = caught; }
  if (fixture.error) {
    assert.equal(error?.code, 'unsupported-service');
    assert.equal(error?.message, 'Unsupported git service');
  } else {
    assert.ifError(error);
    assert.equal(actual, fixture.expected);
  }
  assert.deepEqual((urls ?? error).configurationErrors, fixture.configurationErrors ?? []);
});

const upstreamServiceInfo = [
  {"name": "github.com SSH", "remoteUrl": "git@github.com:jesseduffield/lazygit.git", "expected": {"provider": "github", "webDomain": "github.com", "owner": "jesseduffield", "repository": "lazygit", "repoName": "jesseduffield/lazygit"}},
  {"name": "github enterprise with same git and web host", "remoteUrl": "git@github.example.com:my-org/my-repo.git", "services": {"github.example.com": "github:github.example.com"}, "expected": {"provider": "github", "webDomain": "github.example.com", "owner": "my-org", "repository": "my-repo", "repoName": "my-org/my-repo"}},
  {"name": "github enterprise with distinct git and web hosts", "remoteUrl": "git@git.example.com:my-org/my-repo.git", "services": {"git.example.com": "github:ghe.example.com"}, "expected": {"provider": "github", "webDomain": "ghe.example.com", "owner": "my-org", "repository": "my-repo", "repoName": "my-org/my-repo"}},
  {"name": "github enterprise with web host port", "remoteUrl": "git@git.example.com:my-org/my-repo.git", "services": {"git.example.com": "github:ghe.example.com:8443"}, "expected": {"provider": "github", "webDomain": "ghe.example.com:8443", "owner": "my-org", "repository": "my-repo", "repoName": "my-org/my-repo"}},
  {"name": "azuredevops", "remoteUrl": "https://myorg@dev.azure.com/myorg/myproject/_git/myrepo", "expected": {"provider": "azuredevops", "webDomain": "dev.azure.com", "repository": "myrepo", "repoName": "myorg/myproject/myrepo", "owner": ""}},
  {"name": "bitbucketServer", "remoteUrl": "https://mycompany.bitbucket.com/scm/myproject/myrepo.git", "services": {"mycompany.bitbucket.com": "bitbucketServer:mycompany.bitbucket.com"}, "expected": {"provider": "bitbucketServer", "webDomain": "mycompany.bitbucket.com", "repository": "myrepo", "repoName": "myproject/myrepo", "owner": ""}},
];

for (const fixture of upstreamServiceInfo) test(`upstream metadata: ${fixture.name}`, () => {
  const urls = hostingURLs(fixture.remoteUrl, fixture.services);
  const { provider, webDomain, owner, repository, repoName } = urls;
  assert.deepEqual({ provider, webDomain, owner, repository, repoName }, fixture.expected);
});

// These expectations come from each provider's commitURL/repoURLTemplate in
// upstream definitions.go, independently of the port's implementation.
const commits = [
  ['github', 'git@github.com:owner/repo.git', {}, 'https://github.com/owner/repo/commit/a1b2c3'],
  ['bitbucket', 'git@bitbucket.org:owner/repo.git', {}, 'https://bitbucket.org/owner/repo/commits/a1b2c3'],
  ['gitlab', 'https://gitlab.com/team/group/repo.git', {}, 'https://gitlab.com/team/group/repo/-/commit/a1b2c3'],
  ['azuredevops', 'git@ssh.dev.azure.com:v3/org/project/repo', {}, 'https://dev.azure.com/org/project/_git/repo/commit/a1b2c3'],
  ['bitbucketServer', 'ssh://git@bitbucket.example:7999/project/repo.git', {'bitbucket.example':'bitbucketServer:bitbucket.example:8443'}, 'https://bitbucket.example:8443/projects/project/repos/repo/commits/a1b2c3'],
  ['gitea', 'ssh://git@try.gitea.io/owner/repo.git', {}, 'https://try.gitea.io/owner/repo/commit/a1b2c3'],
  ['codeberg', 'git@codeberg.org:owner/repo.git', {}, 'https://codeberg.org/owner/repo/commit/a1b2c3'],
];
for (const [provider, remote, services, expected] of commits) test(`commit URL: ${provider}`, () => {
  const urls = hostingURLs(remote, services);
  assert.equal(urls.provider, provider);
  assert.equal(urls.commit('a1b2c3'), expected);
});

test('configured web host and port are distinct from SSH port and preserve nested groups', () => {
  const urls = hostingURLs('ssh://deploy@git.example.com:2222/team/nested/repo.git', {'git.example.com':'gitlab:web.example.com:8443'});
  assert.equal(urls.repoURL, 'https://web.example.com:8443/team/nested/repo');
  assert.equal(urls.owner, 'team/nested');
  assert.equal(urls.repository, 'repo');
  assert.equal(urls.pullRequest('feature/new', 'main'), 'https://web.example.com:8443/team/nested/repo/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fnew&merge_request%5Btarget_branch%5D=main');
});

test('HTTPS credentials and clone port are not copied into the configured web URL', () => {
  const urls = hostingURLs('https://user:secret@git.example.com:9443/team/nested/repo.git', {'git.example.com':'gitlab:web.example.com:8443'});
  assert.equal(urls.commit('a1b2c3'), 'https://web.example.com:8443/team/nested/repo/-/commit/a1b2c3');
});

test('query escaping preserves reserved characters and Unicode as branch values', () => {
  const branch = "feature/it's!(x)* +#%한글";
  const actual = hostingURLs('git@gitlab.com:team/repo.git').pullRequest(branch, 'target/a&b');
  assert.equal(actual, 'https://gitlab.com/team/repo/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fit%27s%21%28x%29%2A+%2B%23%25%ED%95%9C%EA%B8%80&merge_request%5Btarget_branch%5D=target%2Fa%26b');
  const parsed = new URL(actual);
  assert.equal(parsed.searchParams.get('merge_request[source_branch]'), branch);
  assert.equal(parsed.searchParams.get('merge_request[target_branch]'), 'target/a&b');
  assert.equal(parsed.hash, '');
});

test('malformed known remotes and unimplemented branch links fail explicitly', () => {
  assert.throws(() => hostingURLs('github.com'), {code:'invalid-remote', message:'Failed to parse repo information from url'});
  assert.throws(() => hostingURLs('git@github.com:owner/repo.git').branch('main'), {code:'unsupported-operation', message:'Branch URLs are not supported'});
});
