// Which away-window flags a command line carries: --auto, --admin, queue and API merge forms.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeFlags, parseCommand, unreadableLine } from './parse-command.mjs';

const M = 'gh pr ' + 'merge';
const gql = (query) => `gh api graphql -f query='${query}'`;
const ENQUEUE =
  'mutation { enqueuePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }';
const AUTOMERGE =
  'mutation { enablePullRequestAutoMerge(input: {pullRequestId: "x"}) { clientMutationId } }';
const DIRECT =
  'mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }';

test('--auto is reported on a merge, wherever it sits', () => {
  assert.deepEqual(parseCommand(`${M} 42 --auto --squash`), [
    { action: 'merge', pr: '42', repo: null, flags: ['auto'] },
  ]);
  assert.deepEqual(mergeFlags(`${M} --auto --squash 42`), ['auto']);
});

test('--admin is reported, and both together', () => {
  assert.deepEqual(mergeFlags(`${M} 42 --admin`), ['admin']);
  assert.deepEqual(mergeFlags(`${M} 42 --admin --auto`), ['admin', 'auto']);
});

test('--auto and --admin are booleans: =false is a no-op, every other value is on', () => {
  for (const f of ['auto', 'admin']) {
    assert.deepEqual(mergeFlags(`${M} 42 --${f}=false`), [], f);
    assert.deepEqual(mergeFlags(`${M} 42 --${f}=FALSE`), [], f);
    for (const v of ['true', '1', 'yes', 'maybe', ''])
      assert.deepEqual(mergeFlags(`${M} 42 --${f}=${v}`), [f], `${f}=${v}`);
    assert.deepEqual(mergeFlags(`${M} 42 --${f}`), [f]);
  }
});

test('a plain merge carries no flags and reads exactly as before', () => {
  assert.deepEqual(parseCommand(`${M} 42 --squash`), [
    { action: 'merge', pr: '42', repo: null },
  ]);
  assert.deepEqual(mergeFlags(`${M} 42 --squash`), []);
});

test('--disable-auto is not a forbidden flag', () => {
  assert.deepEqual(mergeFlags(`${M} 42 --disable-auto`), []);
});

test('a flag spelling inside a flag value is text, not a flag', () => {
  assert.deepEqual(mergeFlags(`${M} 42 --body "--auto --admin"`), []);
  assert.deepEqual(mergeFlags(`${M} 42 --subject --admin`), []);
});

test('a flagged merge inside a shell wrapper is still read', () => {
  assert.deepEqual(mergeFlags(`bash -c '${M} 42 --auto'`), ['auto']);
});

test('a short-flag cluster stays unreadable, so it is denied outright', () => {
  assert.equal(unreadableLine(`${M} 42 -sA`), true);
});

test('the GraphQL enqueue and auto-merge mutations read as queue', () => {
  assert.deepEqual(mergeFlags(gql(ENQUEUE)), ['queue']);
  assert.deepEqual(mergeFlags(gql(AUTOMERGE)), ['queue']);
  assert.deepEqual(
    mergeFlags(`gh api graphql --raw-field query='${ENQUEUE}'`),
    ['queue'],
  );
});

test('the GraphQL mergePullRequest mutation reads as api', () => {
  assert.deepEqual(mergeFlags(gql(DIRECT)), ['api']);
});

test('a REST PUT to a merge path reads as api, in every spelling of the method', () => {
  for (const m of ['-X PUT', '-XPUT', '--method PUT', '--method=put'])
    assert.deepEqual(
      mergeFlags(`gh api ${m} repos/o/r/pulls/42/merge`),
      ['api'],
      m,
    );
  // Other methods and other paths are not that form.
  assert.deepEqual(mergeFlags('gh api repos/o/r/pulls/42'), []);
  assert.deepEqual(mergeFlags('gh api -X GET repos/o/r/pulls/42/merge'), []);
});

test('a GraphQL call whose query cannot be read counts as queue', () => {
  const unreadable = [
    'gh api graphql -F query=@q.graphql',
    'gh api graphql --input q.json',
    'gh api graphql --input - <<EOF\n{}\nEOF',
    'gh api graphql',
    'gh api graphql -f query="$QUERY"',
    'gh api graphql -f query=$QUERY',
    'gh api graphql -f query="$(cat q.graphql)"',
    'gh api graphql -f query=`cat q.graphql`',
  ];
  for (const cmd of unreadable)
    assert.deepEqual(mergeFlags(cmd), ['queue'], cmd);
});

test('a readable read-only query carries no flag, and a GraphQL variable in single quotes is not an expansion', () => {
  assert.deepEqual(mergeFlags(gql('{ viewer { login } }')), []);
  assert.deepEqual(
    mergeFlags(gql('query($id: ID!) { node(id: $id) { id } }') + ' -F id=abc'),
    [],
  );
});

test('every spelling of the GraphQL endpoint is read, with repo flags and extra spaces', () => {
  for (const ep of [
    'graphql',
    '/graphql',
    'graphql/',
    'graphql?x=1',
    'https://api.github.com/graphql',
    'https://api.github.com/graphql/',
  ])
    assert.deepEqual(
      mergeFlags(`gh api ${ep} -f query='${ENQUEUE}'`),
      ['queue'],
      ep,
    );
  for (const cmd of [
    `gh -R o/r api graphql -f query='${DIRECT}'`,
    `gh --repo o/r api graphql -f query='${DIRECT}'`,
    `gh  api   graphql  -f   query='${DIRECT}'`,
  ])
    assert.deepEqual(mergeFlags(cmd), ['api'], cmd);
  assert.deepEqual(mergeFlags('gh api /graphql'), ['queue']); // no query to read
});

test('only the query field decides whether a graphql call is readable', () => {
  const read = '{ viewer { login } }';
  for (const cmd of [
    `gh api graphql -f query='${read}' -F id="$THREAD_ID"`,
    `gh api graphql -f query='${read}' --jq "$FILTER"`,
    `gh api graphql -F id="$ID" -f query='${read}' | jq "$FILTER"`,
    `gh api graphql -f query='query($id: ID!) { node(id: $id) { id } }' -F id="$ID"`,
  ])
    assert.deepEqual(mergeFlags(cmd), [], cmd);
  for (const cmd of [
    'gh api graphql -f query="$Q"',
    'gh api graphql -f "query=$Q"',
    'gh api graphql --field=query=$Q',
    `gh api graphql -F id="$ID" -f query="$(cat q.graphql)"`,
  ])
    assert.deepEqual(mergeFlags(cmd), ['queue'], cmd);
});

test('gh api is found behind any wrapper words', () => {
  for (const pre of [
    'timeout 30',
    'xargs -I{}',
    'env -i',
    'sudo -u bob',
    'nice -n 5',
  ])
    assert.deepEqual(
      mergeFlags(`${pre} gh api graphql -f query='${ENQUEUE}'`),
      ['queue'],
      pre,
    );
});

test('an expanding field word counts as opaque unless its literal name is not query', () => {
  const read = "-f query='{viewer{login}}'";
  for (const extra of ['-f "$X"', '-F "$X"', '--field "$X"', '-f "query=$Q"'])
    assert.deepEqual(mergeFlags(`gh api graphql ${read} ${extra}`), ['queue']);
  for (const extra of ['-F id="$THREAD_ID"', '-f note=$(date)', '-F n=5'])
    assert.deepEqual(mergeFlags(`gh api graphql ${read} ${extra}`), []);
});

test('another tool calling the API merge or GraphQL path reads as api; other paths do not', () => {
  const host = 'https://api.github.com';
  for (const cmd of [
    `curl -X PUT ${host}/repos/o/r/pulls/4/` + 'merge',
    `wget --method=POST ${host}/graphql`,
    `node -e "fetch('${host}/graphql')"`,
    `python3 -c "import requests; requests.post('${host}/graphql')"`,
  ])
    assert.deepEqual(mergeFlags(cmd), ['api'], cmd);
  for (const cmd of [
    `curl ${host}/repos/o/r/pulls/4`,
    `curl ${host}/user`,
    'curl https://example.com/graphql',
    `gh api ${host}/graphql -f query='{ viewer { login } }'`,
  ])
    assert.deepEqual(mergeFlags(cmd), [], cmd);
});

test('mutation names count only in a gh api graphql call', () => {
  for (const cmd of [
    'grep -rn enqueuePullRequest src',
    'git commit -m "document enqueuePullRequest and mergePullRequest"',
    'pnpm test -- enablePullRequestAutoMerge',
    `gh issue comment 5 --body '${ENQUEUE}'`,
  ])
    assert.deepEqual(mergeFlags(cmd), [], cmd);
});

test('a name in some other field of a graphql call is not the query', () => {
  assert.deepEqual(
    mergeFlags(
      `gh api graphql -f query='{ viewer { login } }' -f note='enqueuePullRequest'`,
    ),
    [],
  );
});

test('graphql inside a shell wrapper is still read', () => {
  assert.deepEqual(
    mergeFlags(`bash -c "${gql(ENQUEUE).replace(/"/g, '\\"')}"`),
    ['queue'],
  );
});

test('flags from several forms in one line are reported once each', () => {
  assert.deepEqual(
    mergeFlags(`${M} 42 --auto && ${gql(ENQUEUE)} && ${gql(DIRECT)}`),
    ['auto', 'queue', 'api'],
  );
});
