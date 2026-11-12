import '../server/lib/env.mjs';

const base = process.env.LLM_BASE_URL.replace(/\/$/, '');
const headers = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${process.env.LLM_API_KEY}`,
  'x-opencode-session': process.env.LLM_SESSION_ID || 'bidcore',
};

async function call(body) {
  const res = await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

const jsonProbe = await call({
  model: process.env.LLM_MODEL,
  messages: [
    { role: 'system', content: '你是投标评审，只输出 JSON。' },
    { role: 'user', content: '给这段技术方案打 3 个维度分（0-100），JSON 形如 {"structure":80,"feasibility":75,"specific":70}。内容：本项目提供7×24值守，30分钟响应，2小时恢复。' },
  ],
  max_tokens: 1500,
  temperature: 0,
  response_format: { type: 'json_object' },
});
console.log('JSON status', jsonProbe.status);
console.log(jsonProbe.text.slice(0, 900));

const textProbe = await call({
  model: process.env.LLM_MODEL,
  messages: [
    { role: 'system', content: '你是中文技术标写作专家。' },
    { role: 'user', content: '写一段 120 字左右的技术标段落，主题：7×24 值守机制。不要标题，不要解释。' },
  ],
  max_tokens: 2000,
  temperature: 0.3,
});
console.log('\nTEXT status', textProbe.status);
const parsed = JSON.parse(textProbe.text);
const msg = parsed.choices?.[0]?.message || {};
console.log('content:', String(msg.content || '').slice(0, 400));
console.log('reasoning len:', String(msg.reasoning_content || '').length, 'finish:', parsed.choices?.[0]?.finish_reason);
