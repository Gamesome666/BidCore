// 版本对比：markdown 行级 LCS + JSON 路径级。审核页"与上一版比较"用。
export function lineDiff(before, after, limit = 800) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n && ops.length < limit) {
    if (a[i] === b[j]) { ops.push({ type: 'same', text: a[i] }); i += 1; j += 1; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: 'del', text: a[i] }); i += 1; }
    else { ops.push({ type: 'add', text: b[j] }); j += 1; }
  }
  while (i < m && ops.length < limit) { ops.push({ type: 'del', text: a[i] }); i += 1; }
  while (j < n && ops.length < limit) { ops.push({ type: 'add', text: b[j] }); j += 1; }
  return ops;
}

export function jsonDiff(before, after, path = '', out = [], limit = 200) {
  if (out.length >= limit) return out;
  if (JSON.stringify(before) === JSON.stringify(after)) return out;
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (isObj(before) && isObj(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) jsonDiff(before[key], after[key], path ? `${path}.${key}` : key, out, limit);
    return out;
  }
  if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
    before.forEach((v, idx) => jsonDiff(v, after[idx], `${path}[${idx}]`, out, limit));
    return out;
  }
  out.push({ type: 'change', path: path || '$', before: summarize(before), after: summarize(after) });
  return out;
}

function summarize(v) {
  if (v === null || v === undefined) return v ?? null;
  if (typeof v === 'string') return v.length > 160 ? `${v.slice(0, 160)}…` : v;
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 160);
  return v;
}

export function diffPayload(before, after) {
  if (typeof before === 'string' && typeof after === 'string') return { mode: 'lines', ops: lineDiff(before, after) };
  return { mode: 'json', ops: jsonDiff(before, after) };
}
