// ════════════════════════════════════════════════════
//  EduGen — Cloudflare Worker  (бэкенд / прокси)
//  Деплой: https://workers.cloudflare.com
// ════════════════════════════════════════════════════
//
//  Переменные окружения (добавь в Cloudflare Dashboard → Worker → Settings → Variables):
//    GROQ_API_KEY   — твой ключ от Groq (https://console.groq.com)
//    FIREBASE_PROJECT_ID — например "edugen-12345"
//

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const ALLOWED_ORIGIN = '*'; // Потом замени на свой домен GitHub Pages, например: 'https://yourname.github.io'

export default {
  async fetch(request, env) {

    // ── CORS preflight ──────────────────────────────
    if (request.method === 'OPTIONS') {
      return corsResponse('', 204);
    }

    const url = new URL(request.url);

    // ── Healthcheck ─────────────────────────────────
    if (url.pathname === '/ping') {
      return corsResponse(JSON.stringify({ ok: true }), 200);
    }

    // ── Только POST /generate ───────────────────────
    if (url.pathname !== '/generate' || request.method !== 'POST') {
      return corsResponse(JSON.stringify({ error: 'Not found' }), 404);
    }

    // ── Проверяем Firebase ID Token ─────────────────
    const authHeader = request.headers.get('Authorization') || '';
    const idToken = authHeader.replace('Bearer ', '').trim();

    if (!idToken) {
      return corsResponse(JSON.stringify({ error: 'Unauthorized: нет токена' }), 401);
    }

    // Верифицируем токен через Firebase REST API (бесплатно, без SDK)
    const verifyRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${env.FIREBASE_WEB_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken })
      }
    );

    if (!verifyRes.ok) {
      return corsResponse(JSON.stringify({ error: 'Unauthorized: невалидный токен' }), 401);
    }

    const verifyData = await verifyRes.json();
    if (!verifyData.users || !verifyData.users[0]) {
      return corsResponse(JSON.stringify({ error: 'Unauthorized: пользователь не найден' }), 401);
    }

    const user = verifyData.users[0];

    // Проверяем что email подтверждён (если есть email)
    if (user.email && !user.emailVerified) {
      return corsResponse(JSON.stringify({ error: 'EmailNotVerified: подтвердите email' }), 403);
    }

    // ── Читаем тело запроса ─────────────────────────
    let body;
    try {
      body = await request.json();
    } catch {
      return corsResponse(JSON.stringify({ error: 'Bad request: невалидный JSON' }), 400);
    }

    // Базовая защита от дурака — не даём передать огромный промпт
    const bodyStr = JSON.stringify(body);
    if (bodyStr.length > 20000) {
      return corsResponse(JSON.stringify({ error: 'Payload too large' }), 413);
    }

    // ── Проксируем запрос к Groq ────────────────────
    const groqRes = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.GROQ_API_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: body.messages || [],
        temperature: body.temperature ?? 0.6,
        max_tokens: Math.min(body.max_tokens ?? 3000, 4000) // лимитируем максимум
      })
    });

    const groqData = await groqRes.json();

    if (!groqRes.ok) {
      return corsResponse(JSON.stringify({ error: groqData.error?.message || 'Groq error' }), 502);
    }

    return corsResponse(JSON.stringify(groqData), 200);
  }
};

// ── Хелпер: ответ с CORS заголовками ───────────────
function corsResponse(body, status) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    }
  });
}
