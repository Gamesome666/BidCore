// SSE 事件总线：按 projectId 隔离的内存发布订阅（单实例演示）。
// 多实例部署时替换为 Redis pub/sub（设计文档 §10.3）。
const channels = new Map();

export function subscribe(projectId, res) {
  const key = String(projectId ?? '0');
  if (!channels.has(key)) channels.set(key, new Set());
  channels.get(key).add(res);
  return () => {
    const set = channels.get(key);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) channels.delete(key);
  };
}

export function publish(projectId, channel, data) {
  const set = channels.get(String(projectId ?? '0'));
  if (!set || set.size === 0) return;
  const frame = `event: ${channel}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of [...set]) {
    try { res.write(frame); } catch { set.delete(res); }
  }
}

export function subscriberCount(projectId) {
  return channels.get(String(projectId ?? '0'))?.size ?? 0;
}
