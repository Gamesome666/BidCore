// 后台循环：SLA 扫描 / 引擎调度 tick / 租约自愈。由 index.mjs 在监听后启动。
import { all } from '../db.mjs';
import { engine } from '../domain/engine.mjs';
import { scanSla } from '../domain/review.mjs';

export function startBackgroundLoops() {
  setInterval(() => { try { scanSla(); } catch { /* ignore */ } }, 30_000);
  const tickAll = setInterval(() => {
    try {
      const rows = all("SELECT id FROM runs WHERE status IN ('running','replanning')");
      for (const row of rows) engine.tick(row.id);
    } catch { /* ignore */ }
  }, 1500);
  tickAll.unref?.();
  // 租约自愈：进程被杀后重启，最长 5 秒内把卡住的节点重新入队
  const reclaim = setInterval(() => { try { engine.reclaimExpired(); } catch { /* ignore */ } }, 5000);
  reclaim.unref?.();
}
