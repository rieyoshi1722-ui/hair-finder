// Hair Style Finder の中継役（Cloudflare Workers）
// 鍵（SERPER_KEY / BRAVE_KEY）はCloudflareの「シークレット」に入れる。このファイルには書かない。
// 必要な設定:
//   シークレット: SERPER_KEY（必須）, BRAVE_KEY（Braveに切りかえるときに追加）
//   KV のつなぎ先: CACHE（検索結果と使った回数をおぼえておく場所）

const ALLOWED_ORIGINS = ['https://rieyoshi1722-ui.github.io'];
const SERPER_FREE = 2500;        // Serperの無料回数
const BRAVE_MONTHLY = 1000;      // Braveの毎月の無料分（めやす）
const DAILY_LIMIT = 150;         // 1日に新しくさがせる回数の上限（使いすぎ防止）
const CACHE_DAYS = 30;           // 同じ条件の結果をおぼえておく日数
const COUNT = 20;                // 1回で取ってくる写真の枚数

function cors(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Vary': 'Origin',
  };
}

function json(body, origin, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(origin) },
  });
}

async function getNum(env, key) {
  return Number((await env.CACHE.get(key)) || 0);
}

async function serper(env, q) {
  const r = await fetch('https://google.serper.dev/images', {
    method: 'POST',
    headers: { 'X-API-KEY': env.SERPER_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ q, gl: 'jp', hl: 'ja', num: COUNT }),
  });
  if (r.status === 400 || r.status === 401 || r.status === 403) return { exhausted: true };
  if (!r.ok) throw new Error('serper ' + r.status);
  const d = await r.json();
  return {
    credits: d.credits || 1,
    images: (d.images || []).map((x) => ({
      thumb: x.thumbnailUrl, full: x.imageUrl, page: x.link, title: x.title, site: x.domain || x.source,
    })),
  };
}

async function brave(env, q) {
  const u = 'https://api.search.brave.com/res/v1/images/search?count=' + COUNT +
    '&country=JP&search_lang=ja&safesearch=strict&q=' + encodeURIComponent(q);
  const r = await fetch(u, { headers: { 'X-Subscription-Token': env.BRAVE_KEY, 'Accept': 'application/json' } });
  if (r.status === 401 || r.status === 402 || r.status === 429) return { exhausted: true };
  if (!r.ok) throw new Error('brave ' + r.status);
  const d = await r.json();
  return {
    credits: 1,
    images: (d.results || []).map((x) => ({
      thumb: x.thumbnail && x.thumbnail.src, full: x.properties && x.properties.url,
      page: x.url, title: x.title, site: x.source,
    })),
  };
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });

    const url = new URL(req.url);
    const q = (url.searchParams.get('q') || '').trim().slice(0, 120);
    const month = new Date().toISOString().slice(0, 7);
    const today = new Date().toISOString().slice(0, 10);

    const status = async () => {
      const serperUsed = await getNum(env, 'used:serper');
      const serperOut = (await env.CACHE.get('out:serper')) === '1';
      const serperLeft = serperOut ? 0 : Math.max(0, SERPER_FREE - serperUsed);
      if (serperLeft > 0) return { provider: 'serper', left: serperLeft };
      if (env.BRAVE_KEY) {
        const braveUsed = await getNum(env, 'used:brave:' + month);
        const braveOut = (await env.CACHE.get('out:brave:' + month)) === '1';
        return { provider: 'brave', left: braveOut ? 0 : Math.max(0, BRAVE_MONTHLY - braveUsed) };
      }
      return { provider: 'none', left: 0 };
    };

    if (!q) return json({ ok: true, ...(await status()) }, origin);

    const ck = 'q:' + q;
    const hit = await env.CACHE.get(ck, 'json');
    if (hit) return json({ ok: true, cached: true, images: hit, ...(await status()) }, origin);

    const dayKey = 'day:' + today;
    const dayUsed = await getNum(env, dayKey);
    if (dayUsed >= DAILY_LIMIT) return json({ ok: false, reason: 'daily', ...(await status()) }, origin);

    let st = await status();
    let res = null;
    if (st.provider === 'serper') {
      res = await serper(env, q);
      if (res.exhausted) {
        await env.CACHE.put('out:serper', '1');
        st = await status();
        res = null;
      } else {
        await env.CACHE.put('used:serper', String((await getNum(env, 'used:serper')) + res.credits));
      }
    }
    if (!res && st.provider === 'brave' && st.left > 0) {
      res = await brave(env, q);
      if (res.exhausted) {
        await env.CACHE.put('out:brave:' + month, '1', { expirationTtl: 60 * 60 * 24 * 40 });
        res = null;
      } else {
        const k = 'used:brave:' + month;
        await env.CACHE.put(k, String((await getNum(env, k)) + res.credits), { expirationTtl: 60 * 60 * 24 * 40 });
      }
    }
    if (!res) return json({ ok: false, reason: 'exhausted', ...(await status()) }, origin);

    const images = res.images.filter((x) => x.thumb && x.page);
    await env.CACHE.put(ck, JSON.stringify(images), { expirationTtl: 60 * 60 * 24 * CACHE_DAYS });
    await env.CACHE.put(dayKey, String(dayUsed + 1), { expirationTtl: 60 * 60 * 48 });
    return json({ ok: true, cached: false, images, ...(await status()) }, origin);
  },
};
