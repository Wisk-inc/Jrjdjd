/* GET /api/scam-radar-status: the newest Scam Radar status, as soon as it is published.

   The scanner force-pushes the scam-radar-data branch after every one-minute scan cycle. Files read
   by branch name on raw.githubusercontent.com can lag a push by several minutes, because where the
   branch points is cached there. Git itself has no such delay, so this reads the branch's commit from
   GitHub's git endpoint and returns that commit's status file with the commit id. The page then
   fetches the snapshot of that same commit: an address by commit never changes, so it is never stale.

   One answer is shared by every visitor for 10 seconds at Vercel's edge, so GitHub is asked at most
   about six times a minute per region. Without this function (another host) the page reads the branch
   by name instead, and updates show up a few minutes late. */

export const config = { runtime: 'edge' };

const REPO = 'Wisk-inc/Jrjdjd';
const TIMEOUT_MS = 8000;

const reply = (body, status, shareSeconds) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': shareSeconds ? 'public, max-age=0, must-revalidate' : 'no-store',
      // Vercel's edge follows this one; browsers ask again every time
      ...(shareSeconds ? { 'vercel-cdn-cache-control': `max-age=${shareSeconds}, stale-while-revalidate=30` } : {}),
    },
  });

const get = async (url, headers = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

export default async function handler(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return reply({ error: 'Only GET is supported' }, 405, 0);
  try {
    // The branch's commit, from the same list of refs a `git fetch` starts with
    const refs = await get(`https://github.com/${REPO}.git/info/refs?service=git-upload-pack`,
      { 'user-agent': 'git/2.45.0 (corx-labs scam-radar status)' });
    if (!refs.ok) throw new Error(`git answered ${refs.status}`);
    const match = (await refs.text()).match(/([0-9a-f]{40}) refs\/heads\/scam-radar-data(?![\w./-])/);
    if (!match) throw new Error('the data branch was not found');
    const commit = match[1];
    const file = await get(`https://raw.githubusercontent.com/${REPO}/${commit}/scam-radar-status.json`);
    if (!file.ok) throw new Error(`the status file answered ${file.status}`);
    const status = await file.json();
    if (!status || typeof status !== 'object' || !Date.parse(status.generated)) throw new Error('the status file is not valid');
    return reply({ ...status, commit }, 200, 10);
  } catch {
    return reply({ error: 'The scanner status could not be read just now' }, 502, 0);
  }
}
